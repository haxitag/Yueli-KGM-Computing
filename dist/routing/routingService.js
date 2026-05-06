import { RoutingHistoryStore } from "./routingHistoryStore.js";
export function createRoutingHistoryStoreFromEnv() {
    const filePath = process.env.KGM_ROUTING_HISTORY_PATH ?? "data/routing.history.json";
    const rawMax = Number(process.env.KGM_ROUTING_HISTORY_MAX ?? "50");
    const maxEntries = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 50;
    return new RoutingHistoryStore(filePath, maxEntries);
}
export function applyRoutingPatch(current, patch, now = new Date()) {
    const nowIso = now.toISOString();
    const baseWeights = "baseWeights" in patch && patch.baseWeights !== undefined ? patch.baseWeights : current.baseWeights;
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
export function parseRoutingUpdatePayload(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const obj = payload;
    const note = typeof obj.note === "string" ? obj.note : undefined;
    if (obj.routing && typeof obj.routing === "object") {
        return { patch: obj.routing, note };
    }
    const { note: _note, routing: _routing, ...rest } = obj;
    return { patch: rest, note };
}
export function buildUpdateEntry(config, note) {
    return {
        action: "update",
        version: config.version,
        recordedAt: new Date().toISOString(),
        config: structuredClone(config),
        note,
    };
}
export function buildRollbackEntry(config, rollbackFrom, note) {
    return {
        action: "rollback",
        version: config.version,
        recordedAt: new Date().toISOString(),
        config: structuredClone(config),
        note,
        rollbackFrom,
    };
}
function buildRoutingVersion(now) {
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `route-${stamp}`;
}
