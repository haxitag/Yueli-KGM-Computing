/**
 * TokenSpeed-inspired per-request stats for KGM observability.
 * KV/prefix cache remains owned by the worker; KGM only reports what upstream exposes.
 */

export type KgmRequestPerf = {
  ttftMs?: number;
  totalMs?: number;
  decodeTps?: number;
  cacheHitRate?: number;
  cachedTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  toolRounds?: number;
  intentSource?: "native_tool_calls" | "text_json" | string;
  agenticProfile?: string;
  runtimeKind?: string;
  /** Explicit: prefix/KV owned by worker, not KGM native kernels */
  kvOwner: "worker" | "unknown";
};

export function extractCachedTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  if (typeof u.cached_tokens === "number" && Number.isFinite(u.cached_tokens)) {
    return u.cached_tokens;
  }
  const details = u.prompt_tokens_details;
  if (details && typeof details === "object") {
    const cached = (details as Record<string, unknown>).cached_tokens;
    if (typeof cached === "number" && Number.isFinite(cached)) return cached;
  }
  return undefined;
}

export function buildKgmRequestPerf(params: {
  startedAtMs: number;
  firstTokenAtMs?: number;
  finishedAtMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  toolRounds?: number;
  intentSource?: string;
  agenticProfile?: string;
  runtimeKind?: string;
}): KgmRequestPerf {
  const totalMs =
    params.finishedAtMs != null ? Math.max(0, params.finishedAtMs - params.startedAtMs) : undefined;
  const ttftMs =
    params.firstTokenAtMs != null ? Math.max(0, params.firstTokenAtMs - params.startedAtMs) : undefined;
  const decodeWindowMs =
    params.firstTokenAtMs != null && params.finishedAtMs != null
      ? Math.max(1, params.finishedAtMs - params.firstTokenAtMs)
      : totalMs && ttftMs != null
        ? Math.max(1, totalMs - ttftMs)
        : undefined;
  const decodeTps =
    decodeWindowMs != null && params.completionTokens != null && params.completionTokens > 0
      ? (params.completionTokens / decodeWindowMs) * 1000
      : undefined;
  const cacheHitRate =
    params.cachedTokens != null && params.promptTokens != null && params.promptTokens > 0
      ? Math.min(1, Math.max(0, params.cachedTokens / params.promptTokens))
      : undefined;

  return {
    ttftMs: ttftMs != null ? round1(ttftMs) : undefined,
    totalMs: totalMs != null ? round1(totalMs) : undefined,
    decodeTps: decodeTps != null ? round1(decodeTps) : undefined,
    cacheHitRate: cacheHitRate != null ? round3(cacheHitRate) : undefined,
    cachedTokens: params.cachedTokens,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    toolRounds: params.toolRounds,
    intentSource: params.intentSource,
    agenticProfile: params.agenticProfile,
    runtimeKind: params.runtimeKind,
    kvOwner: "worker",
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Merge OpenAI usage with optional cached token details for clients. */
export function enrichUsageWithCache(
  usage: Record<string, number> | undefined,
  cachedTokens: number | undefined,
): Record<string, unknown> | undefined {
  if (!usage && cachedTokens == null) return undefined;
  const next: Record<string, unknown> = { ...(usage ?? {}) };
  if (cachedTokens != null) {
    next.cached_tokens = cachedTokens;
    next.prompt_tokens_details = {
      ...((next.prompt_tokens_details as Record<string, unknown>) ?? {}),
      cached_tokens: cachedTokens,
    };
  }
  return next;
}
