import { generateId } from "../utils/id.js";
import { extractAutoRoutingTrace, extractResolvedModel } from "./autoRoutingClient.js";
import { streamCompletion } from "./client.js";
const estimateTokens = (text) => {
    if (!text)
        return 0;
    return Math.max(1, Math.ceil(text.length / 4));
};
export class AdapterLlmClient {
    inner;
    adapter;
    store;
    constructor(inner, adapter, store) {
        this.inner = inner;
        this.adapter = adapter;
        this.store = store;
    }
    async complete(prompt, options) {
        const start = Date.now();
        try {
            const result = await this.inner.complete(prompt, options);
            const elapsedMs = Date.now() - start;
            this.reportPerformance(prompt, result, elapsedMs, options, false);
            return result;
        }
        catch (error) {
            const elapsedMs = Date.now() - start;
            const message = error instanceof Error ? error.message : String(error);
            this.reportPerformance(prompt, { text: message, raw: undefined }, elapsedMs, options, true);
            throw error;
        }
    }
    async *streamComplete(prompt, options) {
        const start = Date.now();
        let output = "";
        try {
            for await (const event of streamCompletion(this.inner, prompt, options)) {
                if (event.type === "token") {
                    output += event.text;
                }
                if (event.type === "finished") {
                    output = event.result.text;
                    this.reportPerformance(prompt, event.result, Date.now() - start, options, false);
                }
                yield event;
            }
        }
        catch (error) {
            const elapsedMs = Date.now() - start;
            const message = error instanceof Error ? error.message : String(error);
            this.reportPerformance(prompt, { text: message, raw: undefined }, elapsedMs, options, true);
            throw error;
        }
    }
    reportPerformance(prompt, result, elapsedMs, options, isError) {
        const config = this.store.get().llm;
        const routingTrace = extractAutoRoutingTrace(result.raw);
        const output = result.text;
        const modelName = extractResolvedModel(result.raw) ?? options?.model ?? config.model;
        const tokens = estimateTokens(prompt) + estimateTokens(output);
        const seconds = elapsedMs > 0 ? elapsedMs / 1000 : 0;
        const throughput = seconds > 0 ? tokens / seconds : 0;
        const taskType = options?.taskType ??
            routingTrace?.taskType ??
            (typeof options?.metadata?.task_type === "string" ? options.metadata.task_type : "general");
        const quality = isError ? 0 : routingTrace?.evaluation?.qualityScore ?? routingTrace?.selected.quality ?? 0.6;
        const trust = isError ? 0 : routingTrace?.evaluation?.confidence ?? routingTrace?.selected.trust ?? 0.6;
        const cost = isError ? 0 : routingTrace?.evaluation
            ? (routingTrace.evaluation.judge?.cost ?? 0) + (routingTrace.evaluation.verifier?.cost ?? 0) + (routingTrace?.selected.estimatedCost ?? 0)
            : routingTrace?.selected.estimatedCost ?? 0;
        const metrics = {
            responseTimeMs: Math.max(0, elapsedMs),
            throughputTokensPerSecond: Math.max(0, throughput),
            errorRate: isError ? 1 : 0,
            cost,
            accuracy: isError ? 0 : quality,
            usefulness: isError ? 0 : clamp((quality + trust) / 2),
            creativity: isError ? 0 : clamp(quality * 0.85),
            consistency: isError ? 0 : clamp((trust + quality) / 2),
        };
        const record = {
            id: generateId(),
            modelName,
            metrics,
            taskType,
            timestamp: new Date().toISOString(),
            inputPrompt: prompt,
            modelOutput: output,
        };
        void this.adapter.sendPerformance(record).catch(() => { });
    }
}
function clamp(value) {
    return Math.max(0, Math.min(1, value));
}
