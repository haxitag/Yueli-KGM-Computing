import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { HttpLlmClient } from "../llm/client.js";
import { streamCompletion } from "../llm/client.js";
import { getNativeCoreBindingStatus } from "../native/bindings.js";
import { NativeRuntimeEngine } from "../native/engine.js";
import { generateId } from "../utils/id.js";
import { parseKgmfile, toModelRequests } from "./kgmfile.js";
import { detectJangInModelDirectory } from "../native/jang.js";
/** 分片存储目录名（相对 stateRoot） */
const STORE_ARTIFACTS_DIR = "artifacts";
const STORE_RUNTIMES_DIR = "runtimes";
const STORE_MANIFEST_FILE = "manifest.json";
/**
 * 解析托管模型状态根目录。
 * - 若配置为以 `.json` 结尾的路径（旧版单文件 `catalog.json`），则使用同目录下的 `store/` 作为分片根目录；
 *   若该单文件仍存在，则交由迁移逻辑读入并删除。
 * - 否则将配置路径视为分片根目录（默认 `data/models/store`）。
 */
function resolveConfiguredModelStateRoot(configured) {
    const resolved = path.resolve(configured);
    if (resolved.endsWith(".json")) {
        const stateRoot = path.join(path.dirname(resolved), "store");
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return { stateRoot, legacyMonolithicCatalog: resolved };
        }
        return { stateRoot };
    }
    return { stateRoot: resolved };
}
export class ManagedModelManager {
    /** 分片存储根目录（`artifacts/`、`runtimes/`、`manifest.json`） */
    stateRoot;
    artifactDir;
    state;
    processes = new Map();
    nativeRuntimes = new Map();
    executionState = new Map();
    healthIntervalMs;
    healthTimer;
    constructor(options) {
        const configured = options?.statePath ?? process.env.KGM_MODEL_STATE_PATH ?? "data/models/store";
        const { stateRoot, legacyMonolithicCatalog } = resolveConfiguredModelStateRoot(configured);
        this.stateRoot = stateRoot;
        this.artifactDir = path.resolve(options?.artifactDir ?? process.env.KGM_MODEL_ARTIFACT_DIR ?? "data/model-artifacts");
        this.healthIntervalMs = parseNumber(process.env.KGM_MODEL_HEALTHCHECK_INTERVAL_MS) ?? 15000;
        fs.mkdirSync(this.stateRoot, { recursive: true });
        fs.mkdirSync(this.artifactDir, { recursive: true });
        if (legacyMonolithicCatalog) {
            this.migrateLegacyMonolithicCatalog(legacyMonolithicCatalog);
        }
        this.state = this.loadState();
        for (const runtime of this.state.runtimes) {
            if (runtime.runtime === "native" && runtime.status !== "stopped") {
                runtime.status = "stopped";
                runtime.healthStatus = "unknown";
                runtime.pid = undefined;
            }
        }
        for (const runtime of this.state.runtimes) {
            this.ensureRuntimeState(runtime);
        }
        this.persist();
        this.startHealthChecker();
    }
    close() {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = undefined;
        }
        this.nativeRuntimes.clear();
    }
    listArtifacts() {
        return [...this.state.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    getArtifact(id) {
        return this.state.artifacts.find((item) => item.id === id);
    }
    listRuntimes() {
        return [...this.state.runtimes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    listModels() {
        const runtimeMap = new Map();
        for (const runtime of this.state.runtimes) {
            runtimeMap.set(runtime.modelName, runtime);
        }
        const artifactSummaries = this.state.artifacts.map((artifact) => {
            const runtime = runtimeMap.get(artifact.modelName);
            return {
                id: runtime?.id ?? artifact.id,
                modelName: artifact.modelName,
                name: artifact.name,
                sourceType: artifact.sourceType,
                artifactId: artifact.id,
                runtimeId: runtime?.id,
                runtime: runtime?.runtime,
                status: runtime?.status ?? artifact.status,
                running: runtime?.status === "running",
                localPath: artifact.localPath,
                baseUrl: runtime?.baseUrl,
                metrics: runtime ? this.getRuntimeMetrics(runtime.id) : undefined,
                notes: [...artifact.notes, ...(runtime?.notes ?? [])],
            };
        });
        const seenArtifacts = new Set(artifactSummaries.map((item) => item.runtimeId ?? item.artifactId));
        const runtimeOnly = this.state.runtimes
            .filter((runtime) => !seenArtifacts.has(runtime.id))
            .map((runtime) => ({
            id: runtime.id,
            modelName: runtime.modelName,
            name: runtime.name,
            runtimeId: runtime.id,
            runtime: runtime.runtime,
            artifactId: runtime.artifactId,
            status: runtime.status,
            running: runtime.status === "running",
            baseUrl: runtime.baseUrl,
            metrics: this.getRuntimeMetrics(runtime.id),
            notes: [...runtime.notes],
        }));
        return [...artifactSummaries, ...runtimeOnly].sort((a, b) => a.modelName.localeCompare(b.modelName));
    }
    listRunningModels() {
        return this.listModels().filter((item) => item.running);
    }
    getRuntime(id) {
        return this.state.runtimes.find((item) => item.id === id);
    }
    getRuntimeMetrics(id) {
        return this.executionState.get(id)?.metrics;
    }
    async probeAllRuntimes() {
        const results = [];
        for (const runtime of this.state.runtimes) {
            results.push(await this.probeRuntime(runtime.id));
        }
        return results;
    }
    async probeRuntime(id) {
        const runtime = this.requireRuntime(id);
        const state = this.ensureRuntimeState(runtime);
        const now = new Date().toISOString();
        if (runtime.status === "stopped") {
            this.patchRuntime(id, { healthStatus: "unknown", lastProbeAt: now });
            return this.requireRuntime(id);
        }
        const pidAlive = runtime.pid ? isPidAlive(runtime.pid) : undefined;
        const endpointHealthy = await this.probeEndpoint(runtime);
        const nextHealth = endpointHealthy
            ? "healthy"
            : pidAlive === false
                ? "unavailable"
                : "degraded";
        if (nextHealth === "healthy") {
            state.metrics.circuitState = "closed";
            state.metrics.consecutiveFailures = 0;
            state.metrics.circuitOpenUntil = undefined;
            state.circuitOpenUntil = undefined;
        }
        const nextStatus = nextHealth === "unavailable" && runtime.runtime !== "openai-compatible"
            ? "error"
            : runtime.status;
        this.patchRuntime(id, {
            status: nextStatus,
            healthStatus: nextHealth,
            lastProbeAt: now,
            lastError: nextHealth === "healthy" ? undefined : runtime.lastError,
        });
        return this.requireRuntime(id);
    }
    getPrometheusMetrics() {
        const lines = [];
        lines.push("# HELP kgm_runtime_requests_total Total managed runtime requests.");
        lines.push("# TYPE kgm_runtime_requests_total counter");
        lines.push("# HELP kgm_runtime_latency_ms Average latency in ms.");
        lines.push("# TYPE kgm_runtime_latency_ms gauge");
        lines.push("# HELP kgm_runtime_ttft_ms Average time to first token in ms.");
        lines.push("# TYPE kgm_runtime_ttft_ms gauge");
        lines.push("# HELP kgm_runtime_tokens_per_second Average output tokens per second.");
        lines.push("# TYPE kgm_runtime_tokens_per_second gauge");
        lines.push("# HELP kgm_runtime_kv_resident_bytes Average resident KV cache bytes.");
        lines.push("# TYPE kgm_runtime_kv_resident_bytes gauge");
        lines.push("# HELP kgm_runtime_inflight Current inflight requests.");
        lines.push("# TYPE kgm_runtime_inflight gauge");
        lines.push("# HELP kgm_runtime_queue Current queued requests.");
        lines.push("# TYPE kgm_runtime_queue gauge");
        lines.push("# HELP kgm_runtime_circuit_state Circuit state encoded as closed=0 half_open=1 open=2.");
        lines.push("# TYPE kgm_runtime_circuit_state gauge");
        for (const runtime of this.state.runtimes) {
            const metrics = this.getRuntimeMetrics(runtime.id) ?? createRuntimeMetrics(runtime);
            const labels = `runtime_id="${runtime.id}",model="${escapeMetricLabel(runtime.modelName)}",kind="${runtime.runtime}"`;
            lines.push(`kgm_runtime_requests_total{${labels},status="success"} ${metrics.successesTotal}`);
            lines.push(`kgm_runtime_requests_total{${labels},status="error"} ${metrics.errorsTotal}`);
            lines.push(`kgm_runtime_requests_total{${labels},status="rejected"} ${metrics.queueRejectedTotal}`);
            lines.push(`kgm_runtime_latency_ms{${labels}} ${metrics.avgLatencyMs}`);
            lines.push(`kgm_runtime_ttft_ms{${labels}} ${metrics.avgTtftMs ?? 0}`);
            lines.push(`kgm_runtime_tokens_per_second{${labels}} ${metrics.avgOutputTokensPerSecond}`);
            lines.push(`kgm_runtime_kv_resident_bytes{${labels}} ${metrics.avgKvResidentBytes ?? 0}`);
            lines.push(`kgm_runtime_inflight{${labels}} ${metrics.inflightRequests}`);
            lines.push(`kgm_runtime_queue{${labels}} ${metrics.queuedRequests}`);
            lines.push(`kgm_runtime_circuit_state{${labels}} ${circuitStateValue(metrics.circuitState)}`);
        }
        return `${lines.join("\n")}\n`;
    }
    listOpenAiModels(defaultModel, defaultOwner = "kgm") {
        const created = Math.floor(Date.now() / 1000);
        const seen = new Set();
        const models = [];
        if (defaultModel) {
            seen.add(defaultModel);
            models.push({
                id: defaultModel,
                object: "model",
                created,
                owned_by: defaultOwner,
            });
        }
        // 云端推理服务商支持的模型列表
        const cloudModels = [
            // OpenAI
            { id: "gpt-5.4", owned_by: "openai" },
            { id: "gpt-5.5", owned_by: "openai" },
            { id: "gpt-oss", owned_by: "openai" },
            // Zhipu
            { id: "glm-5.0", owned_by: "zhipu" },
            { id: "glm-5.1", owned_by: "zhipu" },
            // Xiaomi
            { id: "mimo-2.5", owned_by: "xiaomi" },
            // Google Gemini
            { id: "gemini-3.0", owned_by: "google" },
            { id: "gemini-3.1", owned_by: "google" },
            // Anthropic
            { id: "claude-sonnet-4.6", owned_by: "anthropic" },
            { id: "claude-opus-4.7", owned_by: "anthropic" },
            // Moonshot / Kimi
            { id: "kimi-2.5", owned_by: "moonshot" },
            { id: "kimi-2.6", owned_by: "moonshot" },
            // Minimax
            { id: "minimax-2.5", owned_by: "minimax" },
            { id: "minimax-2.7", owned_by: "minimax" },
            // DeepSeek
            { id: "deepseek-3.2", owned_by: "deepseek" },
            { id: "deepseek-v4", owned_by: "deepseek" },
            // Qwen / Aliyun
            { id: "qwen-3.5", owned_by: "qwen" },
            { id: "qwen-3.6", owned_by: "qwen" },
            { id: "qwen-max", owned_by: "aliyun" },
            { id: "qwen-plus", owned_by: "aliyun" },
            // ModelScope
            { id: "deepseek-r1", owned_by: "modelscope" },
            { id: "llama3-70b", owned_by: "modelscope" },
        ];
        for (const cloudModel of cloudModels) {
            if (!seen.has(cloudModel.id)) {
                seen.add(cloudModel.id);
                models.push({
                    id: cloudModel.id,
                    object: "model",
                    created,
                    owned_by: cloudModel.owned_by,
                    kgm: {
                        cloud: true,
                        provider: cloudModel.owned_by,
                    },
                });
            }
        }
        for (const runtime of this.state.runtimes) {
            if (runtime.status !== "running" || seen.has(runtime.modelName)) {
                continue;
            }
            seen.add(runtime.modelName);
            models.push({
                id: runtime.modelName,
                object: "model",
                created,
                owned_by: runtime.runtime,
                kgm: {
                    managed: true,
                    runtime: runtime.runtime,
                    runtimeId: runtime.id,
                    baseUrl: runtime.baseUrl,
                },
            });
        }
        for (const artifact of this.state.artifacts) {
            if (seen.has(artifact.modelName)) {
                continue;
            }
            seen.add(artifact.modelName);
            models.push({
                id: artifact.modelName,
                object: "model",
                created,
                owned_by: artifact.sourceType,
                kgm: {
                    managed: true,
                    artifactId: artifact.id,
                    sourceType: artifact.sourceType,
                    status: artifact.status,
                    localPath: artifact.localPath,
                },
            });
        }
        return models;
    }
    findRuntimeForModel(modelName) {
        return this.state.runtimes.find((runtime) => runtime.status === "running" && runtime.modelName === modelName);
    }
    async completeWithManagedRuntime(modelName, prompt, options) {
        const runtime = this.findRuntimeForModel(modelName);
        if (!runtime) {
            return null;
        }
        return this.executeRuntimeCompletion(runtime, prompt, options);
    }
    streamWithManagedRuntime(modelName, prompt, options) {
        const runtime = this.findRuntimeForModel(modelName);
        if (!runtime) {
            return null;
        }
        return this.executeRuntimeCompletionStream(runtime, prompt, options);
    }
    async createModel(request) {
        const spec = request.spec ??
            (request.kgmfile ? parseKgmfile(request.kgmfile) : undefined);
        const requests = spec
            ? toModelRequests(spec)
            : {
                pull: request.pull ?? {},
                runtime: request.runtime ?? { runtime: "openai-compatible" },
            };
        const artifact = await this.pull(requests.pull);
        const runtime = this.createRuntime({
            ...requests.runtime,
            runtime: request.runtime?.runtime
                ?? (requests.runtime.runtime === "openai-compatible" && artifact.runtimeHints.includes("native")
                    ? "native"
                    : requests.runtime.runtime),
            artifactId: artifact.id,
        });
        if (request.autoStart) {
            await this.startRuntime(runtime.id);
        }
        return {
            spec: spec ?? {
                name: runtime.name,
                source: {
                    type: artifact.sourceType,
                    url: artifact.sourceUrl,
                    ref: artifact.sourceRef,
                    filePath: artifact.filePath,
                    revision: artifact.revision,
                },
                runtime: {
                    kind: runtime.runtime,
                    modelName: runtime.modelName,
                    port: runtime.port,
                },
            },
            artifact: this.requireArtifact(artifact.id),
            runtime: this.requireRuntime(runtime.id),
        };
    }
    deleteManagedEntity(id) {
        const runtimeIndex = this.state.runtimes.findIndex((item) => item.id === id);
        if (runtimeIndex !== -1) {
            this.stopRuntime(id);
            this.state.runtimes.splice(runtimeIndex, 1);
            this.executionState.delete(id);
            this.persist();
            return { deleted: "runtime", id };
        }
        const artifactIndex = this.state.artifacts.findIndex((item) => item.id === id);
        if (artifactIndex !== -1) {
            const artifact = this.state.artifacts[artifactIndex];
            const runtime = this.state.runtimes.find((item) => item.artifactId === artifact.id);
            if (runtime) {
                this.deleteManagedEntity(runtime.id);
            }
            const artifactPath = path.join(this.artifactDir, artifact.id);
            if (fs.existsSync(artifactPath)) {
                fs.rmSync(artifactPath, { recursive: true, force: true });
            }
            this.state.artifacts.splice(artifactIndex, 1);
            this.persist();
            return { deleted: "artifact", id };
        }
        const byModel = this.listModels().find((item) => item.modelName === id);
        if (byModel?.runtimeId) {
            return this.deleteManagedEntity(byModel.runtimeId);
        }
        if (byModel?.artifactId) {
            return this.deleteManagedEntity(byModel.artifactId);
        }
        throw new Error(`managed_model_not_found:${id}`);
    }
    async pull(request) {
        const resolved = resolveModelSource(request);
        const existing = this.state.artifacts.find((item) => item.sourceType === resolved.sourceType &&
            item.sourceRef === resolved.sourceRef &&
            (item.filePath ?? "") === (resolved.filePath ?? ""));
        if (existing && existing.status === "ready") {
            return existing;
        }
        const now = new Date().toISOString();
        const artifact = existing ??
            {
                id: generateId("mdl"),
                name: resolved.name,
                modelName: resolved.modelName,
                sourceType: resolved.sourceType,
                sourceRef: resolved.sourceRef,
                sourceUrl: resolved.sourceUrl,
                downloadUrl: resolved.downloadUrl,
                revision: resolved.revision,
                filePath: resolved.filePath,
                status: resolved.sourceType === "ollama" ? "pulling" : "downloading",
                runtimeHints: resolved.runtimeHints,
                notes: [...resolved.notes],
                metadata: resolved.metadata,
                createdAt: now,
                updatedAt: now,
            };
        if (!existing) {
            this.state.artifacts.push(artifact);
        }
        else {
            this.patchArtifact(artifact.id, {
                name: resolved.name,
                modelName: resolved.modelName,
                sourceUrl: resolved.sourceUrl,
                downloadUrl: resolved.downloadUrl,
                revision: resolved.revision,
                filePath: resolved.filePath,
                runtimeHints: resolved.runtimeHints,
                metadata: resolved.metadata,
                notes: resolved.notes,
                status: artifact.status,
                lastError: undefined,
            });
        }
        try {
            if (resolved.sourceType === "ollama") {
                await this.pullFromOllama(artifact, resolved);
            }
            else if (resolved.sourceType === "local" && resolved.localPath) {
                this.linkLocalArtifact(artifact, resolved.localPath);
            }
            else if (resolved.downloadUrl) {
                await this.downloadArtifact(artifact, resolved);
            }
            else {
                this.patchArtifact(artifact.id, {
                    status: "ready",
                    notes: [...artifact.notes, "Repository reference recorded. Runtime may pull lazily from upstream when started."],
                });
            }
        }
        catch (error) {
            this.patchArtifact(artifact.id, {
                status: "error",
                lastError: String(error),
            });
            throw error;
        }
        return this.requireArtifact(artifact.id);
    }
    createRuntime(request) {
        const artifact = request.artifactId ? this.requireArtifact(request.artifactId) : undefined;
        const runtime = request.runtime;
        const host = request.host ?? "127.0.0.1";
        const port = request.port ?? defaultPort(runtime);
        const baseUrl = request.baseUrl ?? defaultBaseUrl(runtime, host, port);
        const apiPath = request.apiPath ?? defaultApiPath(runtime);
        const mode = request.mode ?? "chat";
        const modelName = request.modelName ?? artifact?.modelName ?? `managed-${runtime}-${port}`;
        const name = request.name ?? modelName;
        const upstreamModel = request.upstreamModel ?? artifact?.metadata.repoId?.toString() ?? artifact?.sourceRef ?? modelName;
        const createdAt = new Date().toISOString();
        const instance = {
            id: generateId("rtm"),
            name,
            modelName,
            runtime,
            status: "stopped",
            artifactId: artifact?.id,
            host,
            port,
            baseUrl,
            apiPath,
            mode,
            apiKey: request.apiKey,
            upstreamModel,
            command: request.command ?? defaultCommand(runtime),
            args: request.args,
            maxConcurrentRequests: request.maxConcurrentRequests ?? defaultMaxConcurrent(runtime),
            maxQueueSize: request.maxQueueSize ?? defaultMaxQueueSize(runtime),
            retryMaxRetries: request.retryMaxRetries ?? defaultRetryMaxRetries(),
            circuitBreakerFailures: request.circuitBreakerFailures ?? defaultCircuitBreakerFailures(),
            circuitBreakerCooldownMs: request.circuitBreakerCooldownMs ?? defaultCircuitBreakerCooldownMs(),
            healthPath: request.healthPath ?? "/health",
            healthStatus: "unknown",
            notes: runtimeNotes(runtime, artifact),
            metadata: artifact ? { artifactId: artifact.id, sourceType: artifact.sourceType } : {},
            createdAt,
            updatedAt: createdAt,
        };
        this.state.runtimes.push(instance);
        this.ensureRuntimeState(instance);
        this.persist();
        return instance;
    }
    async startRuntime(id) {
        const runtime = this.requireRuntime(id);
        if (runtime.status === "running") {
            return runtime;
        }
        this.patchRuntime(id, { status: "starting", lastError: undefined });
        const next = this.requireRuntime(id);
        if (next.runtime === "openai-compatible") {
            this.ensureRuntimeState(next);
            this.patchRuntime(id, { status: "running", healthStatus: "unknown" });
            return this.requireRuntime(id);
        }
        if (next.runtime === "native") {
            const artifact = next.artifactId ? this.requireArtifact(next.artifactId) : undefined;
            const modelPath = artifact?.localPath;
            if (!modelPath) {
                throw new Error("native_runtime_requires_local_model_artifact");
            }
            const engine = new NativeRuntimeEngine(modelPath, {
                modelRef: resolveNativeModelRef(artifact, next),
                promptCacheLimit: parseNumber(process.env.KGM_NATIVE_PROMPT_CACHE_SIZE) ?? 8,
                sessionCacheLimit: parseNumber(process.env.KGM_NATIVE_SESSION_CACHE_SIZE) ?? 64,
                schedulerMaxBatchSize: parseNumber(process.env.KGM_NATIVE_SCHEDULER_MAX_BATCH_SIZE) ?? 8,
                schedulerMaxPrefillsPerTick: parseNumber(process.env.KGM_NATIVE_SCHEDULER_MAX_PREFILLS_PER_TICK) ?? 1,
                kvCacheMode: process.env.KGM_NATIVE_KV_CACHE_MODE === "dense" ? "dense" : "paged",
                kvPageSize: parseNumber(process.env.KGM_NATIVE_KV_PAGE_SIZE) ?? 16,
                cachedKvPageBudget: parseNumber(process.env.KGM_NATIVE_CACHED_KV_PAGE_BUDGET) ?? 256,
                servingBackend: process.env.KGM_NATIVE_SERVING_BACKEND === "native-core"
                    ? "native-core"
                    : process.env.KGM_NATIVE_SERVING_BACKEND === "js-reference"
                        ? "js-reference"
                        : "auto",
                seed: parseNumber(process.env.KGM_NATIVE_RUNTIME_SEED) ?? 1,
            });
            const manifest = engine.manifest();
            const nativeMetadata = engine.metadata();
            const nativeCore = getNativeCoreBindingStatus();
            const nativeDiagnostics = nativeMetadata.notes
                .filter((note) => note !== "GGUF metadata parsed successfully.")
                .filter((note) => note !== "Executable GGUF tensors loaded into the CPU reference backend.")
                .filter((note) => note !== "Safetensors header parsed successfully.")
                .filter((note) => note !== "Sharded safetensors index parsed successfully.")
                .map((note) => `Native diagnostics: ${note}`);
            const retainedNotes = next.notes.filter((note) => !note.startsWith("Native model format:") &&
                !note.startsWith("Native execution backend:") &&
                !note.startsWith("Native serving backend:") &&
                !note.startsWith("Native backend hints:") &&
                !note.startsWith("Native core binding:") &&
                !note.startsWith("Native diagnostics:"));
            this.nativeRuntimes.set(id, engine);
            this.ensureRuntimeState(next);
            this.patchRuntime(id, {
                status: "running",
                healthStatus: engine.isExecutable() ? "healthy" : "degraded",
                notes: [
                    ...retainedNotes,
                    `Native model format: ${nativeMetadata.format}`,
                    `Native execution backend: ${engine.executionBackend() ?? "none"}`,
                    `Native serving backend: ${engine.servingBackend()}`,
                    `Native backend hints: ${manifest.backendHints.join(", ")}`,
                    nativeCore.configured
                        ? `Native core binding: ${nativeCore.available ? "available" : `unavailable (${nativeCore.reason ?? "unknown"})`}`
                        : "Native core binding: not configured",
                    ...nativeDiagnostics,
                ],
                metadata: {
                    ...next.metadata,
                    native: nativeMetadata,
                    nativeManifest: manifest,
                    nativeExecutionBackend: engine.executionBackend(),
                    nativeServingBackend: engine.servingBackend(),
                    nativeCoreBinding: nativeCore,
                },
            });
            return this.requireRuntime(id);
        }
        if (next.runtime === "ollama" && !shouldAutostartOllama()) {
            this.patchRuntime(id, {
                status: "running",
                healthStatus: "unknown",
                notes: [...next.notes, "Assuming external Ollama daemon is already serving on the configured endpoint."],
            });
            return this.requireRuntime(id);
        }
        const spawnConfig = this.buildSpawnConfig(next);
        const child = spawn(spawnConfig.command, spawnConfig.args, {
            cwd: spawnConfig.cwd,
            detached: false,
            stdio: "pipe",
            env: {
                ...process.env,
                ...spawnConfig.env,
            },
        });
        this.processes.set(id, child);
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            if (stderr.length > 4000) {
                stderr = stderr.slice(-4000);
            }
        });
        child.on("exit", (code) => {
            this.processes.delete(id);
            const current = this.getRuntime(id);
            if (!current || current.status === "stopped") {
                return;
            }
            this.patchRuntime(id, {
                status: code === 0 ? "stopped" : "error",
                lastError: code === 0 ? undefined : stderr || `process_exit:${code ?? "unknown"}`,
                pid: undefined,
            });
        });
        this.patchRuntime(id, {
            status: "running",
            healthStatus: "unknown",
            pid: child.pid,
            command: spawnConfig.command,
            args: spawnConfig.args,
        });
        await delay(800);
        return this.requireRuntime(id);
    }
    stopRuntime(id) {
        const runtime = this.requireRuntime(id);
        this.rejectQueuedRequests(id, new Error(`managed_runtime_stopped:${id}`));
        if (runtime.runtime === "native") {
            this.nativeRuntimes.delete(id);
        }
        const child = this.processes.get(id);
        const targetPid = child?.pid ?? runtime.pid;
        if (targetPid) {
            try {
                process.kill(targetPid, "SIGTERM");
            }
            catch {
                // ignore
            }
        }
        this.processes.delete(id);
        this.patchRuntime(id, {
            status: "stopped",
            healthStatus: "unknown",
            pid: undefined,
            lastError: undefined,
        });
        return this.requireRuntime(id);
    }
    async executeRuntimeCompletion(runtime, prompt, options) {
        const state = this.ensureRuntimeState(runtime);
        this.updateCacheMetrics(state, prompt);
        if (this.isCircuitOpen(state)) {
            state.metrics.errorsTotal += 1;
            state.metrics.lastError = "circuit_open";
            state.metrics.lastErrorAt = new Date().toISOString();
            throw new Error(`managed_runtime_circuit_open:${runtime.id}`);
        }
        const enqueuedAt = await this.acquireRuntimeSlot(runtime, state);
        const queueWaitMs = Date.now() - enqueuedAt;
        state.metrics.lastQueueWaitMs = queueWaitMs;
        state.metrics.inflightRequests += 1;
        state.metrics.lastRequestAt = new Date().toISOString();
        const startedAt = Date.now();
        try {
            const result = await this.executeWithRetries(runtime, prompt, options, state);
            const latencyMs = Date.now() - startedAt;
            const outputTokens = estimateTokenCount(result.text);
            updateMetricsOnSuccess(state.metrics, {
                latencyMs,
                queueWaitMs,
                outputTokens,
            });
            this.patchRuntime(runtime.id, {
                healthStatus: "healthy",
                lastError: undefined,
            });
            return {
                text: result.text,
                raw: {
                    managedRuntime: {
                        runtimeId: runtime.id,
                        runtime: runtime.runtime,
                        baseUrl: runtime.baseUrl,
                        modelName: runtime.modelName,
                        upstreamModel: runtime.upstreamModel,
                        queueWaitMs,
                        latencyMs,
                        scheduler: {
                            inflight: state.metrics.inflightRequests,
                            queued: state.metrics.queuedRequests,
                            circuitState: state.metrics.circuitState,
                        },
                    },
                    result: result.raw,
                },
            };
        }
        catch (error) {
            updateMetricsOnError(state.metrics, String(error));
            this.maybeOpenCircuit(runtime, state);
            this.patchRuntime(runtime.id, {
                healthStatus: "degraded",
                lastError: String(error),
            });
            throw error;
        }
        finally {
            this.releaseRuntimeSlot(runtime, state);
        }
    }
    async *executeRuntimeCompletionStream(runtime, prompt, options) {
        const state = this.ensureRuntimeState(runtime);
        this.updateCacheMetrics(state, prompt);
        if (this.isCircuitOpen(state)) {
            state.metrics.errorsTotal += 1;
            state.metrics.lastError = "circuit_open";
            state.metrics.lastErrorAt = new Date().toISOString();
            throw new Error(`managed_runtime_circuit_open:${runtime.id}`);
        }
        const enqueuedAt = await this.acquireRuntimeSlot(runtime, state);
        const queueWaitMs = Date.now() - enqueuedAt;
        state.metrics.lastQueueWaitMs = queueWaitMs;
        state.metrics.inflightRequests += 1;
        state.metrics.lastRequestAt = new Date().toISOString();
        const startedAt = Date.now();
        let finalResult;
        try {
            if (runtime.runtime === "native") {
                const engine = this.nativeRuntimes.get(runtime.id);
                if (!engine) {
                    throw new Error(`native_runtime_not_started:${runtime.id}`);
                }
                for await (const event of engine.streamComplete(prompt, {
                    ...options,
                    model: runtime.upstreamModel,
                })) {
                    if (event.type === "finished") {
                        finalResult = event.result;
                        const latencyMs = Date.now() - startedAt;
                        const outputTokens = estimateTokenCount(event.result.text);
                        const perf = extractNativeRuntimePerf(event.result.raw);
                        updateMetricsOnSuccess(state.metrics, {
                            latencyMs,
                            queueWaitMs,
                            outputTokens,
                            ttftMs: perf?.ttftMs,
                            outputTokensPerSecond: perf?.tokensPerSecond,
                            kvResidentBytes: perf?.kvResidentBytes,
                        });
                        this.patchRuntime(runtime.id, {
                            healthStatus: "healthy",
                            lastError: undefined,
                        });
                        yield {
                            type: "finished",
                            result: {
                                text: event.result.text,
                                raw: {
                                    managedRuntime: {
                                        runtimeId: runtime.id,
                                        runtime: runtime.runtime,
                                        baseUrl: runtime.baseUrl,
                                        modelName: runtime.modelName,
                                        upstreamModel: runtime.upstreamModel,
                                        queueWaitMs,
                                        latencyMs,
                                        scheduler: {
                                            inflight: state.metrics.inflightRequests,
                                            queued: state.metrics.queuedRequests,
                                            circuitState: state.metrics.circuitState,
                                        },
                                    },
                                    result: event.result.raw,
                                },
                            },
                        };
                        continue;
                    }
                    yield event;
                }
            }
            else {
                const client = this.createRuntimeClient(runtime);
                for await (const event of streamCompletion(client, prompt, {
                    ...options,
                    model: runtime.upstreamModel,
                })) {
                    if (event.type === "finished") {
                        finalResult = event.result;
                        const latencyMs = Date.now() - startedAt;
                        const outputTokens = estimateTokenCount(event.result.text);
                        const perf = extractNativeRuntimePerf(event.result.raw);
                        updateMetricsOnSuccess(state.metrics, {
                            latencyMs,
                            queueWaitMs,
                            outputTokens,
                            ttftMs: perf?.ttftMs,
                            outputTokensPerSecond: perf?.tokensPerSecond,
                            kvResidentBytes: perf?.kvResidentBytes,
                        });
                        this.patchRuntime(runtime.id, {
                            healthStatus: "healthy",
                            lastError: undefined,
                        });
                        yield {
                            type: "finished",
                            result: {
                                text: event.result.text,
                                raw: {
                                    managedRuntime: {
                                        runtimeId: runtime.id,
                                        runtime: runtime.runtime,
                                        baseUrl: runtime.baseUrl,
                                        modelName: runtime.modelName,
                                        upstreamModel: runtime.upstreamModel,
                                        queueWaitMs,
                                        latencyMs,
                                        scheduler: {
                                            inflight: state.metrics.inflightRequests,
                                            queued: state.metrics.queuedRequests,
                                            circuitState: state.metrics.circuitState,
                                        },
                                    },
                                    result: event.result.raw,
                                },
                            },
                        };
                        continue;
                    }
                    yield event;
                }
            }
            if (!finalResult) {
                throw new Error(`managed_runtime_stream_missing_final_result:${runtime.id}`);
            }
            state.metrics.consecutiveFailures = 0;
            state.metrics.circuitState = state.metrics.circuitState === "half_open" ? "closed" : state.metrics.circuitState;
        }
        catch (error) {
            updateMetricsOnError(state.metrics, String(error));
            this.maybeOpenCircuit(runtime, state);
            this.patchRuntime(runtime.id, {
                healthStatus: "degraded",
                lastError: String(error),
            });
            throw error;
        }
        finally {
            this.releaseRuntimeSlot(runtime, state);
        }
    }
    async executeWithRetries(runtime, prompt, options, state) {
        const maxRetries = runtime.retryMaxRetries ?? defaultRetryMaxRetries();
        let attempt = 0;
        let lastError;
        while (attempt <= maxRetries) {
            try {
                if (runtime.runtime === "native") {
                    const engine = this.nativeRuntimes.get(runtime.id);
                    if (!engine) {
                        throw new Error(`native_runtime_not_started:${runtime.id}`);
                    }
                    const result = await engine.complete(prompt, {
                        ...options,
                        model: runtime.upstreamModel,
                    });
                    state.metrics.consecutiveFailures = 0;
                    state.metrics.circuitState = state.metrics.circuitState === "half_open" ? "closed" : state.metrics.circuitState;
                    return result;
                }
                const client = this.createRuntimeClient(runtime);
                const result = await client.complete(prompt, {
                    ...options,
                    model: runtime.upstreamModel,
                });
                state.metrics.consecutiveFailures = 0;
                state.metrics.circuitState = state.metrics.circuitState === "half_open" ? "closed" : state.metrics.circuitState;
                return result;
            }
            catch (error) {
                lastError = error;
                attempt += 1;
                if (attempt > maxRetries) {
                    break;
                }
                state.metrics.retriesTotal += 1;
                await delay(backoffDelayMs(attempt));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    drainQueue(runtime, state) {
        const limit = runtime.maxConcurrentRequests ?? defaultMaxConcurrent(runtime.runtime);
        while (state.metrics.inflightRequests < limit && state.queue.length > 0) {
            const next = state.queue.shift();
            if (!next) {
                break;
            }
            state.metrics.queuedRequests = state.queue.length;
            void next.run();
        }
    }
    async acquireRuntimeSlot(runtime, state) {
        const enqueuedAt = Date.now();
        if (state.metrics.inflightRequests < (runtime.maxConcurrentRequests ?? defaultMaxConcurrent(runtime.runtime))) {
            return enqueuedAt;
        }
        if (state.queue.length >= (runtime.maxQueueSize ?? defaultMaxQueueSize(runtime.runtime))) {
            state.metrics.queueRejectedTotal += 1;
            state.metrics.lastError = "queue_full";
            state.metrics.lastErrorAt = new Date().toISOString();
            throw new Error(`managed_runtime_queue_full:${runtime.id}`);
        }
        await new Promise((resolve, reject) => {
            state.queue.push({
                enqueuedAt,
                run: async () => {
                    resolve();
                },
                reject,
            });
            state.metrics.queuedRequests = state.queue.length;
        });
        state.metrics.queuedRequests = state.queue.length;
        return enqueuedAt;
    }
    releaseRuntimeSlot(runtime, state) {
        state.metrics.inflightRequests = Math.max(0, state.metrics.inflightRequests - 1);
        state.metrics.queuedRequests = state.queue.length;
        this.drainQueue(runtime, state);
    }
    rejectQueuedRequests(runtimeId, error) {
        const state = this.executionState.get(runtimeId);
        if (!state || state.queue.length === 0) {
            return;
        }
        for (const item of state.queue.splice(0)) {
            item.reject(error);
        }
        state.metrics.queuedRequests = 0;
    }
    ensureRuntimeState(runtime) {
        const existing = this.executionState.get(runtime.id);
        if (existing) {
            return existing;
        }
        const created = {
            metrics: createRuntimeMetrics(runtime),
            queue: [],
            seenPromptPrefixes: new Set(),
        };
        this.executionState.set(runtime.id, created);
        return created;
    }
    isCircuitOpen(state) {
        if (!state.circuitOpenUntil) {
            return false;
        }
        if (Date.now() >= state.circuitOpenUntil) {
            state.circuitOpenUntil = undefined;
            state.metrics.circuitState = "half_open";
            return false;
        }
        state.metrics.circuitState = "open";
        state.metrics.circuitOpenUntil = new Date(state.circuitOpenUntil).toISOString();
        return true;
    }
    maybeOpenCircuit(runtime, state) {
        const threshold = runtime.circuitBreakerFailures ?? defaultCircuitBreakerFailures();
        if (state.metrics.consecutiveFailures < threshold) {
            return;
        }
        const cooldown = runtime.circuitBreakerCooldownMs ?? defaultCircuitBreakerCooldownMs();
        state.circuitOpenUntil = Date.now() + cooldown;
        state.metrics.circuitState = "open";
        state.metrics.circuitOpenUntil = new Date(state.circuitOpenUntil).toISOString();
    }
    updateCacheMetrics(state, prompt) {
        const prefixHash = createHash("sha256").update(prompt.slice(0, 2048)).digest("hex");
        if (state.seenPromptPrefixes.has(prefixHash)) {
            state.metrics.cacheHits += 1;
            return;
        }
        state.seenPromptPrefixes.add(prefixHash);
        state.metrics.cacheMisses += 1;
    }
    startHealthChecker() {
        if (this.healthTimer || this.healthIntervalMs <= 0) {
            return;
        }
        this.healthTimer = setInterval(() => {
            void this.probeAllRuntimes().catch(() => { });
        }, this.healthIntervalMs);
        this.healthTimer.unref?.();
    }
    async probeEndpoint(runtime) {
        if (runtime.runtime === "native") {
            return this.nativeRuntimes.get(runtime.id)?.isExecutable() ?? false;
        }
        const candidates = buildProbeUrls(runtime);
        for (const url of candidates) {
            try {
                const response = await fetch(url, {
                    method: "GET",
                    headers: runtime.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {},
                });
                if (response.ok || response.status === 401 || response.status === 404) {
                    return true;
                }
            }
            catch {
                // keep trying
            }
        }
        return false;
    }
    async pullFromOllama(artifact, resolved) {
        const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
        const response = await fetch(joinUrl(base, "/api/pull"), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...resolved.authHeaders,
            },
            body: JSON.stringify({
                model: resolved.sourceRef,
                stream: false,
            }),
        });
        if (!response.ok) {
            throw new Error(`ollama pull failed: ${response.status} ${await response.text()}`);
        }
        const data = (await response.json());
        this.patchArtifact(artifact.id, {
            status: "ready",
            metadata: {
                ...artifact.metadata,
                ollama: data,
            },
            notes: [...artifact.notes, "Pulled into local Ollama model store."],
        });
    }
    async downloadArtifact(artifact, resolved) {
        const downloadUrl = resolved.downloadUrl;
        if (!downloadUrl) {
            throw new Error("download_url_required");
        }
        const response = await fetch(downloadUrl, {
            method: "GET",
            headers: resolved.authHeaders,
        });
        if (!response.ok || !response.body) {
            throw new Error(`download failed: ${response.status} ${await response.text()}`);
        }
        const filename = sanitizeFilename(path.basename(resolved.filePath ?? new URL(downloadUrl).pathname) || `${artifact.modelName}.bin`);
        const artifactDir = path.join(this.artifactDir, artifact.id);
        fs.mkdirSync(artifactDir, { recursive: true });
        const destination = path.join(artifactDir, filename);
        const writer = fs.createWriteStream(destination);
        const body = Readable.fromWeb(response.body);
        const hash = createHash("sha256");
        let sizeBytes = 0;
        for await (const chunk of body) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buffer);
            sizeBytes += buffer.length;
            writer.write(buffer);
        }
        writer.end();
        await once(writer, "finish");
        this.patchArtifact(artifact.id, {
            status: "ready",
            localPath: destination,
            sizeBytes,
            sha256: hash.digest("hex"),
            notes: [...artifact.notes, `Downloaded to ${destination}`],
        });
    }
    linkLocalArtifact(artifact, localPath) {
        const resolved = path.resolve(localPath);
        const stat = fs.statSync(resolved);
        this.patchArtifact(artifact.id, {
            status: "ready",
            localPath: resolved,
            sizeBytes: stat.isFile() ? stat.size : undefined,
            notes: [...artifact.notes, `Mounted local model artifact at ${resolved}`],
        });
    }
    buildSpawnConfig(runtime) {
        const artifact = runtime.artifactId ? this.requireArtifact(runtime.artifactId) : undefined;
        const modelRef = artifact?.localPath ?? artifact?.metadata.repoId?.toString() ?? artifact?.sourceRef ?? runtime.upstreamModel;
        switch (runtime.runtime) {
            case "llama.cpp":
                if (!artifact?.localPath) {
                    throw new Error("llama.cpp runtime requires a downloaded local artifact");
                }
                return {
                    command: runtime.command ?? defaultCommand("llama.cpp"),
                    args: runtime.args ??
                        [
                            "-m",
                            artifact.localPath,
                            "--host",
                            runtime.host,
                            "--port",
                            String(runtime.port),
                        ],
                };
            case "vllm":
                return {
                    command: runtime.command ?? defaultCommand("vllm"),
                    args: runtime.args ??
                        [
                            "serve",
                            modelRef,
                            "--host",
                            runtime.host,
                            "--port",
                            String(runtime.port),
                        ],
                    env: runtime.apiKey ? { VLLM_API_KEY: runtime.apiKey } : undefined,
                };
            case "sglang":
                return {
                    command: runtime.command ?? defaultCommand("sglang"),
                    args: runtime.args ??
                        [
                            "-m",
                            "sglang.launch_server",
                            "--model-path",
                            modelRef,
                            "--host",
                            runtime.host,
                            "--port",
                            String(runtime.port),
                        ],
                };
            case "mlx":
                if (!modelRef) {
                    throw new Error("mlx_runtime_requires_model_path_or_upstream");
                }
                return {
                    command: runtime.command ?? defaultCommand("mlx"),
                    args: runtime.args ??
                        [
                            "-m",
                            "mlx_lm.server",
                            "--model",
                            modelRef,
                            "--host",
                            runtime.host,
                            "--port",
                            String(runtime.port),
                        ],
                };
            case "ollama":
                return {
                    command: runtime.command ?? defaultCommand("ollama"),
                    args: runtime.args ?? ["serve"],
                };
            case "native":
                throw new Error("native_runtime_is_single_process_and_does_not_spawn_external_workers");
            default:
                throw new Error(`unsupported_runtime:${runtime.runtime}`);
        }
    }
    createRuntimeClient(runtime) {
        return new HttpLlmClient({
            baseUrl: runtime.baseUrl,
            model: runtime.upstreamModel,
            path: runtime.apiPath,
            apiKey: runtime.apiKey,
            mode: runtime.mode,
            timeoutMs: parseNumber(process.env.KGM_MODEL_RUNTIME_TIMEOUT_MS) ?? 120000,
        });
    }
    patchArtifact(id, patch) {
        const artifact = this.state.artifacts.find((item) => item.id === id);
        if (!artifact) {
            throw new Error(`artifact_not_found:${id}`);
        }
        Object.assign(artifact, patch, { updatedAt: new Date().toISOString() });
        this.persist();
    }
    patchRuntime(id, patch) {
        const runtime = this.state.runtimes.find((item) => item.id === id);
        if (!runtime) {
            throw new Error(`runtime_not_found:${id}`);
        }
        Object.assign(runtime, patch, { updatedAt: new Date().toISOString() });
        this.persist();
    }
    requireArtifact(id) {
        const artifact = this.getArtifact(id);
        if (!artifact) {
            throw new Error(`artifact_not_found:${id}`);
        }
        return artifact;
    }
    requireRuntime(id) {
        const runtime = this.getRuntime(id);
        if (!runtime) {
            throw new Error(`runtime_not_found:${id}`);
        }
        return runtime;
    }
    migrateLegacyMonolithicCatalog(legacyFile) {
        const raw = fs.readFileSync(legacyFile, "utf8").trim();
        if (!raw) {
            fs.unlinkSync(legacyFile);
            return;
        }
        let state;
        try {
            state = JSON.parse(raw);
        }
        catch {
            try {
                fs.renameSync(legacyFile, `${legacyFile}.corrupt.${Date.now()}`);
            }
            catch {
                /* ignore */
            }
            return;
        }
        if (!Array.isArray(state.artifacts)) {
            state.artifacts = [];
        }
        if (!Array.isArray(state.runtimes)) {
            state.runtimes = [];
        }
        this.writeAllShards(state);
        fs.unlinkSync(legacyFile);
    }
    loadState() {
        const artifactsDir = path.join(this.stateRoot, STORE_ARTIFACTS_DIR);
        const runtimesDir = path.join(this.stateRoot, STORE_RUNTIMES_DIR);
        fs.mkdirSync(artifactsDir, { recursive: true });
        fs.mkdirSync(runtimesDir, { recursive: true });
        const artifacts = [];
        const runtimes = [];
        for (const name of fs.readdirSync(artifactsDir)) {
            if (!name.endsWith(".json")) {
                continue;
            }
            const filePath = path.join(artifactsDir, name);
            try {
                const raw = fs.readFileSync(filePath, "utf8").trim();
                if (!raw) {
                    continue;
                }
                artifacts.push(JSON.parse(raw));
            }
            catch {
                /* 跳过损坏分片 */
            }
        }
        for (const name of fs.readdirSync(runtimesDir)) {
            if (!name.endsWith(".json")) {
                continue;
            }
            const filePath = path.join(runtimesDir, name);
            try {
                const raw = fs.readFileSync(filePath, "utf8").trim();
                if (!raw) {
                    continue;
                }
                runtimes.push(JSON.parse(raw));
            }
            catch {
                /* 跳过损坏分片 */
            }
        }
        return { artifacts, runtimes };
    }
    writeManifestSnapshot(state) {
        const manifest = {
            formatVersion: 2,
            storage: "sharded",
            artifactCount: state.artifacts.length,
            runtimeCount: state.runtimes.length,
            updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(this.stateRoot, STORE_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    }
    writeAllShards(state) {
        const artifactsDir = path.join(this.stateRoot, STORE_ARTIFACTS_DIR);
        const runtimesDir = path.join(this.stateRoot, STORE_RUNTIMES_DIR);
        fs.mkdirSync(artifactsDir, { recursive: true });
        fs.mkdirSync(runtimesDir, { recursive: true });
        for (const artifact of state.artifacts) {
            fs.writeFileSync(path.join(artifactsDir, `${artifact.id}.json`), JSON.stringify(artifact, null, 2));
        }
        for (const runtime of state.runtimes) {
            fs.writeFileSync(path.join(runtimesDir, `${runtime.id}.json`), JSON.stringify(runtime, null, 2));
        }
        this.writeManifestSnapshot(state);
    }
    pruneRemovedShardFiles() {
        const artifactIds = new Set(this.state.artifacts.map((a) => a.id));
        const runtimeIds = new Set(this.state.runtimes.map((r) => r.id));
        const artifactsDir = path.join(this.stateRoot, STORE_ARTIFACTS_DIR);
        const runtimesDir = path.join(this.stateRoot, STORE_RUNTIMES_DIR);
        if (fs.existsSync(artifactsDir)) {
            for (const name of fs.readdirSync(artifactsDir)) {
                if (!name.endsWith(".json")) {
                    continue;
                }
                const id = name.slice(0, -".json".length);
                if (!artifactIds.has(id)) {
                    fs.unlinkSync(path.join(artifactsDir, name));
                }
            }
        }
        if (fs.existsSync(runtimesDir)) {
            for (const name of fs.readdirSync(runtimesDir)) {
                if (!name.endsWith(".json")) {
                    continue;
                }
                const id = name.slice(0, -".json".length);
                if (!runtimeIds.has(id)) {
                    fs.unlinkSync(path.join(runtimesDir, name));
                }
            }
        }
    }
    persist() {
        this.writeAllShards(this.state);
        this.pruneRemovedShardFiles();
    }
}
function resolveModelSource(request) {
    if (request.sourceType === "local" || isLocalPathReference(request.sourceUrl ?? request.sourceRef)) {
        return resolveLocalSource(request);
    }
    if (request.sourceType === "ollama" || isOllamaReference(request.sourceUrl) || request.sourceRef?.startsWith("ollama://")) {
        const modelRef = normalizeOllamaRef(request.sourceUrl, request.sourceRef);
        return {
            sourceType: "ollama",
            sourceRef: modelRef,
            sourceUrl: request.sourceUrl,
            modelName: request.modelName ?? modelRef,
            name: request.name ?? modelRef,
            runtimeHints: ["ollama"],
            authHeaders: {},
            metadata: {},
            notes: ["Will pull into the local Ollama model store."],
        };
    }
    const url = normalizeUrlOrThrow(request.sourceUrl, request.sourceRef);
    if (isHuggingFaceHost(url.hostname)) {
        return resolveHuggingFaceSource(url, request);
    }
    if (isGitHubHost(url.hostname)) {
        return resolveGitHubSource(url, request);
    }
    if (isModelScopeHost(url.hostname)) {
        return resolveModelScopeSource(url, request);
    }
    return {
        sourceType: request.sourceType ?? "direct",
        sourceRef: url.toString(),
        sourceUrl: url.toString(),
        downloadUrl: url.toString(),
        filePath: request.filePath,
        revision: request.revision,
        modelName: request.modelName ?? stripExtension(path.basename(url.pathname)),
        name: request.name ?? stripExtension(path.basename(url.pathname)),
        runtimeHints: inferRuntimeHints(request.filePath ?? url.pathname),
        authHeaders: buildAuthHeaders("direct", request.authToken),
        metadata: {},
        notes: ["Direct URL download."],
    };
}
function resolveLocalSource(request) {
    const raw = request.sourceUrl ?? request.sourceRef;
    if (!raw) {
        throw new Error("local_model_path_required");
    }
    const localPath = normalizeLocalPath(raw);
    const stat = fs.statSync(localPath);
    const basename = path.basename(localPath);
    const ollamaStorePath = isOllamaStorePath(localPath);
    const ollamaManifestPath = isOllamaManifestPath(localPath);
    const ollamaModelRef = ollamaStorePath
        ? normalizeOllamaLocalModelRef(request.filePath ?? request.revision ?? request.modelName)
        : undefined;
    if (ollamaStorePath && !ollamaModelRef) {
        throw new Error("ollama_model_ref_required_for_store_root");
    }
    const runtimeHints = ollamaStorePath || ollamaManifestPath
        ? ["native", "llama.cpp", "ollama"]
        : inferRuntimeHintsForLocalPath(localPath, stat);
    return {
        sourceType: "local",
        sourceRef: localPath,
        sourceUrl: raw,
        filePath: basename,
        modelName: request.modelName ?? stripExtension(basename),
        name: request.name ?? stripExtension(basename),
        runtimeHints,
        authHeaders: {},
        metadata: {
            local: true,
            ...(ollamaStorePath || ollamaManifestPath ? { ollamaStore: true } : {}),
            ...(ollamaModelRef ? { ollamaModelRef } : {}),
        },
        notes: [
            "Mounted from local filesystem path.",
            ...(ollamaStorePath ? ["Detected Ollama model store root."] : []),
            ...(ollamaManifestPath ? ["Detected Ollama manifest path."] : []),
            ...(ollamaModelRef ? [`Ollama model ref: ${ollamaModelRef}`] : []),
        ],
        localPath,
    };
}
function resolveHuggingFaceSource(url, request) {
    const parts = url.pathname.split("/").filter(Boolean);
    const pivot = parts.findIndex((part) => part === "resolve" || part === "blob" || part === "tree");
    const repoParts = pivot === -1 ? parts : parts.slice(0, pivot);
    const repoId = repoParts.slice(0, 2).join("/");
    const revision = request.revision ?? (pivot !== -1 ? parts[pivot + 1] : "main");
    const filePath = request.filePath ?? (pivot !== -1 ? parts.slice(pivot + 2).join("/") : undefined);
    const downloadUrl = filePath ? `https://huggingface.co/${repoId}/resolve/${revision}/${filePath}` : undefined;
    return {
        sourceType: "huggingface",
        sourceRef: repoId,
        sourceUrl: url.toString(),
        downloadUrl,
        revision,
        filePath,
        modelName: request.modelName ?? repoId.split("/").at(-1) ?? repoId,
        name: request.name ?? repoId,
        runtimeHints: filePath ? inferRuntimeHints(filePath) : ["vllm", "sglang", "openai-compatible"],
        authHeaders: buildAuthHeaders("huggingface", request.authToken),
        metadata: { repoId },
        notes: filePath
            ? ["Downloaded from Hugging Face repository."]
            : ["Repository recorded. A runtime such as vLLM or SGLang can pull lazily by repo id."],
    };
}
function resolveGitHubSource(url, request) {
    if (url.hostname === "raw.githubusercontent.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        const repoId = parts.slice(0, 2).join("/");
        return {
            sourceType: "github",
            sourceRef: repoId,
            sourceUrl: url.toString(),
            downloadUrl: url.toString(),
            revision: parts[2],
            filePath: parts.slice(3).join("/"),
            modelName: request.modelName ?? stripExtension(parts.at(-1) ?? repoId),
            name: request.name ?? repoId,
            runtimeHints: inferRuntimeHints(parts.slice(3).join("/")),
            authHeaders: buildAuthHeaders("github", request.authToken),
            metadata: { repoId },
            notes: ["Direct GitHub raw download."],
        };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const repoId = parts.slice(0, 2).join("/");
    let revision = request.revision ?? "main";
    let filePath = request.filePath;
    let downloadUrl = url.toString();
    if (parts[2] === "releases" && parts[3] === "download") {
        revision = parts[4];
        filePath = parts.slice(5).join("/");
    }
    else if (parts[2] === "blob" || parts[2] === "raw") {
        revision = parts[3];
        filePath = parts.slice(4).join("/");
        downloadUrl = `https://raw.githubusercontent.com/${repoId}/${revision}/${filePath}`;
    }
    else if (filePath) {
        downloadUrl = `https://raw.githubusercontent.com/${repoId}/${revision}/${filePath}`;
    }
    return {
        sourceType: "github",
        sourceRef: repoId,
        sourceUrl: url.toString(),
        downloadUrl,
        revision,
        filePath,
        modelName: request.modelName ?? stripExtension(path.basename(filePath ?? repoId)),
        name: request.name ?? repoId,
        runtimeHints: inferRuntimeHints(filePath ?? downloadUrl),
        authHeaders: buildAuthHeaders("github", request.authToken),
        metadata: { repoId },
        notes: ["GitHub download source."],
    };
}
function resolveModelScopeSource(url, request) {
    const parts = url.pathname.split("/").filter(Boolean);
    const modelsIndex = parts.findIndex((part) => part === "models");
    const trailing = modelsIndex === -1 ? parts : parts.slice(modelsIndex + 1);
    const pivot = trailing.findIndex((part) => part === "resolve" || part === "blob" || part === "tree");
    const repoParts = pivot === -1 ? trailing : trailing.slice(0, pivot);
    const repoId = repoParts.join("/");
    const revision = request.revision ?? (pivot !== -1 ? trailing[pivot + 1] : "master");
    const filePath = request.filePath ?? (pivot !== -1 ? trailing.slice(pivot + 2).join("/") : undefined);
    const downloadUrl = filePath ? `https://www.modelscope.cn/models/${repoId}/resolve/${revision}/${filePath}` : undefined;
    return {
        sourceType: "modelscope",
        sourceRef: repoId,
        sourceUrl: url.toString(),
        downloadUrl,
        revision,
        filePath,
        modelName: request.modelName ?? repoId.split("/").at(-1) ?? repoId,
        name: request.name ?? repoId,
        runtimeHints: filePath ? inferRuntimeHints(filePath) : ["vllm", "sglang", "openai-compatible"],
        authHeaders: buildAuthHeaders("modelscope", request.authToken),
        metadata: { repoId },
        notes: filePath
            ? ["Downloaded from ModelScope."]
            : ["Repository recorded. Runtime may pull lazily from ModelScope-compatible sync path."],
    };
}
function inferRuntimeHints(value) {
    const lower = value.toLowerCase();
    if (lower.includes(`${path.sep}.ollama${path.sep}models`) || lower.endsWith(`${path.sep}models`) || lower.includes(`${path.sep}manifests${path.sep}`)) {
        return ["native", "llama.cpp", "ollama"];
    }
    if (lower.endsWith(".kgm.json")) {
        return ["native", "openai-compatible"];
    }
    if (lower.endsWith(".gguf")) {
        return ["native", "llama.cpp", "ollama"];
    }
    if (lower.endsWith(".safetensors") || lower.endsWith(".safetensors.index.json")) {
        try {
            const dir = path.dirname(path.resolve(value));
            if (fs.existsSync(dir) && detectJangInModelDirectory(dir)) {
                return ["mlx", "openai-compatible", "vllm", "sglang"];
            }
        }
        catch {
            /* ignore */
        }
    }
    if (lower.endsWith(".safetensors")
        || lower.endsWith(".bin")
        || lower.endsWith(".pt")
        || lower.endsWith(".pth")
        || lower.endsWith(".h5")
        || lower.endsWith(".ckpt")
        || lower.endsWith(".ckpt.index")
        || lower.endsWith(".pb")
        || lower.endsWith(".pbtxt")
        || lower.includes("config.json")
        || lower.includes("tokenizer")) {
        return ["vllm", "sglang", "openai-compatible"];
    }
    return ["openai-compatible", "vllm", "sglang"];
}
function inferRuntimeHintsForLocalPath(localPath, stat) {
    if (!stat.isDirectory()) {
        return inferRuntimeHints(localPath);
    }
    if (detectJangInModelDirectory(localPath)) {
        return ["mlx", "openai-compatible", "vllm", "sglang"];
    }
    if (fs.existsSync(path.join(localPath, "model.kgm.json"))) {
        return ["native", ...inferRuntimeHints(path.join(localPath, "model.kgm.json")).filter((item) => item !== "native")];
    }
    if (hasDirectoryEntry(localPath, (name) => name.toLowerCase().endsWith(".gguf"))) {
        return ["native", "llama.cpp", "ollama"];
    }
    if (hasDirectoryEntry(localPath, (name) => name.toLowerCase().endsWith(".safetensors") || name.toLowerCase().endsWith(".safetensors.index.json"))) {
        return ["vllm", "sglang", "openai-compatible"];
    }
    if (hasDirectoryEntry(localPath, (name) => isPyTorchFilename(name) || isTensorFlowFilename(name))) {
        return ["vllm", "sglang", "openai-compatible"];
    }
    if (fs.existsSync(path.join(localPath, "config.json")) || fs.existsSync(path.join(localPath, "tokenizer.json"))) {
        return ["vllm", "sglang", "openai-compatible"];
    }
    return ["openai-compatible", "vllm", "sglang"];
}
function runtimeNotes(runtime, artifact) {
    const notes = [`Runtime kind: ${runtime}`];
    if (artifact?.localPath) {
        notes.push(`Artifact path: ${artifact.localPath}`);
    }
    else if (artifact?.sourceRef) {
        notes.push(`Source reference: ${artifact.sourceRef}`);
    }
    if (runtime === "native") {
        notes.push("Runs a single-process CPU reference inference backend inside KGM.");
    }
    else if (runtime === "llama.cpp") {
        notes.push("Requires llama-server or compatible command to be installed on the host.");
    }
    else if (runtime === "vllm") {
        notes.push("Requires vLLM runtime on a GPU-capable host.");
    }
    else if (runtime === "sglang") {
        notes.push("Requires SGLang runtime on the target host.");
    }
    else if (runtime === "mlx") {
        notes.push("Requires Apple Silicon + mlx-lm (`python -m mlx_lm.server`). Override command with KGM_MLX_CMD / runtime.command; JANG weights use this path instead of KGM native CPU.");
    }
    else if (runtime === "ollama") {
        notes.push("By default this attaches to an existing Ollama daemon unless autostart is enabled.");
    }
    return notes;
}
function defaultPort(runtime) {
    switch (runtime) {
        case "native":
            return 9100;
        case "llama.cpp":
            return 8080;
        case "ollama":
            return 11434;
        case "vllm":
            return 8000;
        case "sglang":
            return 7860;
        case "mlx":
            return parseNumber(process.env.KGM_MLX_PORT) ?? 8765;
        default:
            return 9000;
    }
}
function buildProbeUrls(runtime) {
    const baseUrl = runtime.baseUrl.replace(/\/$/, "");
    const urls = new Set();
    urls.add(`${baseUrl}${runtime.healthPath?.startsWith("/") ? runtime.healthPath : `/${runtime.healthPath ?? "health"}`}`);
    urls.add(`${baseUrl}/models`);
    urls.add(baseUrl);
    return Array.from(urls);
}
function defaultMaxConcurrent(runtime) {
    if (runtime === "native") {
        return parseNumber(process.env.KGM_NATIVE_MAX_CONCURRENT_REQUESTS) ?? 8;
    }
    if (runtime === "llama.cpp" || runtime === "ollama") {
        return 2;
    }
    return 8;
}
function defaultMaxQueueSize(runtime) {
    if (runtime === "native") {
        return parseNumber(process.env.KGM_NATIVE_MAX_QUEUE_SIZE) ?? 64;
    }
    if (runtime === "llama.cpp" || runtime === "ollama") {
        return 16;
    }
    return 128;
}
function defaultRetryMaxRetries() {
    return parseNumber(process.env.KGM_MODEL_RUNTIME_RETRY_MAX_RETRIES) ?? 1;
}
function defaultCircuitBreakerFailures() {
    return parseNumber(process.env.KGM_MODEL_RUNTIME_CB_FAILURES) ?? 5;
}
function defaultCircuitBreakerCooldownMs() {
    return parseNumber(process.env.KGM_MODEL_RUNTIME_CB_COOLDOWN_MS) ?? 30000;
}
function defaultBaseUrl(runtime, host, port) {
    if (runtime === "native") {
        return `http://${host}:${port}/native`;
    }
    if (runtime === "llama.cpp") {
        return `http://${host}:${port}`;
    }
    return `http://${host}:${port}/v1`;
}
function defaultApiPath(runtime) {
    if (runtime === "native") {
        return "/v1/chat/completions";
    }
    if (runtime === "llama.cpp") {
        return "/v1/chat/completions";
    }
    if (runtime === "openai-compatible"
        || runtime === "ollama"
        || runtime === "vllm"
        || runtime === "sglang"
        || runtime === "mlx") {
        return "/chat/completions";
    }
    return "/chat/completions";
}
function defaultCommand(runtime) {
    switch (runtime) {
        case "native":
            return process.execPath;
        case "llama.cpp":
            return process.env.KGM_LLAMA_SERVER_CMD ?? "llama-server";
        case "ollama":
            return process.env.KGM_OLLAMA_CMD ?? "ollama";
        case "vllm":
            return process.env.KGM_VLLM_CMD ?? "vllm";
        case "sglang":
            return process.env.KGM_SGLANG_CMD ?? "python";
        case "mlx":
            return process.env.KGM_MLX_CMD ?? "python";
        default:
            return "";
    }
}
function resolveNativeModelRef(artifact, runtime) {
    const metadataRef = artifact?.metadata?.ollamaModelRef;
    if (typeof metadataRef === "string" && metadataRef.trim()) {
        return metadataRef.trim();
    }
    if (artifact?.localPath && isOllamaStorePath(artifact.localPath)) {
        const candidate = artifact.modelName.trim() || runtime.upstreamModel.trim() || runtime.modelName.trim();
        return candidate || undefined;
    }
    return undefined;
}
function shouldAutostartOllama() {
    return process.env.KGM_OLLAMA_AUTOSTART === "1" || process.env.KGM_OLLAMA_AUTOSTART?.toLowerCase() === "true";
}
function isHuggingFaceHost(hostname) {
    return hostname === "huggingface.co";
}
function isGitHubHost(hostname) {
    return hostname === "github.com" || hostname === "raw.githubusercontent.com";
}
function isModelScopeHost(hostname) {
    return hostname === "www.modelscope.cn" || hostname === "modelscope.cn";
}
function isOllamaReference(value) {
    if (!value) {
        return false;
    }
    return value.startsWith("ollama://") || value.includes("ollama.com/library/");
}
function normalizeOllamaRef(sourceUrl, sourceRef) {
    if (sourceRef?.startsWith("ollama://")) {
        return sourceRef.replace("ollama://", "");
    }
    if (sourceRef) {
        return sourceRef;
    }
    if (!sourceUrl) {
        throw new Error("ollama_model_reference_required");
    }
    if (sourceUrl.startsWith("ollama://")) {
        return sourceUrl.replace("ollama://", "");
    }
    const url = new URL(sourceUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "library") {
        return decodeURIComponent(parts.slice(1).join("/"));
    }
    return decodeURIComponent(parts.join("/"));
}
function buildAuthHeaders(sourceType, explicit) {
    const token = explicit ??
        (sourceType === "huggingface"
            ? process.env.HF_TOKEN
            : sourceType === "github"
                ? process.env.GITHUB_TOKEN
                : sourceType === "modelscope"
                    ? process.env.MODELSCOPE_API_TOKEN
                    : undefined);
    if (!token) {
        return {};
    }
    if (sourceType === "github") {
        return {
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
        };
    }
    return { authorization: `Bearer ${token}` };
}
function normalizeUrlOrThrow(sourceUrl, sourceRef) {
    const value = sourceUrl ?? sourceRef;
    if (!value) {
        throw new Error("source_url_required");
    }
    return new URL(value);
}
function isLocalPathReference(value) {
    if (!value) {
        return false;
    }
    if (value.startsWith("file://")) {
        return true;
    }
    if (path.isAbsolute(value)) {
        return true;
    }
    return fs.existsSync(path.resolve(value));
}
function normalizeLocalPath(value) {
    if (value.startsWith("file://")) {
        return decodeURIComponent(new URL(value).pathname);
    }
    if (!path.isAbsolute(value)) {
        throw new Error("local_model_path_must_be_absolute");
    }
    return path.resolve(value);
}
function normalizeOllamaLocalModelRef(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().replace(/^ollama:\/\//, "");
    return normalized ? normalized : undefined;
}
function isOllamaStorePath(targetPath) {
    try {
        return fs.statSync(targetPath).isDirectory()
            && fs.existsSync(path.join(targetPath, "manifests"))
            && fs.existsSync(path.join(targetPath, "blobs"));
    }
    catch {
        return false;
    }
}
function isOllamaManifestPath(targetPath) {
    return targetPath.includes(`${path.sep}manifests${path.sep}`);
}
function hasDirectoryEntry(baseDir, matcher) {
    try {
        return fs.readdirSync(baseDir).some((name) => matcher(name));
    }
    catch {
        return false;
    }
}
function isPyTorchFilename(name) {
    const lower = name.toLowerCase();
    return lower === "pytorch_model.bin"
        || lower === "pytorch_model.bin.index.json"
        || lower.endsWith(".pt")
        || lower.endsWith(".pth")
        || /^consolidated.*\.(pt|pth|bin)$/i.test(name);
}
function isTensorFlowFilename(name) {
    const lower = name.toLowerCase();
    return lower === "saved_model.pb"
        || lower === "saved_model.pbtxt"
        || lower === "tf_model.h5"
        || lower.endsWith(".h5")
        || lower.endsWith(".ckpt")
        || lower.endsWith(".ckpt.index");
}
function stripExtension(value) {
    return value.replace(/\.[^.]+$/, "");
}
function sanitizeFilename(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
function joinUrl(base, pathname) {
    return `${base.replace(/\/$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}
function parseNumber(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function createRuntimeMetrics(runtime) {
    return {
        runtimeId: runtime.id,
        modelName: runtime.modelName,
        runtime: runtime.runtime,
        requestsTotal: 0,
        successesTotal: 0,
        errorsTotal: 0,
        queueRejectedTotal: 0,
        retriesTotal: 0,
        inflightRequests: 0,
        queuedRequests: 0,
        avgLatencyMs: 0,
        avgQueueWaitMs: 0,
        avgTtftMs: 0,
        lastTtftMs: 0,
        avgOutputTokensPerSecond: 0,
        avgTimePerOutputTokenMs: 0,
        lastLatencyMs: 0,
        lastQueueWaitMs: 0,
        lastOutputTokensPerSecond: 0,
        avgKvResidentBytes: 0,
        lastKvResidentBytes: 0,
        consecutiveFailures: 0,
        circuitState: "closed",
        cacheHits: 0,
        cacheMisses: 0,
    };
}
function updateMetricsOnSuccess(metrics, params) {
    metrics.requestsTotal += 1;
    metrics.successesTotal += 1;
    metrics.lastLatencyMs = params.latencyMs;
    metrics.lastQueueWaitMs = params.queueWaitMs;
    metrics.lastSuccessAt = new Date().toISOString();
    metrics.avgLatencyMs = movingAverage(metrics.avgLatencyMs, params.latencyMs, metrics.successesTotal);
    metrics.avgQueueWaitMs = movingAverage(metrics.avgQueueWaitMs, params.queueWaitMs, metrics.successesTotal);
    const perSecond = params.outputTokensPerSecond ?? (params.outputTokens > 0 ? params.outputTokens / Math.max(params.latencyMs / 1000, 0.001) : 0);
    const timePerToken = params.outputTokens > 0 ? params.latencyMs / params.outputTokens : params.latencyMs;
    metrics.avgOutputTokensPerSecond = movingAverage(metrics.avgOutputTokensPerSecond, perSecond, metrics.successesTotal);
    metrics.avgTimePerOutputTokenMs = movingAverage(metrics.avgTimePerOutputTokenMs, timePerToken, metrics.successesTotal);
    metrics.lastOutputTokensPerSecond = perSecond;
    if (typeof params.ttftMs === "number" && Number.isFinite(params.ttftMs)) {
        metrics.lastTtftMs = params.ttftMs;
        metrics.avgTtftMs = movingAverage(metrics.avgTtftMs ?? 0, params.ttftMs, metrics.successesTotal);
    }
    if (typeof params.kvResidentBytes === "number" && Number.isFinite(params.kvResidentBytes)) {
        metrics.lastKvResidentBytes = params.kvResidentBytes;
        metrics.avgKvResidentBytes = movingAverage(metrics.avgKvResidentBytes ?? 0, params.kvResidentBytes, metrics.successesTotal);
    }
    metrics.consecutiveFailures = 0;
    metrics.circuitState = "closed";
    metrics.circuitOpenUntil = undefined;
    metrics.lastError = undefined;
}
function updateMetricsOnError(metrics, error) {
    metrics.requestsTotal += 1;
    metrics.errorsTotal += 1;
    metrics.consecutiveFailures += 1;
    metrics.lastError = error;
    metrics.lastErrorAt = new Date().toISOString();
}
function movingAverage(current, value, count) {
    if (count <= 1) {
        return value;
    }
    return current + (value - current) / count;
}
function estimateTokenCount(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return 0;
    }
    return trimmed.split(/\s+/).length;
}
function backoffDelayMs(attempt) {
    return Math.min(250 * (2 ** (attempt - 1)), 2000);
}
function extractNativeRuntimePerf(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const nativeRuntime = raw.nativeRuntime;
    if (!nativeRuntime || typeof nativeRuntime !== "object") {
        return null;
    }
    const record = nativeRuntime;
    const memory = (record.memory && typeof record.memory === "object")
        ? record.memory
        : undefined;
    return {
        ttftMs: typeof record.ttftMs === "number" ? record.ttftMs : undefined,
        tokensPerSecond: typeof record.tokensPerSecond === "number" ? record.tokensPerSecond : undefined,
        kvResidentBytes: typeof memory?.kvResidentBytes === "number" ? memory.kvResidentBytes : undefined,
    };
}
function circuitStateValue(state) {
    if (state === "half_open") {
        return 1;
    }
    if (state === "open") {
        return 2;
    }
    return 0;
}
function escapeMetricLabel(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Runtime hints for a local file or directory (CLI, tests, tooling).
 * JANG / MLX-native layouts return `mlx` first.
 */
export function inferRuntimeHintsForModelPath(modelPath) {
    const resolved = path.resolve(modelPath);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
        return inferRuntimeHintsForLocalPath(resolved, stat);
    }
    return inferRuntimeHints(resolved);
}
