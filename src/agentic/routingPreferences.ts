/**
 * Agentic traffic preferences for code_generation / tool-heavy paths.
 * TokenSpeed-inspired serving patterns (long prefix, tool interrupts) —
 * applied inside KGM routing, not by treating TokenSpeed as NLU.
 */

import type { RoutingHints } from "../core/types.js";

export type AgenticProfile = "coding" | "tool_heavy" | "standard";

export type AgenticRoutingHints = {
  agenticProfile: AgenticProfile;
  preferLongContext: boolean;
  preferHighTps: boolean;
  skipAggressiveSummarization: boolean;
  sessionContinuity: boolean;
  toolHeavy: boolean;
};

const TOOL_HEAVY_RE =
  /\b(tool|tools|function.?call|mcp|sandbox|invoke_skill|code_execution|shell|grep|read_file|write_file)\b/i;
const CODING_RE =
  /\b(typescript|javascript|python|golang|rust|bug|fix|refactor|compile|debug|代码|编程|函数|实现)\b/i;

export function detectAgenticProfile(params: {
  taskType?: string;
  input?: string;
  toolCount?: number;
  metadata?: Record<string, unknown>;
}): AgenticProfile {
  const existing = params.metadata?.agentic_profile;
  if (existing === "coding" || existing === "tool_heavy" || existing === "standard") {
    return existing;
  }
  if (params.taskType === "code_generation") {
    return "coding";
  }
  const toolCount = params.toolCount ?? 0;
  if (toolCount >= 2 || TOOL_HEAVY_RE.test(params.input ?? "")) {
    return "tool_heavy";
  }
  if (CODING_RE.test(params.input ?? "")) {
    return "coding";
  }
  return "standard";
}

export function buildAgenticRoutingHints(profile: AgenticProfile): AgenticRoutingHints {
  const agentic = profile === "coding" || profile === "tool_heavy";
  return {
    agenticProfile: profile,
    preferLongContext: agentic,
    preferHighTps: agentic,
    skipAggressiveSummarization: agentic,
    sessionContinuity: true,
    toolHeavy: profile === "tool_heavy" || profile === "coding",
  };
}

/** Merge agentic preferences into request metadata (idempotent). */
export function enrichAgenticMetadata(
  metadata: Record<string, unknown> | undefined,
  params: {
    taskType?: string;
    input?: string;
    toolCount?: number;
    sessionId?: string;
    nativeRuntimeId?: string;
  },
): Record<string, unknown> {
  const profile = detectAgenticProfile({
    taskType: params.taskType ?? (typeof metadata?.task_type === "string" ? metadata.task_type : undefined),
    input: params.input,
    toolCount: params.toolCount,
    metadata,
  });
  const hints = buildAgenticRoutingHints(profile);
  const next: Record<string, unknown> = { ...(metadata ?? {}) };

  if (params.taskType && typeof next.task_type !== "string") {
    next.task_type = params.taskType;
  }
  if (profile === "coding" && typeof next.task_type !== "string") {
    next.task_type = "code_generation";
  }

  next.agentic_profile = hints.agenticProfile;
  next.prefer_long_context = hints.preferLongContext;
  next.prefer_high_tps = hints.preferHighTps;
  next.skip_aggressive_summarization = hints.skipAggressiveSummarization;
  next.session_continuity = hints.sessionContinuity;
  next.tool_heavy = hints.toolHeavy;

  if (params.sessionId && typeof next.session_id !== "string") {
    next.session_id = params.sessionId;
  }
  if (params.nativeRuntimeId && typeof next.native_runtime_id !== "string") {
    next.native_runtime_id = params.nativeRuntimeId;
  }

  return next;
}

export function enrichRoutingHints(
  routing: RoutingHints | undefined,
  metadata: Record<string, unknown>,
): RoutingHints {
  const taskType =
    routing?.taskType ??
    (typeof metadata.task_type === "string" ? metadata.task_type : undefined);
  const profile = detectAgenticProfile({ taskType, metadata });
  const next: RoutingHints = { ...(routing ?? {}) };
  if (taskType && !next.taskType) {
    next.taskType = taskType;
  }
  if ((profile === "coding" || profile === "tool_heavy") && !next.profile) {
    next.profile = "quality_first";
  }
  return next;
}

/** Score bias for managed / high-TPS candidates under agentic profiles. */
export function agenticCandidateBias(params: {
  profile: AgenticProfile;
  source: string;
  provider?: string;
  tokensPerSecond?: number;
  preferLongContext?: boolean;
}): number {
  if (params.profile === "standard") {
    return 0;
  }
  let bias = 0;
  if (params.source === "managed") {
    bias += 0.06;
  }
  const tps = params.tokensPerSecond;
  if (typeof tps === "number" && Number.isFinite(tps) && tps > 0) {
    bias += Math.min(0.12, tps / 500);
  }
  const provider = (params.provider ?? "").toLowerCase();
  if (
    params.preferLongContext &&
    (provider.includes("llama") ||
      provider.includes("ds4") ||
      provider.includes("vllm") ||
      provider.includes("sglang") ||
      provider.includes("tokenspeed"))
  ) {
    bias += 0.05;
  }
  // Production agentic: prefer TokenSpeed managed workers for coding/tool-heavy
  if (provider.includes("tokenspeed")) {
    bias += 0.08;
  }
  return bias;
}

export function prefixLengthBucket(chars: number): string {
  if (chars < 500) return "lt_500";
  if (chars < 2_000) return "500_2k";
  if (chars < 8_000) return "2k_8k";
  if (chars < 32_000) return "8k_32k";
  return "gte_32k";
}
