import fs from "node:fs";
import path from "node:path";
import { generateId } from "../utils/id.js";
export class AutoRoutingAuditStore {
    filePath;
    maxEntries;
    state;
    constructor(options) {
        this.filePath = path.resolve(options?.filePath ?? process.env.KGM_AUTO_ROUTING_AUDIT_PATH ?? "data/auto-routing-audit.json");
        this.maxEntries = options?.maxEntries ?? 500;
        this.state = this.load();
    }
    record(entry) {
        const stored = {
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
    list(limit = 50) {
        return [...this.state.entries]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit);
    }
    getCandidateStats(routeKey, taskType) {
        const entries = this.filterEntries(routeKey, taskType);
        if (entries.length === 0 && taskType) {
            return this.buildStats(routeKey, this.filterEntries(routeKey));
        }
        return this.buildStats(routeKey, entries);
    }
    summarize(limit = 20) {
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
        const byModelMap = new Map();
        for (const entry of entries) {
            const current = byModelMap.get(entry.selected.routeKey);
            if (current) {
                current.items.push(entry);
            }
            else {
                byModelMap.set(entry.selected.routeKey, {
                    selected: entry.selected,
                    items: [entry],
                });
            }
        }
        const byModel = Array.from(byModelMap.values())
            .map(({ selected, items }) => ({
            ...this.buildStats(selected.routeKey, items),
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
    filterEntries(routeKey, taskType) {
        return this.state.entries.filter((entry) => entry.selected.routeKey === routeKey && (!taskType || entry.taskType === taskType));
    }
    buildStats(routeKey, entries) {
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
            verificationPassRate: average((entries.some((item) => item.verifiable) ? entries.filter((item) => item.verifiable) : entries)
                .map((item) => (item.verificationPassed ? 1 : 0))),
            lastSeenAt: [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.timestamp,
        };
    }
    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                return { entries: [] };
            }
            const raw = fs.readFileSync(this.filePath, "utf8");
            if (!raw.trim()) {
                return { entries: [] };
            }
            const parsed = JSON.parse(raw);
            return {
                entries: Array.isArray(parsed.entries) ? parsed.entries : [],
            };
        }
        catch {
            return { entries: [] };
        }
    }
    persist() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    }
}
function groupBy(items, getKey) {
    const map = new Map();
    for (const item of items) {
        const key = getKey(item);
        const bucket = map.get(key);
        if (bucket) {
            bucket.push(item);
        }
        else {
            map.set(key, [item]);
        }
    }
    return map;
}
function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}
function average(values) {
    if (values.length === 0) {
        return 0;
    }
    return sum(values) / values.length;
}
function averageDefined(values) {
    return average(values.filter((value) => typeof value === "number"));
}
function getEvaluationPromptTokens(entry) {
    if (typeof entry.evaluationPromptTokens === "number") {
        return entry.evaluationPromptTokens;
    }
    return (entry.evaluation?.judge?.promptTokens ?? 0) + (entry.evaluation?.verifier?.promptTokens ?? 0);
}
function getEvaluationCompletionTokens(entry) {
    if (typeof entry.evaluationCompletionTokens === "number") {
        return entry.evaluationCompletionTokens;
    }
    return (entry.evaluation?.judge?.completionTokens ?? 0) + (entry.evaluation?.verifier?.completionTokens ?? 0);
}
function getEvaluationTotalTokens(entry) {
    if (typeof entry.evaluationTotalTokens === "number") {
        return entry.evaluationTotalTokens;
    }
    return (entry.evaluation?.judge?.totalTokens ?? 0) + (entry.evaluation?.verifier?.totalTokens ?? 0);
}
function getTotalTokens(entry) {
    if (typeof entry.totalTokensWithEvaluation === "number") {
        return entry.totalTokensWithEvaluation;
    }
    return (entry.totalTokens ?? 0) + getEvaluationTotalTokens(entry);
}
function getEvaluationCost(entry) {
    if (typeof entry.evaluationCost === "number") {
        return entry.evaluationCost;
    }
    return (entry.evaluation?.judge?.cost ?? 0) + (entry.evaluation?.verifier?.cost ?? 0);
}
function getTotalCost(entry) {
    if (typeof entry.totalCost === "number") {
        return entry.totalCost;
    }
    return (entry.actualCost ?? 0) + getEvaluationCost(entry);
}
function hasJudgeRun(entry) {
    return Boolean(entry.evaluation?.judge?.attempted);
}
function hasVerifierRun(entry) {
    return Boolean(entry.evaluation?.verifier?.attempted);
}
