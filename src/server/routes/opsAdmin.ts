import type { ServerResponse } from "node:http";
import { getOpsAuth } from "../../admin/opsAuthContext.js";
import { getOpsStore, type BudgetPeriod, type BudgetRecord, type BudgetStatus, type VirtualKeyRecord, type ModelAliasRecord } from "../../admin/opsStore.js";
import { kgmErrorBody } from "../../utils/kgmHttpErrors.js";

export type OpsAdminRouteParams = {
  method: string;
  pathname: string;
  body?: unknown;
  res: ServerResponse;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  /** true if caller authenticated as master key */
  isMaster: boolean;
};

/**
 * Ops admin routes: keys / usage / budgets / aliases.
 * Management mutations require master key.
 */
export async function handleOpsAdminRoute(params: OpsAdminRouteParams): Promise<boolean> {
  const { method, pathname } = params;
  if (!pathname.startsWith("/v1/kgm/keys") &&
      !pathname.startsWith("/v1/kgm/usage") &&
      !pathname.startsWith("/v1/kgm/budgets") &&
      !pathname.startsWith("/v1/kgm/aliases") &&
      pathname !== "/v1/kgm/ops/overview") {
    return false;
  }

  const store = await getOpsStore();

  if (method === "GET" && pathname === "/v1/kgm/ops/overview") {
    const summary = store.summarizeUsage({ since: new Date(Date.now() - 7 * 86400000).toISOString() });
    return send(params, 200, {
      keys: store.listVirtualKeys().filter((k: VirtualKeyRecord) => k.enabled).length,
      budgets: store.listBudgets().filter((b: BudgetRecord) => b.enabled).length,
      aliases: store.listAliases().filter((a: ModelAliasRecord) => a.enabled).length,
      usage7d: summary,
      auth: getOpsAuth(),
    });
  }

  // ---- Keys ----
  if (method === "GET" && pathname === "/v1/kgm/keys") {
    if (!params.isMaster) return forbid(params);
    return send(params, 200, { items: store.listVirtualKeys() });
  }
  if (method === "POST" && pathname === "/v1/kgm/keys") {
    if (!params.isMaster) return forbid(params);
    const body = (params.body ?? {}) as { name?: string; allowedModels?: string[]; expiresAt?: string; notes?: string };
    if (!body.name?.trim()) {
      return send(params, 400, kgmErrorBody("invalid_request", "name is required", 400));
    }
    const created = store.createVirtualKey({
      name: body.name,
      allowedModels: body.allowedModels,
      expiresAt: body.expiresAt,
      notes: body.notes,
    });
    return send(params, 201, {
      key: {
        id: created.id,
        name: created.name,
        keySuffix: created.keySuffix,
        allowedModels: created.allowedModels,
        enabled: created.enabled,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        notes: created.notes,
      },
      apiKey: created.apiKey,
      warning: "apiKey is shown once; store it securely",
    });
  }
  if (method === "POST" && pathname.startsWith("/v1/kgm/keys/") && pathname.endsWith("/revoke")) {
    if (!params.isMaster) return forbid(params);
    const id = pathname.slice("/v1/kgm/keys/".length, -"/revoke".length);
    const ok = store.revokeVirtualKey(id);
    if (!ok) return send(params, 404, kgmErrorBody("not_found", "key not found", 404));
    return send(params, 200, { revoked: true, id });
  }
  if (method === "DELETE" && pathname.startsWith("/v1/kgm/keys/")) {
    if (!params.isMaster) return forbid(params);
    const id = pathname.slice("/v1/kgm/keys/".length);
    const ok = store.deleteVirtualKey(id);
    if (!ok) return send(params, 404, kgmErrorBody("not_found", "key not found", 404));
    return send(params, 200, { deleted: true, id });
  }

  // ---- Usage ----
  if (method === "GET" && pathname === "/v1/kgm/usage") {
    if (!params.isMaster) return forbid(params);
    const q = (params.body as { __query?: Record<string, string> } | undefined)?.__query ?? {};
    const items = store.listUsage({
      limit: q.limit ? Number(q.limit) : 100,
      keyId: q.keyId,
      model: q.model,
      since: q.since,
    });
    return send(params, 200, { items });
  }
  if (method === "GET" && pathname === "/v1/kgm/usage/summary") {
    if (!params.isMaster) return forbid(params);
    const q = (params.body as { __query?: Record<string, string> } | undefined)?.__query ?? {};
    return send(params, 200, store.summarizeUsage({ since: q.since, keyId: q.keyId }));
  }

  // ---- Budgets ----
  if (method === "GET" && pathname === "/v1/kgm/budgets") {
    if (!params.isMaster) return forbid(params);
    const items = store.listBudgets().map((b: BudgetRecord) => {
      const statuses = store.getBudgetStatuses(b.keyId).filter((s: BudgetStatus) => s.budget.id === b.id);
      return { ...b, status: statuses[0] };
    });
    return send(params, 200, { items });
  }
  if (method === "POST" && pathname === "/v1/kgm/budgets") {
    if (!params.isMaster) return forbid(params);
    const body = (params.body ?? {}) as {
      id?: string;
      keyId?: string;
      name?: string;
      period?: BudgetPeriod;
      limitUsd?: number;
      mode?: "hard" | "soft";
      enabled?: boolean;
    };
    if (!body.keyId || !body.name || body.limitUsd === undefined || !body.period) {
      return send(params, 400, kgmErrorBody("invalid_request", "keyId, name, period, limitUsd required", 400));
    }
    const record = store.upsertBudget({
      id: body.id,
      keyId: body.keyId,
      name: body.name,
      period: body.period,
      limitUsd: body.limitUsd,
      mode: body.mode,
      enabled: body.enabled,
    });
    return send(params, 200, { budget: record });
  }
  if (method === "DELETE" && pathname.startsWith("/v1/kgm/budgets/")) {
    if (!params.isMaster) return forbid(params);
    const id = pathname.slice("/v1/kgm/budgets/".length);
    const ok = store.deleteBudget(id);
    if (!ok) return send(params, 404, kgmErrorBody("not_found", "budget not found", 404));
    return send(params, 200, { deleted: true, id });
  }

  // ---- Aliases ----
  if (method === "GET" && pathname === "/v1/kgm/aliases") {
    return send(params, 200, { items: store.listAliases() });
  }
  if (method === "POST" && pathname === "/v1/kgm/aliases") {
    if (!params.isMaster) return forbid(params);
    const body = (params.body ?? {}) as {
      id?: string;
      alias?: string;
      model?: string;
      provider?: string;
      runtimeId?: string;
      enabled?: boolean;
      notes?: string;
    };
    if (!body.alias?.trim() || !body.model?.trim()) {
      return send(params, 400, kgmErrorBody("invalid_request", "alias and model required", 400));
    }
    const record = store.upsertAlias({
      id: body.id,
      alias: body.alias,
      model: body.model,
      provider: body.provider,
      runtimeId: body.runtimeId,
      enabled: body.enabled,
      notes: body.notes,
    });
    return send(params, 200, { alias: record });
  }
  if (method === "DELETE" && pathname.startsWith("/v1/kgm/aliases/")) {
    if (!params.isMaster) return forbid(params);
    const id = pathname.slice("/v1/kgm/aliases/".length);
    const ok = store.deleteAlias(id);
    if (!ok) return send(params, 404, kgmErrorBody("not_found", "alias not found", 404));
    return send(params, 200, { deleted: true, id });
  }

  return send(params, 404, kgmErrorBody("not_found", "Not found", 404));
}

function forbid(params: OpsAdminRouteParams): true {
  return send(params, 403, kgmErrorBody("forbidden", "Master key required for ops management", 403));
}

function send(params: OpsAdminRouteParams, status: number, body: unknown): true {
  params.sendJson(params.res, status, body);
  return true;
}
