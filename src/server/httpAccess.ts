import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { kgmErrorBody } from "../utils/kgmHttpErrors.js";
import { logger } from "../observability/logger.js";

export type HttpSecurityMode = "strict" | "permissive";

export type HttpAccessConfig = {
  securityMode: HttpSecurityMode;
  /** 若设置，则非豁免路径需携带与之一致的 Bearer 或 X-API-Key */
  apiKey: string | null;
  /** 路径前缀列表；匹配则跳过鉴权与限流（如 /health） */
  exemptPathPrefixes: string[];
  rateLimit: null | { max: number; windowMs: number };
  /** 是否信任 X-Forwarded-For（仅在可信反向代理后开启） */
  trustProxy: boolean;
};

function parseCsvPrefixes(raw: string | undefined, fallback: string): string[] {
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
export function resolveHttpSecurityMode(
  env: NodeJS.ProcessEnv = process.env,
): HttpSecurityMode {
  const raw = (env.KGM_HTTP_SECURITY_MODE ?? "").trim().toLowerCase();
  if (raw === "strict" || raw === "production") return "strict";
  if (raw === "permissive" || raw === "dev" || raw === "development") return "permissive";
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") return "strict";
  return "permissive";
}

/**
 * 从环境变量构建访问策略。
 * - KGM_HTTP_API_KEY：非空则启用校验；strict 模式强制要求
 * - KGM_HTTP_AUTH_EXEMPT：逗号分隔路径前缀，默认 `/health,/metrics,/openapi.json`
 * - KGM_HTTP_RATE_LIMIT_MAX：滑动窗口上限；未设置时 strict 默认 120，permissive 默认关闭(0)；显式 `0` 关闭
 * - KGM_HTTP_RATE_LIMIT_WINDOW_MS：窗口长度，默认 60000
 * - KGM_HTTP_TRUST_PROXY：`1/true` 时使用 X-Forwarded-For 首跳作为限流键
 */
export function createHttpAccessConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpAccessConfig {
  const securityMode = resolveHttpSecurityMode(env);
  const key = (env.KGM_HTTP_API_KEY ?? "").trim();
  const windowMs = Number.parseInt(env.KGM_HTTP_RATE_LIMIT_WINDOW_MS ?? "60000", 10);
  const maxRaw = env.KGM_HTTP_RATE_LIMIT_MAX;
  let max: number;
  if (maxRaw === undefined || String(maxRaw).trim() === "") {
    max = securityMode === "strict" ? 120 : 0;
  } else {
    max = Number.parseInt(String(maxRaw).trim(), 10);
  }
  const trustProxy = ["1", "true", "yes", "on"].includes(
    (env.KGM_HTTP_TRUST_PROXY ?? "").trim().toLowerCase(),
  );

  return {
    securityMode,
    apiKey: key.length > 0 ? key : null,
    exemptPathPrefixes: parseCsvPrefixes(
      env.KGM_HTTP_AUTH_EXEMPT,
      "/health,/ready,/metrics,/openapi.json",
    ),
    rateLimit: max > 0 && windowMs > 0 ? { max, windowMs } : null,
    trustProxy,
  };
}

/** strict 且无 API Key 时抛错，避免生产裸奔 */
export function assertHttpAccessConfig(config: HttpAccessConfig): void {
  if (config.securityMode === "strict" && !config.apiKey) {
    throw new Error(
      "KGM_HTTP_SECURITY_MODE=strict (or NODE_ENV=production) requires KGM_HTTP_API_KEY. " +
        "Set a key, or explicitly use KGM_HTTP_SECURITY_MODE=permissive for local demos.",
    );
  }
  if (config.securityMode === "permissive" && !config.apiKey) {
    logger.warn(
      "HTTP API key is disabled (permissive mode). Do not expose this process to untrusted networks.",
    );
  }
}

function isExemptPath(pathname: string, exempts: string[]): boolean {
  return exempts.some(
    (prefix) => prefix === "/" || pathname === prefix || pathname.startsWith(prefix),
  );
}

function getClientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.trim()) {
      return `ip:${xf.split(",")[0]!.trim()}`;
    }
  }
  return `ip:${req.socket.remoteAddress ?? "unknown"}`;
}

function readRequestApiKey(req: IncomingMessage): string | undefined {
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

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

type SlidingState = { timestamps: number[] };

export class InMemorySlidingWindowRateLimiter {
  private state = new Map<string, SlidingState>();
  private windowMs: number;
  private max: number;
  private opsSinceSweep = 0;

  constructor(params: { max: number; windowMs: number }) {
    this.max = params.max;
    this.windowMs = params.windowMs;
  }

  allow(key: string, now: number = Date.now()): { ok: boolean; retryAfterSec?: number } {
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

  /** 清理窗口外空桶，避免长跑 Map 膨胀 */
  sweep(now: number = Date.now()): number {
    const cutoff = now - this.windowMs;
    let removed = 0;
    for (const [key, entry] of this.state) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.state.delete(key);
        removed += 1;
      } else {
        this.state.set(key, entry);
      }
    }
    return removed;
  }

  get size(): number {
    return this.state.size;
  }
}

export class HttpRequestAccess {
  private config: HttpAccessConfig;
  private limiter: InMemorySlidingWindowRateLimiter | null;

  constructor(config: HttpAccessConfig, existingLimiter?: InMemorySlidingWindowRateLimiter) {
    this.config = config;
    if (config.rateLimit) {
      this.limiter =
        existingLimiter ??
        new InMemorySlidingWindowRateLimiter({
          max: config.rateLimit.max,
          windowMs: config.rateLimit.windowMs,
        });
    } else {
      this.limiter = null;
    }
  }

  /**
   * @returns true 表示可继续处理；已写入响应时返回 false
   */
  check(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (isExemptPath(pathname, this.config.exemptPathPrefixes)) {
      return true;
    }

    // 鉴权优先于限流：避免未鉴权流量占满匿名桶；凭据通过后按身份限流更可运维
    if (this.config.apiKey) {
      const got = readRequestApiKey(req);
      if (!got || !timingSafeEqualString(got, this.config.apiKey)) {
        const body = kgmErrorBody("unauthorized", "Valid API key or Bearer token required", 401);
        res.setHeader("x-kgm-error", body.error.code);
        this.writeJson(res, 401, body);
        return false;
      }
    }

    if (this.limiter) {
      const identity = this.config.apiKey
        ? `key:${this.config.apiKey.slice(0, 8)}`
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

  private writeJson(res: ServerResponse, status: number, body: ReturnType<typeof kgmErrorBody>): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
