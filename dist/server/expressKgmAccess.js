import { createHttpAccessConfigFromEnv, HttpRequestAccess } from "./httpAccess.js";
const access = new HttpRequestAccess(createHttpAccessConfigFromEnv());
/**
 * 与 `createKgmServer` 相同的 KGM HTTP 访问控制（鉴权/限流），用于 Express 组合服。
 * 对静态资源、根路径下非 API 资源不强制校验，仅对 `/v1` `/api` `/health` `/metrics` `/openapi.json` 等生效。
 */
export function createExpressKgmAccessMiddleware() {
    return (req, res, next) => {
        const raw = req.originalUrl || req.url || "/";
        const pathOnly = raw.split("?")[0] || "/";
        if (pathOnly.startsWith("/v1/") || pathOnly.startsWith("/api/")) {
            if (access.check(req, res, pathOnly)) {
                return next();
            }
            return;
        }
        if (pathOnly === "/health" ||
            pathOnly === "/metrics" ||
            pathOnly === "/openapi.json" ||
            pathOnly === "/v1/openapi.json") {
            if (access.check(req, res, pathOnly)) {
                return next();
            }
            return;
        }
        return next();
    };
}
