/**
 * Record usage events into Ops ledger (best-effort).
 */

import { getOpsAuth } from "./opsAuthContext.js";
import { getOpsStore } from "./opsStore.js";

export async function recordOpsUsage(event: {
  model: string;
  provider?: string;
  runtimeId?: string;
  profile?: string;
  taskType?: string;
  success: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  requestId?: string;
  source?: "auto_routing" | "direct" | "manual";
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const auth = getOpsAuth();
    const store = await getOpsStore();
    store.recordUsage({
      keyId: auth.keyId,
      keyName: auth.keyName,
      requestId: event.requestId,
      model: event.model,
      provider: event.provider,
      runtimeId: event.runtimeId,
      profile: event.profile,
      taskType: event.taskType,
      success: event.success,
      latencyMs: event.latencyMs,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      totalTokens: event.totalTokens,
      costUsd: event.costUsd,
      source: event.source ?? "direct",
      meta: event.meta,
    });
  } catch {
    // never break inference path
  }
}
