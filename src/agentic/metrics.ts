/**
 * In-process agentic / SLO counters for control-plane readouts.
 * Not a Prometheus replacement — complements /metrics for operator panels.
 */

import { prefixLengthBucket } from "./routingPreferences.js";

export type AgenticRoundRecord = {
  profile: string;
  taskType?: string;
  rounds: number;
  toolInterrupts: number;
  prefixChars: number;
  firstTokenMs?: number;
  agentHops?: number;
  usedNativeToolCalls?: boolean;
};

type AgenticSnapshot = {
  requestsTotal: number;
  codingRequests: number;
  toolHeavyRequests: number;
  toolInterruptsTotal: number;
  roundsTotal: number;
  agentHopsTotal: number;
  nativeToolCallsRequests: number;
  prefixBuckets: Record<string, number>;
  lastFirstTokenMs?: number;
  recent: AgenticRoundRecord[];
};

const MAX_RECENT = 50;

const state: AgenticSnapshot = {
  requestsTotal: 0,
  codingRequests: 0,
  toolHeavyRequests: 0,
  toolInterruptsTotal: 0,
  roundsTotal: 0,
  agentHopsTotal: 0,
  nativeToolCallsRequests: 0,
  prefixBuckets: {},
  recent: [],
};

export function recordAgenticRound(record: AgenticRoundRecord): void {
  state.requestsTotal += 1;
  if (record.profile === "coding") state.codingRequests += 1;
  if (record.profile === "tool_heavy") state.toolHeavyRequests += 1;
  state.toolInterruptsTotal += record.toolInterrupts;
  state.roundsTotal += record.rounds;
  if (typeof record.agentHops === "number") {
    state.agentHopsTotal += record.agentHops;
  }
  if (record.usedNativeToolCalls) {
    state.nativeToolCallsRequests += 1;
  }
  const bucket = prefixLengthBucket(record.prefixChars);
  state.prefixBuckets[bucket] = (state.prefixBuckets[bucket] ?? 0) + 1;
  if (typeof record.firstTokenMs === "number") {
    state.lastFirstTokenMs = record.firstTokenMs;
  }
  state.recent.push(record);
  if (state.recent.length > MAX_RECENT) {
    state.recent.shift();
  }
}

export function getAgenticMetricsSnapshot(): AgenticSnapshot & {
  avgRounds: number;
  avgToolInterrupts: number;
} {
  const n = Math.max(1, state.requestsTotal);
  return {
    ...state,
    prefixBuckets: { ...state.prefixBuckets },
    recent: [...state.recent],
    avgRounds: state.roundsTotal / n,
    avgToolInterrupts: state.toolInterruptsTotal / n,
  };
}

/** Test helper */
export function resetAgenticMetrics(): void {
  state.requestsTotal = 0;
  state.codingRequests = 0;
  state.toolHeavyRequests = 0;
  state.toolInterruptsTotal = 0;
  state.roundsTotal = 0;
  state.agentHopsTotal = 0;
  state.nativeToolCallsRequests = 0;
  state.prefixBuckets = {};
  state.lastFirstTokenMs = undefined;
  state.recent = [];
}
