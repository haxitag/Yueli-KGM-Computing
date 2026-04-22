import type { BusinessRoutingConfig } from "./businessRouting.js";
import { RoutingHistoryStore, type RoutingHistoryEntry } from "./routingHistoryStore.js";

export type RoutingUpdatePayload = {
  routing?: Partial<BusinessRoutingConfig> | BusinessRoutingConfig;
  note?: string;
};

export function createRoutingHistoryStoreFromEnv(): RoutingHistoryStore {
  const filePath = process.env.KGM_ROUTING_HISTORY_PATH ?? "data/routing.history.json";
  const rawMax = Number(process.env.KGM_ROUTING_HISTORY_MAX ?? "50");
  const maxEntries = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 50;
  return new RoutingHistoryStore(filePath, maxEntries);
}

export function applyRoutingPatch(
  current: BusinessRoutingConfig,
  patch: Partial<BusinessRoutingConfig>,
  now: Date = new Date(),
): BusinessRoutingConfig {
  const nowIso = now.toISOString();
  const baseWeights =
    "baseWeights" in patch && patch.baseWeights !== undefined ? patch.baseWeights : current.baseWeights;
  const routes = "routes" in patch && patch.routes !== undefined ? patch.routes : current.routes;
  const version = patch.version ?? buildRoutingVersion(now);
  const updatedAt = patch.updatedAt ?? nowIso;
  return {
    ...current,
    ...patch,
    baseWeights,
    routes,
    version,
    updatedAt,
  };
}

export function parseRoutingUpdatePayload(payload: unknown): { patch: Partial<BusinessRoutingConfig>; note?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as RoutingUpdatePayload & Record<string, unknown>;
  const note = typeof obj.note === "string" ? obj.note : undefined;
  if (obj.routing && typeof obj.routing === "object") {
    return { patch: obj.routing as Partial<BusinessRoutingConfig>, note };
  }
  const { note: _note, routing: _routing, ...rest } = obj as Record<string, unknown>;
  return { patch: rest as Partial<BusinessRoutingConfig>, note };
}

export function buildUpdateEntry(config: BusinessRoutingConfig, note?: string): RoutingHistoryEntry {
  return {
    action: "update",
    version: config.version,
    recordedAt: new Date().toISOString(),
    config: structuredClone(config),
    note,
  };
}

export function buildRollbackEntry(
  config: BusinessRoutingConfig,
  rollbackFrom: string | undefined,
  note?: string,
): RoutingHistoryEntry {
  return {
    action: "rollback",
    version: config.version,
    recordedAt: new Date().toISOString(),
    config: structuredClone(config),
    note,
    rollbackFrom,
  };
}

function buildRoutingVersion(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `route-${stamp}`;
}
