import fs from "node:fs";
import path from "node:path";

import { generateId } from "../utils/id.js";

export type AutoRoutingCandidateSnapshot = {
  routeKey: string;
  label: string;
  source: "managed" | "provider" | "default";
  model: string;
  provider?: string;
  runtimeId?: string;
  /** 上游 baseUrl 主机摘要（便于 Copilot 展示路由契约） */
  baseUrlHost?: string;
  failureReason?: string;
  score: number;
  estimatedCost: number;
  successRate: number;
  quality: number;
  trust: number;
  latencyMs: number;
  verification: number;
};

export type AutoRoutingEvaluationSource = "judge" | "verifier" | "judge_and_verifier" | "heuristic";

export type AutoRoutingVerificationSource = "verifier" | "heuristic" | "not_applicable";

export type AutoRoutingEvaluationStageRecord = {
  enabled: boolean;
  attempted: boolean;
  routeKey?: string;
  label?: string;
  source?: AutoRoutingCandidateSnapshot["source"];
  model?: string;
  provider?: string;
  runtimeId?: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  score?: number;
  confidence?: number;
  passed?: boolean;
  rationale?: string;
  issues?: string[];
  error?: string;
};

export type AutoRoutingEvaluationRecord = {
  mode: "online" | "heuristic";
  qualitySource: AutoRoutingEvaluationSource;
  confidenceSource: AutoRoutingEvaluationSource;
  verificationSource: AutoRoutingVerificationSource;
  judge?: AutoRoutingEvaluationStageRecord;
  verifier?: AutoRoutingEvaluationStageRecord;
};

export type AutoRoutingAuditEntry = {
  id: string;
  timestamp: string;
  requestId?: string;
  sessionId?: string;
  profile: string;
  taskType: string;
  taskName?: string;
  inputPreview: string;
  complexity: number;
  verifiable: boolean;
  selected: AutoRoutingCandidateSnapshot;
  candidates: AutoRoutingCandidateSnapshot[];
  success: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  evaluationPromptTokens: number;
  evaluationCompletionTokens: number;
  evaluationTotalTokens: number;
  totalTokensWithEvaluation: number;
  estimatedCost: number;
  actualCost: number;
  evaluationCost: number;
  totalCost: number;
  verificationAttempted: boolean;
  verificationPassed: boolean;
  qualityScore: number;
  confidence: number;
  evaluation: AutoRoutingEvaluationRecord;
  error?: string;
};

type AutoRoutingAuditState = {
  entries: AutoRoutingAuditEntry[];
};

export type AutoRoutingCandidateStats = {
  routeKey: string;
  requestCount: number;
  successRate: number;
  avgLatencyMs: number;
  avgQuality: number;
  avgConfidence: number;
  avgCost: number;
  avgEvaluationCost: number;
  avgTotalCost: number;
  avgJudgeScore: number;
  avgJudgeConfidence: number;
  judgeRunRate: number;
  verifierRunRate: number;
  verificationPassRate: number;
  lastSeenAt?: string;
};

export class AutoRoutingAuditStore {
  private filePath: string;
  private maxEntries: number;
  private state: AutoRoutingAuditState;

  constructor(options?: { filePath?: string; maxEntries?: number }) {
    this.filePath = path.resolve(
      options?.filePath ?? process.env.KGM_AUTO_ROUTING_AUDIT_PATH ?? "data/auto-routing-audit.json",
    );
    this.maxEntries = options?.maxEntries ?? 500;
    this.state = this.load();
  }

  record(entry: Omit<AutoRoutingAuditEntry, "id" | "timestamp"> & {
    id?: string;
    timestamp?: string;
  }): AutoRoutingAuditEntry {
    const stored: AutoRoutingAuditEntry = {
      id: entry.id ?? generateId("route"),
      timestamp: entry.timestamp ?? new Date().toISOString(),
      ...entry,
    };
    this.state.entries.push(stored);
    if (this.state.entries.length > this.maxEntries) {
      this.state.entries = this.state.entries.slice(-this.maxEntries);
    }
    this.persist();
    return stored;
  }

  list(limit = 50): AutoRoutingAuditEntry[] {
    return [...this.state.entries]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  getCandidateStats(routeKey: string, taskType?: string): AutoRoutingCandidateStats | undefined {
    const entries = this.filterEntries(routeKey, taskType);
    if (entries.length === 0 && taskType) {
      return this.buildStats(routeKey, this.filterEntries(routeKey));
    }
    return this.buildStats(routeKey, entries);
  }

  summarize(limit = 20): {
    totals: {
      requests: number;
      successRate: number;
      avgLatencyMs: number;
      promptTokens: number;
      completionTokens: number;
      evaluationPromptTokens: number;
      evaluationCompletionTokens: number;
      totalTokens: number;
      estimatedCost: number;
      actualCost: number;
      evaluationCost: number;
      totalCost: number;
      avgQuality: number;
      avgConfidence: number;
      judgeRuns: number;
      verifierRuns: number;
    };
    byModel: Array<
      AutoRoutingCandidateStats & {
        label: string;
        source: AutoRoutingCandidateSnapshot["source"];
        model: string;
        provider?: string;
      }
    >;
    byTaskType: Array<{
      taskType: string;
      requests: number;
      successRate: number;
      avgLatencyMs: number;
      totalTokens: number;
      actualCost: number;
      evaluationCost: number;
      totalCost: number;
      avgQuality: number;
      avgConfidence: number;
    }>;
    recent: AutoRoutingAuditEntry[];
  } {
    const entries = [...this.state.entries];
    const totalRequests = entries.length;
    const totals = {
      requests: totalRequests,
      successRate: totalRequests ? average(entries.map((item) => (item.success ? 1 : 0))) : 0,
      avgLatencyMs: totalRequests ? average(entries.map((item) => item.latencyMs)) : 0,
      promptTokens: sum(entries.map((item) => item.promptTokens ?? 0)),
      completionTokens: sum(entries.map((item) => item.completionTokens ?? 0)),
      evaluationPromptTokens: sum(entries.map((item) => getEvaluationPromptTokens(item))),
      evaluationCompletionTokens: sum(entries.map((item) => getEvaluationCompletionTokens(item))),
      totalTokens: sum(entries.map((item) => getTotalTokens(item))),
      estimatedCost: sum(entries.map((item) => item.estimatedCost)),
      actualCost: sum(entries.map((item) => item.actualCost)),
      evaluationCost: sum(entries.map((item) => getEvaluationCost(item))),
      totalCost: sum(entries.map((item) => getTotalCost(item))),
      avgQuality: totalRequests ? average(entries.map((item) => item.qualityScore ?? 0)) : 0,
      avgConfidence: totalRequests ? average(entries.map((item) => item.confidence ?? 0)) : 0,
      judgeRuns: entries.filter((item) => hasJudgeRun(item)).length,
      verifierRuns: entries.filter((item) => hasVerifierRun(item)).length,
    };

    const byModelMap = new Map<string, {
      selected: AutoRoutingCandidateSnapshot;
      items: AutoRoutingAuditEntry[];
    }>();
    for (const entry of entries) {
      const current = byModelMap.get(entry.selected.routeKey);
      if (current) {
        current.items.push(entry);
      } else {
        byModelMap.set(entry.selected.routeKey, {
          selected: entry.selected,
          items: [entry],
        });
      }
    }
    const byModel = Array.from(byModelMap.values())
      .map(({ selected, items }) => ({
        ...this.buildStats(selected.routeKey, items)!,
        label: selected.label,
        source: selected.source,
        model: selected.model,
        provider: selected.provider,
      }))
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, limit);

    const byTaskType = Array.from(groupBy(entries, (item) => item.taskType).entries())
      .map(([taskType, items]) => ({
        taskType,
        requests: items.length,
        successRate: average(items.map((item) => (item.success ? 1 : 0))),
        avgLatencyMs: average(items.map((item) => item.latencyMs)),
        totalTokens: sum(items.map((item) => getTotalTokens(item))),
        actualCost: sum(items.map((item) => item.actualCost)),
        evaluationCost: sum(items.map((item) => getEvaluationCost(item))),
        totalCost: sum(items.map((item) => getTotalCost(item))),
        avgQuality: average(items.map((item) => item.qualityScore ?? 0)),
        avgConfidence: average(items.map((item) => item.confidence ?? 0)),
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, limit);

    return {
      totals,
      byModel,
      byTaskType,
      recent: this.list(limit),
    };
  }

  private filterEntries(routeKey: string, taskType?: string): AutoRoutingAuditEntry[] {
    return this.state.entries.filter(
      (entry) => entry.selected.routeKey === routeKey && (!taskType || entry.taskType === taskType),
    );
  }

  private buildStats(routeKey: string, entries: AutoRoutingAuditEntry[]): AutoRoutingCandidateStats | undefined {
    if (entries.length === 0) {
      return undefined;
    }
    return {
      routeKey,
      requestCount: entries.length,
      successRate: average(entries.map((item) => (item.success ? 1 : 0))),
      avgLatencyMs: average(entries.map((item) => item.latencyMs)),
      avgQuality: average(entries.map((item) => item.qualityScore)),
      avgConfidence: average(entries.map((item) => item.confidence)),
      avgCost: average(entries.map((item) => item.actualCost)),
      avgEvaluationCost: average(entries.map((item) => getEvaluationCost(item))),
      avgTotalCost: average(entries.map((item) => getTotalCost(item))),
      avgJudgeScore: averageDefined(entries.map((item) => item.evaluation?.judge?.score)),
      avgJudgeConfidence: averageDefined(entries.map((item) => item.evaluation?.judge?.confidence)),
      judgeRunRate: average(entries.map((item) => (hasJudgeRun(item) ? 1 : 0))),
      verifierRunRate: average(entries.map((item) => (hasVerifierRun(item) ? 1 : 0))),
      verificationPassRate: average(
        (entries.some((item) => item.verifiable) ? entries.filter((item) => item.verifiable) : entries)
          .map((item) => (item.verificationPassed ? 1 : 0)),
      ),
      lastSeenAt: [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.timestamp,
    };
  }

  private load(): AutoRoutingAuditState {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { entries: [] };
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        return { entries: [] };
      }
      const parsed = JSON.parse(raw) as AutoRoutingAuditState;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      return { entries: [] };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }
}

function groupBy<T, K>(items: T[], getKey: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return sum(values) / values.length;
}

function averageDefined(values: Array<number | undefined>): number {
  return average(values.filter((value): value is number => typeof value === "number"));
}

function getEvaluationPromptTokens(entry: AutoRoutingAuditEntry): number {
  if (typeof entry.evaluationPromptTokens === "number") {
    return entry.evaluationPromptTokens;
  }
  return (entry.evaluation?.judge?.promptTokens ?? 0) + (entry.evaluation?.verifier?.promptTokens ?? 0);
}

function getEvaluationCompletionTokens(entry: AutoRoutingAuditEntry): number {
  if (typeof entry.evaluationCompletionTokens === "number") {
    return entry.evaluationCompletionTokens;
  }
  return (entry.evaluation?.judge?.completionTokens ?? 0) + (entry.evaluation?.verifier?.completionTokens ?? 0);
}

function getEvaluationTotalTokens(entry: AutoRoutingAuditEntry): number {
  if (typeof entry.evaluationTotalTokens === "number") {
    return entry.evaluationTotalTokens;
  }
  return (entry.evaluation?.judge?.totalTokens ?? 0) + (entry.evaluation?.verifier?.totalTokens ?? 0);
}

function getTotalTokens(entry: AutoRoutingAuditEntry): number {
  if (typeof entry.totalTokensWithEvaluation === "number") {
    return entry.totalTokensWithEvaluation;
  }
  return (entry.totalTokens ?? 0) + getEvaluationTotalTokens(entry);
}

function getEvaluationCost(entry: AutoRoutingAuditEntry): number {
  if (typeof entry.evaluationCost === "number") {
    return entry.evaluationCost;
  }
  return (entry.evaluation?.judge?.cost ?? 0) + (entry.evaluation?.verifier?.cost ?? 0);
}

function getTotalCost(entry: AutoRoutingAuditEntry): number {
  if (typeof entry.totalCost === "number") {
    return entry.totalCost;
  }
  return (entry.actualCost ?? 0) + getEvaluationCost(entry);
}

function hasJudgeRun(entry: AutoRoutingAuditEntry): boolean {
  return Boolean(entry.evaluation?.judge?.attempted);
}

function hasVerifierRun(entry: AutoRoutingAuditEntry): boolean {
  return Boolean(entry.evaluation?.verifier?.attempted);
}
