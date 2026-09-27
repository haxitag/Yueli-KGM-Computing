import { createHash } from "node:crypto";
import { loadNativeModel } from "./loaders.js";
import { createCanonicalCheckpointForNativeCore } from "./checkpoint.js";
import { softmax } from "./tensor.js";
import { countKvSnapshotPages, GlobalPagedKvAllocator } from "./transformer.js";
import { getNativeCoreBindingStatus, loadNativeCoreBinding, } from "./bindings.js";
import { computeAdmitLimit } from "../inference/continuousBatching.js";
export function createNativeServingBackend(modelPath, options) {
    const loaded = loadNativeModel(modelPath, { modelRef: options?.modelRef });
    const preference = normalizeServingBackendPreference(options?.servingBackend);
    if (preference === "native-gpu") {
        return new NativeGpuServingBackend(modelPath, loaded, options);
    }
    if (preference === "native-core") {
        const nativeCore = getNativeCoreBindingStatus();
        if (!nativeCore.available) {
            throw new Error(`Yueli KGM Runtime core backend unavailable:${nativeCore.reason ?? "binding_not_configured"}`);
        }
        return new NativeCoreServingBackend(modelPath, loaded, options);
    }
    return new JsReferenceNativeServingBackend(modelPath, loaded, options);
}
/** Stable prefix for integration tests; trailing text explains remediation. */
const NATIVE_GPU_BACKEND_NOT_IMPLEMENTED_MSG = "native_gpu_backend_not_implemented: accelerated inference kernels are not shipped; " +
    "for production GPU throughput use managed vLLM/SGLang (createRuntime auto / gpu_throughput/plan); " +
    "set KGM_NATIVE_GPU_SIMULATED=1 only to delegate to js-reference for labeled simulation.";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
class NativeGpuServingBackend {
    kind = "native-gpu";
    modelPath;
    loaded;
    // Phase 6（SIM）：通过 env 开启模拟执行（复用 js-reference 完成推理），同时暴露 memory-plan/registry 扩展点。
    simDelegate;
    schedulerStats = {
        submitted: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        cycles: 0,
        prefills: 0,
        decodeSteps: 0,
        peakActive: 0,
        peakQueued: 0,
    };
    constructor(modelPath, loaded, _options) {
        this.modelPath = modelPath;
        this.loaded = loaded;
        if (process.env.KGM_NATIVE_GPU_SIMULATED === "1") {
            this.simDelegate = new JsReferenceNativeServingBackend(modelPath, loaded, _options);
        }
    }
    isExecutable() {
        if (this.simDelegate) {
            return this.simDelegate.isExecutable();
        }
        return false;
    }
    async complete(_prompt, _options) {
        if (this.simDelegate) {
            const result = await this.simDelegate.complete(_prompt, _options);
            return {
                text: result.text,
                raw: {
                    ...(isRecord(result.raw) ? result.raw : { upstream: result.raw }),
                    nativeRuntime: {
                        ...(isRecord(result.raw) && isRecord(result.raw.nativeRuntime)
                            ? (result.raw.nativeRuntime)
                            : {}),
                        servingBackend: "native-gpu(sim→js-reference)",
                        simulated: true,
                        simulatedVia: "KGM_NATIVE_GPU_SIMULATED=1",
                        productionGpuKernels: false,
                    },
                },
            };
        }
        throw new Error(NATIVE_GPU_BACKEND_NOT_IMPLEMENTED_MSG);
    }
    async *streamComplete(_prompt, _options) {
        if (this.simDelegate) {
            for await (const event of this.simDelegate.streamComplete(_prompt, _options)) {
                if (event.type === "finished") {
                    yield {
                        type: "finished",
                        result: {
                            text: event.result.text,
                            raw: {
                                ...(isRecord(event.result.raw) ? event.result.raw : { upstream: event.result.raw }),
                                nativeRuntime: {
                                    servingBackend: "native-gpu(sim→js-reference)",
                                    simulated: true,
                                    simulatedVia: "KGM_NATIVE_GPU_SIMULATED=1",
                                    productionGpuKernels: false,
                                },
                            },
                        },
                    };
                }
                else {
                    yield event;
                }
            }
            return;
        }
        throw new Error(NATIVE_GPU_BACKEND_NOT_IMPLEMENTED_MSG);
    }
    metadata() {
        return this.loaded.metadata;
    }
    manifest() {
        return this.loaded.manifest;
    }
    executionBackend() {
        return this.loaded.executionBackend;
    }
    schedulerMetrics() {
        return this.schedulerStats;
    }
}
class NativeCoreServingBackend {
    kind = "native-core";
    modelPath;
    loaded;
    options;
    handlePromise;
    schedulerStats = {
        submitted: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        cycles: 0,
        prefills: 0,
        decodeSteps: 0,
        peakActive: 0,
        peakQueued: 0,
    };
    constructor(modelPath, loaded, options) {
        this.modelPath = modelPath;
        this.loaded = loaded;
        this.options = options;
    }
    isExecutable() {
        return this.loaded.manifest.backendHints.includes("native-core");
    }
    async complete(prompt, options) {
        let finalResult;
        for await (const event of this.streamComplete(prompt, options)) {
            if (event.type === "finished") {
                finalResult = event.result;
            }
        }
        if (!finalResult) {
            throw new Error("native_core_completion_missing_final_result");
        }
        return finalResult;
    }
    async *streamComplete(prompt, options) {
        const handle = await this.getHandle();
        this.schedulerStats.submitted += 1;
        try {
            if (handle.streamComplete) {
                const stream = await handle.streamComplete(prompt, options);
                for await (const event of stream) {
                    const normalized = this.normalizeStreamEvent(event);
                    if (normalized.type === "finished") {
                        this.schedulerStats.completed += 1;
                        this.captureResultMetrics(normalized.result);
                    }
                    yield normalized;
                }
                return;
            }
            if (!handle.complete) {
                throw new Error("Yueli KGM Runtime core binding missing completion methods");
            }
            yield {
                type: "started",
                model: options?.model,
            };
            const result = this.normalizeCompletionResult(await handle.complete(prompt, options));
            this.schedulerStats.completed += 1;
            this.captureResultMetrics(result);
            if (result.text) {
                yield {
                    type: "token",
                    text: result.text,
                    index: 0,
                };
            }
            yield {
                type: "finished",
                result,
            };
        }
        catch (error) {
            if (String(error?.message ?? "").includes("aborted") || String(error?.message ?? "").includes("cancelled")) {
                this.schedulerStats.cancelled += 1;
            }
            else {
                this.schedulerStats.failed += 1;
            }
            throw error;
        }
    }
    metadata() {
        return this.loaded.metadata;
    }
    manifest() {
        return this.loaded.manifest;
    }
    executionBackend() {
        return "native-core";
    }
    schedulerMetrics() {
        return { ...this.schedulerStats };
    }
    async getHandle() {
        if (!this.handlePromise) {
            this.handlePromise = this.initializeHandle();
        }
        return this.handlePromise;
    }
    async initializeHandle() {
        const binding = await loadNativeCoreBinding();
        const handle = await binding.createBackend({
            modelPath: this.modelPath,
            manifest: this.loaded.manifest,
            metadata: this.loaded.metadata,
            checkpoint: createCanonicalCheckpointForNativeCore(this.loaded),
            requestedExecutionBackend: this.loaded.executionBackend,
            options: serializeBackendOptions(this.options),
        });
        if (!handle || handle.backend !== "native-core") {
            throw new Error("Yueli KGM Runtime core binding invalid backend handle");
        }
        if (handle.isExecutable) {
            const executable = await handle.isExecutable();
            if (!executable) {
                throw new Error(`Yueli KGM Runtime core backend not executable:${this.loaded.metadata.format}`);
            }
        }
        const metrics = handle.schedulerMetrics ? await handle.schedulerMetrics() : undefined;
        if (metrics) {
            this.schedulerStats = normalizeSchedulerStats(metrics, this.schedulerStats);
        }
        return handle;
    }
    normalizeStreamEvent(event) {
        if (!event || typeof event !== "object" || typeof event.type !== "string") {
            throw new Error("Yueli KGM Runtime core binding invalid stream event");
        }
        if (event.type === "started") {
            return {
                type: "started",
                model: event.model,
            };
        }
        if (event.type === "token") {
            return {
                type: "token",
                text: typeof event.text === "string" ? event.text : "",
                index: typeof event.index === "number" ? event.index : 0,
                tokenId: typeof event.tokenId === "number" ? event.tokenId : undefined,
            };
        }
        if (event.type === "tool_call_delta") {
            return event;
        }
        if (event.type === "finished") {
            return {
                type: "finished",
                result: this.normalizeCompletionResult(event.result),
            };
        }
        throw new Error(`Yueli KGM Runtime core binding unknown stream event:${String(event.type)}`);
    }
    normalizeCompletionResult(result) {
        const normalized = {
            text: typeof result?.text === "string" ? result.text : "",
            raw: augmentNativeCoreRaw(result?.raw, this.loaded.metadata),
        };
        return normalized;
    }
    captureResultMetrics(result) {
        const nativeRuntime = extractNativeRuntimeRecord(result.raw);
        if (nativeRuntime?.scheduler) {
            const scheduler = nativeRuntime.scheduler;
            if (typeof scheduler.engineSchedulerCycles === "number") {
                this.schedulerStats.cycles = Math.max(this.schedulerStats.cycles, scheduler.engineSchedulerCycles);
            }
            if (typeof scheduler.requestSchedulerCycles === "number") {
                this.schedulerStats.decodeSteps = Math.max(this.schedulerStats.decodeSteps, scheduler.requestSchedulerCycles);
            }
            if (typeof scheduler.peakActiveRequests === "number") {
                this.schedulerStats.peakActive = Math.max(this.schedulerStats.peakActive, scheduler.peakActiveRequests);
            }
            if (typeof scheduler.peakQueuedRequests === "number") {
                this.schedulerStats.peakQueued = Math.max(this.schedulerStats.peakQueued, scheduler.peakQueuedRequests);
            }
            if (typeof scheduler.maxPrefillsPerTick === "number") {
                this.schedulerStats.prefills = Math.max(this.schedulerStats.prefills, scheduler.maxPrefillsPerTick);
            }
        }
    }
}
class JsReferenceNativeServingBackend {
    kind = "js-reference";
    modelPath;
    loaded;
    promptCache = new Map();
    sessionCache = new Map();
    promptCacheLimit;
    sessionCacheLimit;
    cachedKvPageBudget;
    cachedKvResidentPages = 0;
    cacheTouchSequence = 0;
    randomState;
    schedulerMaxBatchSize;
    schedulerMaxPrefillsPerTick;
    kvCacheMode;
    kvPageSize;
    schedulerRunning = false;
    pendingRequests = [];
    activeRequests = new Map();
    activeOrder = [];
    activeCursor = 0;
    requestSequence = 0;
    schedulerStats = {
        submitted: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        cycles: 0,
        prefills: 0,
        decodeSteps: 0,
        peakActive: 0,
        peakQueued: 0,
    };
    kvAllocator;
    constructor(modelPath, loaded, options) {
        this.modelPath = modelPath;
        this.loaded = loaded;
        this.promptCacheLimit = Math.max(1, options?.promptCacheLimit ?? 8);
        this.sessionCacheLimit = Math.max(1, options?.sessionCacheLimit ?? 64);
        this.schedulerMaxBatchSize = Math.max(1, options?.schedulerMaxBatchSize ?? 8);
        // 默认按 batch 容量入队：允许多请求同拍 prefill，避免 maxPrefills=1 卡死并发爬坡
        this.schedulerMaxPrefillsPerTick = Math.max(1, options?.schedulerMaxPrefillsPerTick ?? Math.min(4, this.schedulerMaxBatchSize));
        this.kvCacheMode = options?.kvCacheMode ?? "paged";
        this.kvPageSize = Math.max(1, options?.kvPageSize ?? 16);
        this.cachedKvPageBudget = options?.cachedKvPageBudget && options.cachedKvPageBudget > 0
            ? Math.trunc(options.cachedKvPageBudget)
            : undefined;
        this.randomState = options?.seed ?? 1;
        this.kvAllocator = this.kvCacheMode === "paged" ? new GlobalPagedKvAllocator() : undefined;
    }
    isExecutable() {
        return !!this.loaded.executableModel && !!this.loaded.tokenizer;
    }
    async complete(prompt, options) {
        let finalResult;
        for await (const event of this.streamComplete(prompt, options)) {
            if (event.type === "finished") {
                finalResult = event.result;
            }
        }
        if (!finalResult) {
            throw new Error("native_runtime_completion_missing_final_result");
        }
        return finalResult;
    }
    async *streamComplete(prompt, options) {
        if (!this.loaded.executableModel || !this.loaded.tokenizer) {
            throw new Error(`Yueli KGM Runtime model not executable:${this.loaded.metadata.format}`);
        }
        const request = this.enqueueRequest(prompt, options);
        try {
            yield* request.channel.iterate();
        }
        finally {
            if (!request.completed) {
                this.cancelRequest(request.id, new Error("native_runtime_request_cancelled"));
            }
        }
    }
    metadata() {
        return this.loaded.metadata;
    }
    manifest() {
        return this.loaded.manifest;
    }
    executionBackend() {
        return this.loaded.executionBackend;
    }
    schedulerMetrics() {
        return { ...this.schedulerStats };
    }
    enqueueRequest(prompt, options) {
        assertNotAborted(options?.signal);
        const request = {
            id: options?.requestId?.trim() || `native_req_${++this.requestSequence}`,
            prompt,
            options,
            enqueuedAt: Date.now(),
            channel: new AsyncEventChannel(),
            completed: false,
            cancelled: false,
        };
        if (options?.signal) {
            const abortHandler = () => {
                this.cancelRequest(request.id, new Error("native_runtime_request_aborted"));
            };
            options.signal.addEventListener("abort", abortHandler, { once: true });
            request.abortCleanup = () => options.signal?.removeEventListener("abort", abortHandler);
        }
        this.pendingRequests.push(request);
        this.schedulerStats.submitted += 1;
        this.schedulerStats.peakQueued = Math.max(this.schedulerStats.peakQueued, this.pendingRequests.length);
        this.ensureSchedulerLoop();
        return request;
    }
    cancelRequest(id, error) {
        const pendingIndex = this.pendingRequests.findIndex((request) => request.id === id);
        if (pendingIndex !== -1) {
            const [request] = this.pendingRequests.splice(pendingIndex, 1);
            if (request && !request.completed) {
                request.cancelled = true;
                request.completed = true;
                request.abortCleanup?.();
                this.schedulerStats.cancelled += 1;
                request.channel.fail(error);
            }
            return;
        }
        const active = this.activeRequests.get(id);
        if (!active || active.completed) {
            return;
        }
        active.cancelled = true;
        active.cancelError = error;
        this.ensureSchedulerLoop();
    }
    ensureSchedulerLoop() {
        if (this.schedulerRunning) {
            return;
        }
        this.schedulerRunning = true;
        queueMicrotask(() => {
            void this.runSchedulerLoop();
        });
    }
    async runSchedulerLoop() {
        try {
            while (this.pendingRequests.length > 0 || this.activeOrder.length > 0) {
                this.flushCancelledPending();
                this.admitPendingRequests();
                this.flushCancelledActive();
                if (this.activeOrder.length > 0) {
                    this.processDecodeCycle();
                    await yieldToEventLoop();
                    continue;
                }
                if (this.pendingRequests.length > 0) {
                    await yieldToEventLoop();
                }
            }
        }
        finally {
            this.schedulerRunning = false;
            if (this.pendingRequests.length > 0 || this.activeOrder.length > 0) {
                this.ensureSchedulerLoop();
            }
        }
    }
    admitPendingRequests() {
        let admitted = 0;
        const admitLimit = computeAdmitLimit({
            activeCount: this.activeOrder.length,
            pendingCount: this.pendingRequests.length,
            maxBatchSize: this.schedulerMaxBatchSize,
            maxPrefillsPerTick: this.schedulerMaxPrefillsPerTick,
        });
        while (this.pendingRequests.length > 0 && admitted < admitLimit) {
            const request = this.pendingRequests.shift();
            if (request.completed || request.cancelled) {
                continue;
            }
            this.activeRequests.set(request.id, request);
            this.activeOrder.push(request.id);
            this.schedulerStats.peakActive = Math.max(this.schedulerStats.peakActive, this.activeOrder.length);
            request.channel.push({
                type: "started",
                model: request.options?.model,
            });
            try {
                request.state = this.prepareRequestState(request);
                this.schedulerStats.prefills += 1;
            }
            catch (error) {
                this.failRequest(request, error);
            }
            admitted += 1;
        }
    }
    prepareRequestState(request) {
        if (!this.loaded.executableModel || !this.loaded.tokenizer) {
            throw new Error(`Yueli KGM Runtime model not executable:${this.loaded.metadata.format}`);
        }
        const tokenizer = this.loaded.tokenizer;
        const queueWaitMs = Date.now() - request.enqueuedAt;
        const activeRequestsAtAdmission = Math.max(0, this.activeOrder.length - 1);
        const queuedRequestsAtAdmission = this.pendingRequests.length;
        const start = Date.now();
        assertNotAborted(request.options?.signal);
        const promptTokens = tokenizer.encode(request.prompt, {
            addBos: request.prompt.length === 0 || typeof tokenizer.spec.bosTokenId === "number",
        });
        if (promptTokens.length === 0 && typeof tokenizer.spec.bosTokenId === "number") {
            promptTokens.push(tokenizer.spec.bosTokenId);
        }
        if (promptTokens.length === 0) {
            throw new Error("native_runtime_prompt_encoding_empty");
        }
        const cache = this.loaded.executableModel.createCache(this.kvCacheMode === "paged"
            ? { kind: "paged", pageSize: this.kvPageSize, allocator: this.kvAllocator }
            : { kind: "dense" });
        const requestId = request.options?.requestId;
        const sessionId = request.options?.sessionId?.trim() || undefined;
        let cacheSource = "cold";
        let prefillTokens = promptTokens.length;
        let logits;
        const promptCached = this.getPromptCache(promptTokens);
        if (promptCached) {
            cache.restore(promptCached.snapshot);
            logits = new Float32Array(promptCached.lastLogits);
            cacheSource = "prompt-cache";
            prefillTokens = 0;
        }
        else {
            const sessionCached = sessionId ? this.getSessionPrefixCache(sessionId, promptTokens) : null;
            let startIndex = 0;
            if (sessionCached) {
                cache.restore(sessionCached.snapshot);
                logits = new Float32Array(sessionCached.lastLogits);
                startIndex = sessionCached.promptTokens.length;
                cacheSource = "session-prefix";
                prefillTokens = Math.max(0, promptTokens.length - startIndex);
            }
            for (let index = startIndex; index < promptTokens.length; index += 1) {
                assertNotAborted(request.options?.signal);
                logits = this.loaded.executableModel.forwardToken(promptTokens[index], cache);
            }
            this.setPromptCache(promptTokens, cache.snapshot(), logits);
        }
        if (sessionId) {
            this.setSessionCache(sessionId, promptTokens, cache.snapshot(), logits);
        }
        return {
            start,
            queueWaitMs,
            activeRequestsAtAdmission,
            queuedRequestsAtAdmission,
            tokenizer,
            promptTokens,
            cache,
            logits: new Float32Array(logits),
            generated: [],
            output: "",
            ttftMs: 0,
            finishReason: "length",
            maxTokens: Math.max(1, request.options?.maxTokens ?? 64),
            temperature: request.options?.temperature ?? 0.2,
            topK: request.options?.topK ?? 0,
            topP: request.options?.topP ?? 1,
            repetitionPenalty: request.options?.repetitionPenalty ?? 1,
            stop: request.options?.stop ?? [],
            requestId,
            sessionId,
            cacheSource,
            prefillTokens,
            schedulerCycles: 0,
        };
    }
    processDecodeCycle() {
        const batch = this.selectDecodeBatch();
        if (batch.length === 0) {
            return;
        }
        this.schedulerStats.cycles += 1;
        for (const request of batch) {
            if (request.completed) {
                continue;
            }
            if (request.cancelled) {
                this.failRequest(request, request.cancelError ?? new Error("native_runtime_request_cancelled"));
                continue;
            }
            try {
                this.decodeSingleStep(request);
            }
            catch (error) {
                this.failRequest(request, error);
            }
        }
    }
    selectDecodeBatch() {
        const selected = [];
        if (this.activeOrder.length === 0) {
            return selected;
        }
        if (this.activeCursor >= this.activeOrder.length) {
            this.activeCursor = 0;
        }
        const limit = Math.min(this.schedulerMaxBatchSize, this.activeOrder.length);
        let scanned = 0;
        while (selected.length < limit && scanned < this.activeOrder.length) {
            if (this.activeCursor >= this.activeOrder.length) {
                this.activeCursor = 0;
            }
            const id = this.activeOrder[this.activeCursor++];
            scanned += 1;
            const request = this.activeRequests.get(id);
            if (request && !request.completed) {
                selected.push(request);
            }
        }
        return selected;
    }
    decodeSingleStep(request) {
        const state = request.state;
        if (!state || !this.loaded.executableModel) {
            throw new Error(`native_runtime_request_state_missing:${request.id}`);
        }
        assertNotAborted(request.options?.signal);
        state.schedulerCycles += 1;
        const sampled = sampleToken(state.logits, {
            temperature: state.temperature,
            topK: state.topK,
            topP: state.topP,
            repetitionPenalty: state.repetitionPenalty,
            recentTokens: [...state.promptTokens, ...state.generated],
            nextRandom: () => this.nextRandom(),
        });
        if (state.generated.length === 0) {
            state.ttftMs = Date.now() - state.start;
        }
        if (typeof state.tokenizer.spec.eosTokenId === "number" && sampled === state.tokenizer.spec.eosTokenId) {
            state.finishReason = "eos";
            this.finishRequest(request);
            return;
        }
        state.generated.push(sampled);
        const nextOutput = state.tokenizer.decode(state.generated, { skipSpecialTokens: true });
        if (state.stop.length > 0) {
            const stopText = findStop(nextOutput, state.stop);
            if (stopText) {
                const truncated = nextOutput.slice(0, stopText.index);
                const delta = truncated.slice(state.output.length);
                state.output = truncated;
                if (delta) {
                    request.channel.push({
                        type: "token",
                        text: delta,
                        index: state.generated.length - 1,
                        tokenId: sampled,
                    });
                }
                state.finishReason = "stop";
                this.finishRequest(request);
                return;
            }
        }
        const delta = nextOutput.slice(state.output.length);
        state.output = nextOutput;
        if (delta) {
            request.channel.push({
                type: "token",
                text: delta,
                index: state.generated.length - 1,
                tokenId: sampled,
            });
        }
        this.schedulerStats.decodeSteps += 1;
        if (state.generated.length >= state.maxTokens) {
            state.finishReason = "length";
            this.finishRequest(request);
            return;
        }
        assertNotAborted(request.options?.signal);
        state.logits = this.loaded.executableModel.forwardToken(sampled, state.cache);
    }
    finishRequest(request) {
        const state = request.state;
        if (!state || request.completed) {
            return;
        }
        request.completed = true;
        request.abortCleanup?.();
        const kvResidentBytes = state.cache.residentBytes();
        const kvAllocatedPages = state.cache.allocatedPages();
        state.cache.release();
        this.schedulerStats.completed += 1;
        const elapsed = Date.now() - state.start;
        const generatedTokens = state.generated.length;
        const tpotMs = generatedTokens > 1
            ? Math.max(0, elapsed - state.ttftMs) / (generatedTokens - 1)
            : elapsed;
        const raw = {
            text: state.output,
            promptTokens: state.promptTokens.length,
            prefillTokens: state.prefillTokens,
            generatedTokens,
            finishReason: state.finishReason,
            ttftMs: state.ttftMs,
            tpotMs,
            tokensPerSecond: generatedTokens > 0 ? generatedTokens / Math.max(elapsed / 1000, 0.001) : 0,
            device: "cpu",
            format: this.loaded.format,
            requestId: state.requestId,
            sessionId: state.sessionId,
            cacheSource: state.cacheSource,
            queueWaitMs: state.queueWaitMs,
            scheduler: {
                continuousBatching: true,
                servingBackend: this.kind,
                maxBatchSize: this.schedulerMaxBatchSize,
                maxPrefillsPerTick: this.schedulerMaxPrefillsPerTick,
                kvCacheKind: this.kvCacheMode,
                kvPageSize: this.kvCacheMode === "paged" ? this.kvPageSize : undefined,
                activeRequestsAtAdmission: state.activeRequestsAtAdmission,
                queuedRequestsAtAdmission: state.queuedRequestsAtAdmission,
                requestSchedulerCycles: state.schedulerCycles,
                engineSchedulerCycles: this.schedulerStats.cycles,
                peakActiveRequests: this.schedulerStats.peakActive,
                peakQueuedRequests: this.schedulerStats.peakQueued,
            },
            memory: {
                kvResidentBytes,
                kvAllocatedPages,
                cachedKvResidentPages: this.kvCacheMode === "paged" ? this.cachedKvResidentPages : undefined,
                cachedKvPageBudget: this.kvCacheMode === "paged" ? this.cachedKvPageBudget : undefined,
            },
            metadata: this.loaded.metadata,
        };
        request.channel.push({
            type: "finished",
            result: {
                text: state.output,
                raw: {
                    nativeRuntime: raw,
                },
            },
        });
        request.channel.close();
        this.removeActiveRequest(request.id);
    }
    failRequest(request, error) {
        if (request.completed) {
            return;
        }
        request.completed = true;
        request.abortCleanup?.();
        request.state?.cache.release();
        if (request.cancelled || error.message.includes("aborted") || error.message.includes("cancelled")) {
            this.schedulerStats.cancelled += 1;
        }
        else {
            this.schedulerStats.failed += 1;
        }
        request.channel.fail(error);
        this.removeActiveRequest(request.id);
    }
    removeActiveRequest(id) {
        const index = this.activeOrder.indexOf(id);
        if (index !== -1) {
            this.activeOrder.splice(index, 1);
            if (index < this.activeCursor) {
                this.activeCursor = Math.max(0, this.activeCursor - 1);
            }
            if (this.activeCursor >= this.activeOrder.length) {
                this.activeCursor = 0;
            }
        }
        this.activeRequests.delete(id);
    }
    flushCancelledPending() {
        if (this.pendingRequests.length === 0) {
            return;
        }
        const remaining = [];
        for (const request of this.pendingRequests) {
            if (request.cancelled && !request.completed) {
                request.completed = true;
                request.abortCleanup?.();
                this.schedulerStats.cancelled += 1;
                request.channel.fail(request.cancelError ?? new Error("native_runtime_request_cancelled"));
                continue;
            }
            remaining.push(request);
        }
        this.pendingRequests = remaining;
    }
    flushCancelledActive() {
        for (const request of Array.from(this.activeRequests.values())) {
            if (request.cancelled && !request.completed) {
                this.failRequest(request, request.cancelError ?? new Error("native_runtime_request_cancelled"));
            }
        }
    }
    getPromptCache(tokens) {
        const key = hashTokens(tokens);
        const entry = this.promptCache.get(key) ?? null;
        if (entry) {
            this.touchPromptCache(entry);
        }
        return entry;
    }
    setPromptCache(tokens, snapshot, lastLogits) {
        const key = hashTokens(tokens);
        const existing = this.promptCache.get(key);
        if (existing) {
            this.cachedKvResidentPages = Math.max(0, this.cachedKvResidentPages - existing.pageCount);
        }
        const entry = {
            key,
            snapshot,
            lastLogits: new Float32Array(lastLogits),
            pageCount: this.kvCacheMode === "paged" ? countKvSnapshotPages(snapshot) : 0,
            lastTouched: this.nextCacheTouch(),
        };
        this.promptCache.set(key, entry);
        this.cachedKvResidentPages += entry.pageCount;
        this.enforcePromptCacheLimit();
        this.enforceCachedKvBudget();
    }
    getSessionPrefixCache(sessionId, promptTokens) {
        const entry = this.sessionCache.get(sessionId);
        if (!entry || entry.promptTokens.length > promptTokens.length) {
            return null;
        }
        for (let index = 0; index < entry.promptTokens.length; index += 1) {
            if (entry.promptTokens[index] !== promptTokens[index]) {
                return null;
            }
        }
        this.touchSessionCache(entry);
        return entry;
    }
    setSessionCache(sessionId, promptTokens, snapshot, lastLogits) {
        const existing = this.sessionCache.get(sessionId);
        if (existing) {
            this.cachedKvResidentPages = Math.max(0, this.cachedKvResidentPages - existing.pageCount);
        }
        const entry = {
            sessionId,
            promptTokens: [...promptTokens],
            snapshot,
            lastLogits: new Float32Array(lastLogits),
            pageCount: this.kvCacheMode === "paged" ? countKvSnapshotPages(snapshot) : 0,
            lastTouched: this.nextCacheTouch(),
        };
        this.sessionCache.set(sessionId, entry);
        this.cachedKvResidentPages += entry.pageCount;
        this.enforceSessionCacheLimit();
        this.enforceCachedKvBudget();
    }
    enforcePromptCacheLimit() {
        while (this.promptCache.size > this.promptCacheLimit) {
            const oldestKey = this.findOldestPromptCacheKey();
            if (!oldestKey) {
                break;
            }
            this.deletePromptCache(oldestKey);
        }
    }
    enforceSessionCacheLimit() {
        while (this.sessionCache.size > this.sessionCacheLimit) {
            const oldestKey = this.findOldestSessionCacheKey();
            if (!oldestKey) {
                break;
            }
            this.deleteSessionCache(oldestKey);
        }
    }
    enforceCachedKvBudget() {
        if (!this.cachedKvPageBudget || this.cachedKvPageBudget <= 0) {
            return;
        }
        while (this.cachedKvResidentPages > this.cachedKvPageBudget) {
            const oldestPrompt = this.findOldestPromptCacheEntry();
            const oldestSession = this.findOldestSessionCacheEntry();
            if (!oldestPrompt && !oldestSession) {
                break;
            }
            if (!oldestSession || (oldestPrompt && oldestPrompt.lastTouched <= oldestSession.lastTouched)) {
                this.deletePromptCache(oldestPrompt.key);
                continue;
            }
            this.deleteSessionCache(oldestSession.sessionId);
        }
    }
    deletePromptCache(key) {
        const existing = this.promptCache.get(key);
        if (!existing) {
            return;
        }
        this.promptCache.delete(key);
        this.cachedKvResidentPages = Math.max(0, this.cachedKvResidentPages - existing.pageCount);
    }
    deleteSessionCache(sessionId) {
        const existing = this.sessionCache.get(sessionId);
        if (!existing) {
            return;
        }
        this.sessionCache.delete(sessionId);
        this.cachedKvResidentPages = Math.max(0, this.cachedKvResidentPages - existing.pageCount);
    }
    findOldestPromptCacheKey() {
        return this.findOldestPromptCacheEntry()?.key;
    }
    findOldestSessionCacheKey() {
        return this.findOldestSessionCacheEntry()?.sessionId;
    }
    findOldestPromptCacheEntry() {
        let oldest;
        for (const entry of this.promptCache.values()) {
            if (!oldest || entry.lastTouched < oldest.lastTouched) {
                oldest = entry;
            }
        }
        return oldest;
    }
    findOldestSessionCacheEntry() {
        let oldest;
        for (const entry of this.sessionCache.values()) {
            if (!oldest || entry.lastTouched < oldest.lastTouched) {
                oldest = entry;
            }
        }
        return oldest;
    }
    touchPromptCache(entry) {
        entry.lastTouched = this.nextCacheTouch();
    }
    touchSessionCache(entry) {
        entry.lastTouched = this.nextCacheTouch();
    }
    nextCacheTouch() {
        this.cacheTouchSequence += 1;
        return this.cacheTouchSequence;
    }
    nextRandom() {
        this.randomState = (1664525 * this.randomState + 1013904223) >>> 0;
        return this.randomState / 0xffffffff;
    }
}
class AsyncEventChannel {
    queue = [];
    waiters = [];
    closed = false;
    error;
    push(value) {
        if (this.closed || this.error) {
            return;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter.resolve({ value, done: false });
            return;
        }
        this.queue.push(value);
    }
    close() {
        if (this.closed || this.error) {
            return;
        }
        this.closed = true;
        while (this.waiters.length > 0) {
            this.waiters.shift().resolve({ value: undefined, done: true });
        }
    }
    fail(error) {
        if (this.closed || this.error) {
            return;
        }
        this.error = error;
        while (this.waiters.length > 0) {
            this.waiters.shift().reject(error);
        }
    }
    async *iterate() {
        while (true) {
            if (this.queue.length > 0) {
                yield this.queue.shift();
                continue;
            }
            if (this.error) {
                throw this.error;
            }
            if (this.closed) {
                return;
            }
            const next = await new Promise((resolve, reject) => {
                this.waiters.push({
                    resolve,
                    reject,
                });
            });
            if (next.done) {
                return;
            }
            yield next.value;
        }
    }
}
function serializeBackendOptions(options) {
    if (!options) {
        return {};
    }
    return {
        promptCacheLimit: options.promptCacheLimit,
        sessionCacheLimit: options.sessionCacheLimit,
        schedulerMaxBatchSize: options.schedulerMaxBatchSize,
        schedulerMaxPrefillsPerTick: options.schedulerMaxPrefillsPerTick,
        kvCacheMode: options.kvCacheMode,
        kvPageSize: options.kvPageSize,
        cachedKvPageBudget: options.cachedKvPageBudget,
        servingBackend: options.servingBackend,
        seed: options.seed,
    };
}
function augmentNativeCoreRaw(raw, metadata) {
    if (!raw || typeof raw !== "object") {
        return raw;
    }
    const record = raw;
    const nativeRuntime = extractNativeRuntimeRecord(raw);
    if (!nativeRuntime) {
        return raw;
    }
    const scheduler = typeof nativeRuntime.scheduler === "object" && nativeRuntime.scheduler
        ? { ...nativeRuntime.scheduler }
        : {};
    scheduler.servingBackend = "native-core";
    return {
        ...record,
        nativeRuntime: {
            ...nativeRuntime,
            metadata: nativeRuntime.metadata ?? metadata,
            scheduler,
        },
    };
}
function extractNativeRuntimeRecord(raw) {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }
    const record = raw;
    return record.nativeRuntime && typeof record.nativeRuntime === "object"
        ? record.nativeRuntime
        : undefined;
}
function normalizeSchedulerStats(value, fallback) {
    return {
        submitted: typeof value.submitted === "number" ? value.submitted : fallback.submitted,
        completed: typeof value.completed === "number" ? value.completed : fallback.completed,
        failed: typeof value.failed === "number" ? value.failed : fallback.failed,
        cancelled: typeof value.cancelled === "number" ? value.cancelled : fallback.cancelled,
        cycles: typeof value.cycles === "number" ? value.cycles : fallback.cycles,
        prefills: typeof value.prefills === "number" ? value.prefills : fallback.prefills,
        decodeSteps: typeof value.decodeSteps === "number" ? value.decodeSteps : fallback.decodeSteps,
        peakActive: typeof value.peakActive === "number" ? value.peakActive : fallback.peakActive,
        peakQueued: typeof value.peakQueued === "number" ? value.peakQueued : fallback.peakQueued,
    };
}
function normalizeServingBackendPreference(preference) {
    if (preference === "js-reference" || preference === "native-core" || preference === "native-gpu") {
        return preference;
    }
    const configured = process.env.KGM_NATIVE_SERVING_BACKEND?.trim();
    if (configured === "js-reference" || configured === "native-core" || configured === "native-gpu") {
        return configured;
    }
    return "auto";
}
function hashTokens(tokens) {
    return createHash("sha256").update(tokens.join(",")).digest("hex");
}
function findStop(value, stops) {
    let best = null;
    for (const stop of stops) {
        const index = value.indexOf(stop);
        if (index !== -1 && (best === null || index < best)) {
            best = index;
        }
    }
    return best === null ? null : { index: best };
}
function sampleToken(logits, options) {
    const adjusted = new Float32Array(logits);
    if (options.repetitionPenalty > 0 && options.repetitionPenalty !== 1) {
        for (const token of options.recentTokens) {
            if (token < 0 || token >= adjusted.length) {
                continue;
            }
            adjusted[token] = adjusted[token] >= 0
                ? adjusted[token] / options.repetitionPenalty
                : adjusted[token] * options.repetitionPenalty;
        }
    }
    if (options.temperature <= 0) {
        return argmax(adjusted);
    }
    for (let index = 0; index < adjusted.length; index += 1) {
        adjusted[index] /= options.temperature;
    }
    const candidates = Array.from(adjusted.entries()).map(([token, logit]) => ({ token, logit }));
    candidates.sort((left, right) => right.logit - left.logit);
    let filtered = candidates;
    if (options.topK > 0) {
        filtered = filtered.slice(0, Math.max(1, options.topK));
    }
    const probabilities = softmax(filtered.map((item) => item.logit));
    if (options.topP > 0 && options.topP < 1) {
        let cumulative = 0;
        let cutoff = filtered.length;
        for (let index = 0; index < probabilities.length; index += 1) {
            cumulative += probabilities[index] ?? 0;
            if (cumulative >= options.topP) {
                cutoff = index + 1;
                break;
            }
        }
        filtered = filtered.slice(0, cutoff);
    }
    const finalProbabilities = softmax(filtered.map((item) => item.logit));
    const random = options.nextRandom();
    let cumulative = 0;
    for (let index = 0; index < filtered.length; index += 1) {
        cumulative += finalProbabilities[index] ?? 0;
        if (random <= cumulative || index === filtered.length - 1) {
            return filtered[index].token;
        }
    }
    return filtered[filtered.length - 1]?.token ?? 0;
}
function argmax(values) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index] ?? Number.NEGATIVE_INFINITY;
        if (value > bestValue) {
            bestValue = value;
            bestIndex = index;
        }
    }
    return bestIndex;
}
function assertNotAborted(signal) {
    if (signal?.aborted) {
        throw new Error("native_runtime_request_aborted");
    }
}
async function yieldToEventLoop() {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
}
