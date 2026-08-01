/**
 * 统一 CORS 策略（HTTP 原生 + Express Playground）。
 * - 生产 / strict：禁止 *，仅白名单 Origin；非白名单不回显任意源
 * - 开发默认：允许本机常见 Origin（localhost / 127.0.0.1）
 */
import type { CorsOptions } from "cors";

export type CorsPolicy = {
  origins: string[];
  allowAll: boolean;
  methods: string;
  headers: string;
  maxAge: string;
  allowCredentials: boolean;
};

function isProductionLike(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.KGM_HTTP_SECURITY_MODE ?? "").trim().toLowerCase();
  if (mode === "strict" || mode === "production") return true;
  if (mode === "permissive" || mode === "dev" || mode === "development") return false;
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

const DEV_DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function resolveCorsPolicy(env: NodeJS.ProcessEnv = process.env): CorsPolicy {
  const raw = (env.KGM_CORS_ORIGINS ?? "").trim();
  const methods = env.KGM_CORS_METHODS || "GET,POST,PUT,DELETE,OPTIONS,PATCH";
  const headers =
    env.KGM_CORS_HEADERS || "Content-Type,Authorization,X-API-Key,X-KGM-Error,X-KGM-Output-Normalize";
  const maxAge = env.KGM_CORS_MAX_AGE || "86400";

  if (!raw) {
    if (isProductionLike(env)) {
      return {
        origins: [],
        allowAll: false,
        methods,
        headers,
        maxAge,
        allowCredentials: false,
      };
    }
    return {
      origins: [...DEV_DEFAULT_ORIGINS],
      allowAll: false,
      methods,
      headers,
      maxAge,
      allowCredentials: true,
    };
  }

  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAll = origins.includes("*");
  return {
    origins: allowAll ? ["*"] : origins,
    allowAll,
    methods,
    headers,
    maxAge,
    allowCredentials: !allowAll && origins.length > 0,
  };
}

export function isOriginAllowed(origin: string | undefined, policy: CorsPolicy): boolean {
  if (!origin) return true;
  if (policy.allowAll) return true;
  return policy.origins.includes(origin);
}

/** Express `cors` 中间件选项：拒绝非白名单（不回退到 origins[0]） */
export function createExpressCorsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const policy = resolveCorsPolicy(env);
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (isOriginAllowed(origin, policy)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: policy.methods.split(",").map((m) => m.trim()),
    allowedHeaders: policy.headers.split(",").map((h) => h.trim()),
    maxAge: Number.parseInt(policy.maxAge, 10) || 86400,
    credentials: policy.allowCredentials,
  };
}
