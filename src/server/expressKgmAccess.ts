import type { Request, Response, NextFunction } from "express";
import {
  assertHttpAccessConfig,
  createHttpAccessConfigFromEnv,
  HttpRequestAccess,
} from "./httpAccess.js";
import { getOpsStore } from "../admin/opsStore.js";
import { runWithOpsAuthAsync } from "../admin/opsAuthContext.js";

const accessConfig = createHttpAccessConfigFromEnv();
assertHttpAccessConfig(accessConfig);
const access = new HttpRequestAccess(accessConfig, {
  resolveVirtualKey: async (raw) => {
    try {
      const store = await getOpsStore();
      return store.findVirtualKeyByRaw(raw);
    } catch {
      return undefined;
    }
  },
  checkBudget: async (keyId) => {
    try {
      const store = await getOpsStore();
      const result = store.assertBudgetAllows(keyId);
      if (!result.ok) {
        return {
          ok: false as const,
          status: 402,
          message: `Budget exceeded (${result.status.budget.name}): spent $${result.status.spentUsd.toFixed(4)} / $${result.status.budget.limitUsd.toFixed(4)}`,
        };
      }
      return { ok: true as const };
    } catch {
      return { ok: true as const };
    }
  },
});

/**
 * 与 `createKgmServer` 相同的 KGM HTTP 访问控制（鉴权/限流），用于 Express 组合服。
 * 对静态资源、根路径下非 API 资源不强制校验，仅对 `/v1` `/api` `/health` `/metrics` `/openapi.json` 等生效。
 */
export function createExpressKgmAccessMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const raw = req.originalUrl || req.url || "/";
      const pathOnly = raw.split("?")[0] || "/";
      const needsCheck =
        pathOnly.startsWith("/v1/") ||
        pathOnly.startsWith("/api/") ||
        pathOnly === "/health" ||
        pathOnly === "/metrics" ||
        pathOnly === "/openapi.json" ||
        pathOnly === "/v1/openapi.json";
      if (!needsCheck) {
        return next();
      }
      if (!(await access.checkAsync(req, res, pathOnly))) {
        return;
      }
      await runWithOpsAuthAsync(access.getLastAuth(), async () => {
        next();
      });
    })().catch(next);
  };
}
