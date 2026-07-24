import { timingSafeEqual } from "node:crypto";
import { kgmErrorBody } from "../utils/kgmHttpErrors.js";
import { logger } from "../observability/logger.js";
function parseCsvPrefixes(raw, fallback) {
    const s = (raw ?? fallback)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    if (s.length === 0) {
        return ["/health"];
    }
    return s;
}
/**
 * - `KGM_HTTP_SECURITY_MODE=strict|permissive`
 * - 未设置时：`NODE_ENV=production` → strict，否则 permissive
 */
export function resolveHttpSecurityMode(env = process.env) {
    const raw = (env.KGM_HTTP_SECURITY_MODE ?? "").trim().toLowerCase();
    if (raw === "strict" || raw === "production")
        return "strict";
    if (raw === "permissive" || raw === "dev" || raw === "development")
        return "permissive";
    if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production")
        return "strict";
    return "permissive";
}
/**
 * 从环境变量构建访问策略。
 * - KGM_HTTP_API_KEY：管理钥（master）；非空则启用校验；strict 模式强制要求
 * - 调用钥：服务端签发的 `kgm_…` 虚拟 Key（见 /v1/kgm/keys）
 * - KGM_HTTP_AUTH_EXEMPT：逗号分隔路径前缀，默认 `/health,/metrics,/openapi.json`
 */
export function createHttpAccessConfigFromEnv(env = process.env) {
    const securityMode = resolveHttpSecurityMode(env);
    const key = (env.KGM_HTTP_API_KEY ?? "").trim();
    const windowMs = Number.parseInt(env.KGM_HTTP_RATE_LIMIT_WINDOW_MS ?? "60000", 10);
    const maxRaw = env.KGM_HTTP_RATE_LIMIT_MAX;
    let max;
    if (maxRaw === undefined || String(maxRaw).trim() === "") {
        max = securityMode === "strict" ? 120 : 0;
    }
    else {
        max = Number.parseInt(String(maxRaw).trim(), 10);
    }
    const trustProxy = ["1", "true", "yes", "on"].includes((env.KGM_HTTP_TRUST_PROXY ?? "").trim().toLowerCase());
    return {
        securityMode,
        apiKey: key.length > 0 ? key : null,
        exemptPathPrefixes: parseCsvPrefixes(env.KGM_HTTP_AUTH_EXEMPT, "/health,/ready,/metrics,/openapi.json"),
        rateLimit: max > 0 && windowMs > 0 ? { max, windowMs } : null,
        trustProxy,
    };
}
/** strict 且无 API Key 时抛错，避免生产裸奔 */
export function assertHttpAccessConfig(config) {
    if (config.securityMode === "strict" && !config.apiKey) {
        throw new Error("KGM_HTTP_SECURITY_MODE=strict (or NODE_ENV=production) requires KGM_HTTP_API_KEY. " +
            "Set a key, or explicitly use KGM_HTTP_SECURITY_MODE=permissive for local demos.");
    }
    if (config.securityMode === "permissive" && !config.apiKey) {
        logger.warn("HTTP API key is disabled (permissive mode). Do not expose this process to untrusted networks.");
    }
}
function isExemptPath(pathname, exempts) {
    return exempts.some((prefix) => prefix === "/" || pathname === prefix || pathname.startsWith(prefix));
}
function getClientKey(req, trustProxy) {
    if (trustProxy) {
        const xf = req.headers["x-forwarded-for"];
        if (typeof xf === "string" && xf.trim()) {
            return `ip:${xf.split(",")[0].trim()}`;
        }
    }
    return `ip:${req.socket.remoteAddress ?? "unknown"}`;
}
export function readRequestApiKey(req) {
    const x = req.headers["x-api-key"];
    if (typeof x === "string" && x) {
        return x.trim();
    }
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
        return auth.slice(7).trim();
    }
    return undefined;
}
function timingSafeEqualString(a, b) {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) {
        return false;
    }
    return timingSafeEqual(ab, bb);
}
export class InMemorySlidingWindowRateLimiter {
    state = new Map();
    windowMs;
    max;
    opsSinceSweep = 0;
    constructor(params) {
        this.max = params.max;
        this.windowMs = params.windowMs;
    }
    allow(key, now = Date.now()) {
        this.opsSinceSweep += 1;
        if (this.opsSinceSweep >= 64) {
            this.opsSinceSweep = 0;
            this.sweep(now);
        }
        const cutoff = now - this.windowMs;
        const entry = this.state.get(key) ?? { timestamps: [] };
        entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
        if (entry.timestamps.length >= this.max) {
            const oldest = entry.timestamps[0] ?? now;
            const retryAfterSec = Math.ceil((oldest + this.windowMs - now) / 1000);
            this.state.set(key, entry);
            return { ok: false, retryAfterSec: Math.max(1, retryAfterSec) };
        }
        entry.timestamps.push(now);
        this.state.set(key, entry);
        return { ok: true };
    }
    sweep(now = Date.now()) {
        const cutoff = now - this.windowMs;
        let removed = 0;
        for (const [key, entry] of this.state) {
            entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
            if (entry.timestamps.length === 0) {
                this.state.delete(key);
                removed += 1;
            }
            else {
                this.state.set(key, entry);
            }
        }
        return removed;
    }
    get size() {
        return this.state.size;
    }
}
const INFERENCE_BUDGET_PREFIXES = [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/responses",
    "/v1/messages",
    "/v1/embeddings",
];
export class HttpRequestAccess {
    config;
    limiter;
    resolveVirtualKey;
    checkBudget;
    lastAuth = { kind: "anonymous", keyId: "anonymous" };
    constructor(config, options) {
        this.config = config;
        this.resolveVirtualKey = options?.resolveVirtualKey;
        this.checkBudget = options?.checkBudget;
        if (config.rateLimit) {
            this.limiter =
                options?.existingLimiter ??
                    new InMemorySlidingWindowRateLimiter({
                        max: config.rateLimit.max,
                        windowMs: config.rateLimit.windowMs,
                    });
        }
        else {
            this.limiter = null;
        }
    }
    getLastAuth() {
        return this.lastAuth;
    }
    /** Sync check — prefers master; for virtual keys use checkAsync */
    check(req, res, pathname) {
        const got = readRequestApiKey(req);
        if (got && this.config.apiKey && timingSafeEqualString(got, this.config.apiKey)) {
            this.lastAuth = { kind: "master", keyId: "master", keyName: "master", rawKeyPrefix: got.slice(0, 8) };
        }
        else if (!got) {
            this.lastAuth = { kind: "anonymous", keyId: "anonymous" };
        }
        else if (got.startsWith("kgm_") && !this.resolveVirtualKey) {
            // virtual key present but resolver not wired yet — reject if master required
            this.lastAuth = { kind: "anonymous", keyId: "anonymous", rawKeyPrefix: got.slice(0, 8) };
        }
        else if (!got.startsWith("kgm_")) {
            this.lastAuth = { kind: "anonymous", keyId: "anonymous", rawKeyPrefix: got.slice(0, 8) };
        }
        return this.finishCheck(req, res, pathname, this.lastAuth, got);
    }
    async checkAsync(req, res, pathname) {
        const got = readRequestApiKey(req);
        let auth = { kind: "anonymous", keyId: "anonymous" };
        if (got && this.config.apiKey && timingSafeEqualString(got, this.config.apiKey)) {
            auth = { kind: "master", keyId: "master", keyName: "master", rawKeyPrefix: got.slice(0, 8) };
        }
        else if (got && this.resolveVirtualKey) {
            const vk = await this.resolveVirtualKey(got);
            if (vk) {
                auth = {
                    kind: "virtual",
                    keyId: vk.id,
                    keyName: vk.name,
                    virtualKey: vk,
                    rawKeyPrefix: got.slice(0, 8),
                };
            }
            else {
                auth = { kind: "anonymous", keyId: "anonymous", rawKeyPrefix: got.slice(0, 8) };
            }
        }
        else if (!got) {
            auth = { kind: "anonymous", keyId: "anonymous" };
        }
        else {
            auth = { kind: "anonymous", keyId: "anonymous", rawKeyPrefix: got.slice(0, 8) };
        }
        this.lastAuth = auth;
        if (!this.finishCheck(req, res, pathname, auth, got)) {
            return false;
        }
        if (this.checkBudget && (auth.kind === "virtual" || auth.kind === "master")) {
            if (INFERENCE_BUDGET_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
                const result = await this.checkBudget(auth.keyId, pathname);
                if (!result.ok) {
                    const status = result.status ?? 402;
                    const body = kgmErrorBody("budget_exceeded", result.message, status);
                    res.setHeader("x-kgm-error", body.error.code);
                    this.writeJson(res, status, body);
                    return false;
                }
            }
        }
        return true;
    }
    finishCheck(req, res, pathname, auth, got) {
        if (isExemptPath(pathname, this.config.exemptPathPrefixes)) {
            return true;
        }
        if (this.config.apiKey) {
            if (!got || auth.kind === "anonymous") {
                const body = kgmErrorBody("unauthorized", "Valid master or virtual API key required", 401);
                res.setHeader("x-kgm-error", body.error.code);
                this.writeJson(res, 401, body);
                return false;
            }
        }
        if (this.limiter) {
            const identity = auth.kind === "master"
                ? "key:master"
                : auth.kind === "virtual"
                    ? `key:${auth.keyId}`
                    : getClientKey(req, this.config.trustProxy);
            const { ok, retryAfterSec } = this.limiter.allow(identity);
            if (!ok) {
                const body = kgmErrorBody("rate_limited", "Too many requests", 429);
                res.setHeader("retry-after", String(retryAfterSec ?? 60));
                res.setHeader("x-kgm-error", body.error.code);
                this.writeJson(res, 429, body);
                return false;
            }
        }
        return true;
    }
    writeJson(res, status, body) {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
    }
}
