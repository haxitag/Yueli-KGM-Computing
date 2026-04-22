import { createTokenizer } from "../native/tokenizer.js";
export function createBackend(payload) {
    validateCheckpoint(payload.checkpoint);
    const tokenizer = createTokenizer(payload.checkpoint.tokenizer);
    const tokenizedOk = resolveTokenizedOk(tokenizer);
    return new NativeCoreAddonShimBackend(payload.metadata, tokenizedOk, extractShimOptions(payload.options));
}
class NativeCoreAddonShimBackend {
    metadata;
    tokenizedOk;
    options;
    nextRequestId = 1;
    requests = new Map();
    submitted = 0;
    completed = 0;
    cancelled = 0;
    constructor(metadata, tokenizedOk, options) {
        this.metadata = metadata;
        this.tokenizedOk = tokenizedOk;
        this.options = options;
    }
    isExecutable() {
        return true;
    }
    submit(payload) {
        const requestId = this.nextRequestId++;
        const resultText = this.tokenizedOk?.text ?? "ok";
        const tokenEvents = this.tokenizedOk
            ? this.tokenizedOk.tokens.map((tokenId, index) => ({
                type: "token",
                text: "",
                index,
                tokenId,
            }))
            : [{
                    type: "token",
                    text: resultText,
                    index: 0,
                }];
        const events = [
            {
                type: "started",
                model: payload.model,
            },
            ...tokenEvents,
            {
                type: "finished",
                result: createFinishedResult({
                    metadata: this.metadata,
                    text: resultText,
                    promptTokens: payload.promptTokens?.length ?? 0,
                    generatedTokens: this.tokenizedOk?.tokens.length ?? 1,
                    requestId: payload.requestId,
                    sessionId: payload.sessionId,
                    options: this.options,
                }),
            },
        ];
        this.requests.set(requestId, { events });
        this.submitted += 1;
        return requestId;
    }
    poll(requestId, maxEvents = 16) {
        const request = this.requests.get(requestId);
        if (!request) {
            return [];
        }
        const output = request.events.splice(0, Math.max(1, maxEvents));
        if (request.events.length === 0) {
            this.requests.delete(requestId);
            this.completed += 1;
        }
        return output;
    }
    cancel(requestId) {
        if (this.requests.delete(requestId)) {
            this.cancelled += 1;
        }
    }
    schedulerMetrics() {
        return {
            submitted: this.submitted,
            completed: this.completed,
            failed: 0,
            cancelled: this.cancelled,
            cycles: this.completed + this.cancelled,
            prefills: this.submitted,
            decodeSteps: this.completed,
            peakActive: 1,
            peakQueued: 1,
        };
    }
    close() {
        this.requests.clear();
    }
}
function validateCheckpoint(checkpoint) {
    if (checkpoint.format !== "kgm-transformer-checkpoint") {
        throw new Error(`native_core_addon_shim_invalid_checkpoint_format:${checkpoint.format}`);
    }
    for (const required of [
        "token_embedding.weight",
        "output_norm.weight",
        "lm_head.weight",
    ]) {
        if (!checkpoint.tensors[required]) {
            throw new Error(`native_core_addon_shim_missing_tensor:${required}`);
        }
    }
    if ((checkpoint.config.numLayers ?? 0) > 0) {
        for (const required of [
            "layers.0.attn_norm.weight",
            "layers.0.attention.wq.weight",
            "layers.0.feed_forward.w1.weight",
        ]) {
            if (!checkpoint.tensors[required]) {
                throw new Error(`native_core_addon_shim_missing_tensor:${required}`);
            }
        }
    }
}
function resolveTokenizedOk(tokenizer) {
    const tokens = tokenizer.encode("ok");
    if (tokens.length === 0) {
        return null;
    }
    const text = tokenizer.decode(tokens, { skipSpecialTokens: true });
    if (text !== "ok") {
        return null;
    }
    return { tokens, text };
}
function createFinishedResult(params) {
    return {
        text: params.text,
        raw: {
            nativeRuntime: {
                text: params.text,
                promptTokens: params.promptTokens,
                prefillTokens: params.promptTokens,
                generatedTokens: params.generatedTokens,
                finishReason: "length",
                ttftMs: 0,
                tpotMs: 0,
                tokensPerSecond: 0,
                device: "cpu",
                format: params.metadata.format,
                requestId: params.requestId,
                sessionId: params.sessionId,
                cacheSource: "cold",
                scheduler: {
                    continuousBatching: true,
                    servingBackend: "native-core",
                    maxBatchSize: params.options.schedulerMaxBatchSize,
                    maxPrefillsPerTick: params.options.schedulerMaxPrefillsPerTick,
                    kvCacheKind: "dense",
                    activeRequestsAtAdmission: 0,
                    queuedRequestsAtAdmission: 0,
                    requestSchedulerCycles: 1,
                    engineSchedulerCycles: 1,
                    peakActiveRequests: 1,
                    peakQueuedRequests: 1,
                },
                memory: {
                    kvResidentBytes: 0,
                    kvAllocatedPages: 0,
                    cachedKvResidentPages: 0,
                    cachedKvPageBudget: params.options.cachedKvPageBudget,
                },
                metadata: params.metadata,
            },
        },
    };
}
function extractShimOptions(options) {
    return {
        cachedKvPageBudget: readNumber(options?.cachedKvPageBudget) ?? 0,
        schedulerMaxBatchSize: readNumber(options?.schedulerMaxBatchSize) ?? 8,
        schedulerMaxPrefillsPerTick: readNumber(options?.schedulerMaxPrefillsPerTick) ?? 1,
    };
}
function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
