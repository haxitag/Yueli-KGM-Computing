import { timingSafeEqual } from "node:crypto";
import { kgmErrorBody } from "../utils/kgmHttpErrors.js";
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
 * 从环境变量构建访问策略（无密钥且无限流时，行为与历史版本一致）。
 * - KGM_HTTP_API_KEY：设为非空则启用服务端校验
 * - KGM_HTTP_AUTH_EXEMPT：逗号分隔路径前缀，默认 `/health`
 * - KGM_HTTP_RATE_LIMIT_MAX：滑动窗口内最大请求数；0 或不设表示关闭
 * - KGM_HTTP_RATE_LIMIT_WINDOW_MS：窗口长度，默认 60000
 */
export function createHttpAccessConfigFromEnv() {
    const key = (process.env.KGM_HTTP_API_KEY ?? "").trim();
    const max = Number.parseInt(process.env.KGM_HTTP_RATE_LIMIT_MAX ?? "0", 10);
    const windowMs = Number.parseInt(process.env.KGM_HTTP_RATE_LIMIT_WINDOW_MS ?? "60000", 10);
    return {
        apiKey: key.length > 0 ? key : null,
        exemptPathPrefixes: parseCsvPrefixes(process.env.KGM_HTTP_AUTH_EXEMPT, "/health"),
        rateLimit: max > 0 && windowMs > 0
            ? { max, windowMs }
            : null,
    };
}
function isExemptPath(pathname, exempts) {
    return exempts.some((prefix) => prefix === "/" || pathname === prefix || pathname.startsWith(prefix));
}
function getClientKey(req) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.trim()) {
        return `ip:${xf.split(",")[0].trim()}`;
    }
    return `ip:${req.socket.remoteAddress ?? "unknown"}`;
}
function readRequestApiKey(req) {
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
    constructor(params) {
        this.max = params.max;
        this.windowMs = params.windowMs;
    }
    allow(key, now = Date.now()) {
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
}
export class HttpRequestAccess {
    config;
    limiter;
    constructor(config, existingLimiter) {
        this.config = config;
        if (config.rateLimit) {
            this.limiter =
                existingLimiter ??
                    new InMemorySlidingWindowRateLimiter({
                        max: config.rateLimit.max,
                        windowMs: config.rateLimit.windowMs,
                    });
        }
        else {
            this.limiter = null;
        }
    }
    /**
     * @returns true 表示可继续处理；已写入响应时返回 false
     */
    check(req, res, pathname) {
        if (isExemptPath(pathname, this.config.exemptPathPrefixes)) {
            return true;
        }
        if (this.limiter) {
            const k = getClientKey(req);
            const { ok, retryAfterSec } = this.limiter.allow(k);
            if (!ok) {
                const body = kgmErrorBody("rate_limited", "Too many requests", 429);
                res.setHeader("retry-after", String(retryAfterSec ?? 60));
                res.setHeader("x-kgm-error", body.error.code);
                this.writeJson(res, 429, body);
                return false;
            }
        }
        if (this.config.apiKey) {
            const got = readRequestApiKey(req);
            if (!got || !timingSafeEqualString(got, this.config.apiKey)) {
                const body = kgmErrorBody("unauthorized", "Valid API key or Bearer token required", 401);
                res.setHeader("x-kgm-error", body.error.code);
                this.writeJson(res, 401, body);
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
