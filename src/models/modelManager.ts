import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";

import { HttpLlmClient } from "../llm/client.js";
import { streamCompletion } from "../llm/client.js";
import type { CompletionOptions, CompletionResult, CompletionStreamEvent, LlmClient } from "../llm/client.js";
import { getNativeCoreBindingStatus } from "../native/bindings.js";
import { NativeRuntimeEngine } from "../native/engine.js";
import { generateId } from "../utils/id.js";
import { parseKgmfile, toModelRequests, type KgmfileSpec } from "./kgmfile.js";
import { detectJangInModelDirectory } from "../native/jang.js";
import { assessArtifactExecution, resolveRuntimeKind } from "../native/executionPolicy.js";
import { assertLlamaCppCallable, resolveLlamaCppDeployConfig, type LlamaCppDeployConfig } from "../runtime/llamaCppDeploy.js";
import { assertDs4Callable, resolveDs4DeployConfig, type Ds4DeployConfig } from "../runtime/ds4Deploy.js";
import {
  assertTokenSpeedCallable,
  buildTokenSpeedServerArgs,
  resolveTokenSpeedDeployConfig,
  type TokenSpeedDeployConfig,
} from "../runtime/tokenspeedDeploy.js";
import { isDs4SpecializedGguf } from "../runtime/ds4Artifacts.js";
import { buildDs4ServerArgs, resolveDs4ServingHints } from "../runtime/ds4SessionKv.js";
import {
  DEFAULT_CLOUD_MODEL_CATALOG,
  isProviderConfigured,
  resolveCloudModelAlias,
  modelsMatchByAlias,
} from "./cloudModelCatalog.js";
import {
  isSpawnManagedWorkerKind,
  resolveWorkerAutoRestartConfig,
  workerRestartDelayMs,
  type WorkerAutoRestartConfig,
} from "./workerRestartPolicy.js";

export type ManagedModelSourceType = "huggingface" | "ollama" | "github" | "modelscope" | "direct" | "local" | "kgm";
export type ManagedModelArtifactStatus = "ready" | "downloading" | "pulling" | "error";
export type ManagedModelRuntimeKind =
  | "native"
  | "llama.cpp"
  | "ds4"
  | "tokenspeed"
  | "ollama"
  | "vllm"
  | "sglang"
  | "mlx"
  | "openai-compatible";
export type ManagedModelRuntimeStatus = "stopped" | "starting" | "running" | "error";
export type ManagedRuntimeHealthStatus = "unknown" | "healthy" | "degraded" | "unavailable";
export type ManagedRuntimeCircuitState = "closed" | "open" | "half_open";

export type ManagedLoraAdapter = {
  name: string;
  path: string;
  scale?: number;
};

export type ManagedModelArtifact = {
  id: string;
  name: string;
  modelName: string;
  sourceType: ManagedModelSourceType;
  sourceRef: string;
  sourceUrl?: string;
  downloadUrl?: string;
  revision?: string;
  filePath?: string;
  localPath?: string;
  sizeBytes?: number;
  sha256?: string;
  status: ManagedModelArtifactStatus;
  runtimeHints: ManagedModelRuntimeKind[];
  notes: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

export type ManagedModelRuntime = {
  id: string;
  name: string;
  modelName: string;
  runtime: ManagedModelRuntimeKind;
  status: ManagedModelRuntimeStatus;
  artifactId?: string;
  host: string;
  port: number;
  baseUrl: string;
  apiPath: string;
  mode: "chat" | "completions";
  apiKey?: string;
  upstreamModel: string;
  command?: string;
  args?: string[];
  /** LoRA adapters attached to worker spawn (vLLM / SGLang / llama.cpp) */
  loraAdapters?: ManagedLoraAdapter[];
  pid?: number;
  maxConcurrentRequests?: number;
  maxQueueSize?: number;
  retryMaxRetries?: number;
  circuitBreakerFailures?: number;
  circuitBreakerCooldownMs?: number;
  healthPath?: string;
  healthStatus?: ManagedRuntimeHealthStatus;
  lastProbeAt?: string;
  notes: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

export type ManagedRuntimeMetrics = {
  runtimeId: string;
  modelName: string;
  runtime: ManagedModelRuntimeKind;
  requestsTotal: number;
  successesTotal: number;
  errorsTotal: number;
  queueRejectedTotal: number;
  retriesTotal: number;
  inflightRequests: number;
  queuedRequests: number;
  avgLatencyMs: number;
  avgQueueWaitMs: number;
  avgTtftMs?: number;
  lastTtftMs?: number;
  avgOutputTokensPerSecond: number;
  avgTimePerOutputTokenMs: number;
  lastLatencyMs: number;
  lastQueueWaitMs: number;
  lastOutputTokensPerSecond?: number;
  avgKvResidentBytes?: number;
  lastKvResidentBytes?: number;
  lastRequestAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  circuitState: ManagedRuntimeCircuitState;
  circuitOpenUntil?: string;
  cacheHits: number;
  cacheMisses: number;
  /** Worker 进程自动重启累计次数 */
  restartsTotal: number;
  lastRestartAt?: string;
};

export type ManagedModelSummary = {
  id: string;
  modelName: string;
  name: string;
  sourceType?: ManagedModelSourceType;
  runtimeId?: string;
  runtime?: ManagedModelRuntimeKind;
  artifactId?: string;
  status: ManagedModelArtifactStatus | ManagedModelRuntimeStatus;
  running: boolean;
  localPath?: string;
  baseUrl?: string;
  metrics?: ManagedRuntimeMetrics;
  notes: string[];
};

export type ManagedModelPullRequest = {
  name?: string;
  modelName?: string;
  sourceType?: ManagedModelSourceType;
  sourceUrl?: string;
  sourceRef?: string;
  filePath?: string;
  revision?: string;
  authToken?: string;
  localPath?: string;
};

export type ManagedModelCreateRuntimeRequest = {
  name?: string;
  modelName?: string;
  /** Use "auto" to pick artifact.runtimeHints[0] (HF → worker closed-loop). */
  runtime: ManagedModelRuntimeKind | "auto";
  artifactId?: string;
  host?: string;
  port?: number;
  baseUrl?: string;
  apiPath?: string;
  mode?: "chat" | "completions";
  apiKey?: string;
  upstreamModel?: string;
  command?: string;
  args?: string[];
  loraAdapters?: ManagedLoraAdapter[];
  maxConcurrentRequests?: number;
  maxQueueSize?: number;
  retryMaxRetries?: number;
  circuitBreakerFailures?: number;
  circuitBreakerCooldownMs?: number;
  healthPath?: string;
};

export type ManagedModelCreateRequest = {
  kgmfile?: string;
  spec?: KgmfileSpec;
  pull?: ManagedModelPullRequest;
  runtime?: ManagedModelCreateRuntimeRequest;
  autoStart?: boolean;
};

type ManagedModelState = {
  artifacts: ManagedModelArtifact[];
  runtimes: ManagedModelRuntime[];
};

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
function resolveConfiguredModelStateRoot(configured: string): { stateRoot: string; legacyMonolithicCatalog?: string } {
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

type RuntimeExecutionState = {
  metrics: ManagedRuntimeMetrics;
  queue: Array<{
    enqueuedAt: number;
    run: () => Promise<void>;
    reject: (error: Error) => void;
  }>;
  seenPromptPrefixes: Set<string>;
  circuitOpenUntil?: number;
};

type ResolvedModelSource = {
  sourceType: ManagedModelSourceType;
  sourceRef: string;
  sourceUrl?: string;
  downloadUrl?: string;
  revision?: string;
  filePath?: string;
  modelName: string;
  name: string;
  runtimeHints: ManagedModelRuntimeKind[];
  authHeaders: Record<string, string>;
  metadata: Record<string, unknown>;
  notes: string[];
  localPath?: string;
};

export class ManagedModelManager {
  /** 分片存储根目录（`artifacts/`、`runtimes/`、`manifest.json`） */
  private stateRoot: string;
  private artifactDir: string;
  private state: ManagedModelState;
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private nativeRuntimes = new Map<string, NativeRuntimeEngine>();
  private executionState = new Map<string, RuntimeExecutionState>();
  private healthIntervalMs: number;
  private healthTimer?: NodeJS.Timeout;
  private llamaCppOverrides?: Partial<LlamaCppDeployConfig> | (() => Partial<LlamaCppDeployConfig>);
  private ds4Overrides?: Partial<Ds4DeployConfig> | (() => Partial<Ds4DeployConfig>);
  private tokenspeedOverrides?: Partial<TokenSpeedDeployConfig> | (() => Partial<TokenSpeedDeployConfig>);
  private workerRestartConfig: WorkerAutoRestartConfig;
  /** 主动 stop 的 runtime，exit 回调不触发自动重启 */
  private intentionalStops = new Set<string>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private restartAttempts = new Map<string, number>();

  constructor(options?: {
    statePath?: string;
    artifactDir?: string;
    /** Deploy-time llama.cpp gate (from ConfigStore.workers.llamaCpp or env). */
    llamaCpp?: Partial<LlamaCppDeployConfig> | (() => Partial<LlamaCppDeployConfig>);
    /** Deploy-time ds4 gate (from ConfigStore.workers.ds4 or env). */
    ds4?: Partial<Ds4DeployConfig> | (() => Partial<Ds4DeployConfig>);
    /** Optional TokenSpeed gate (default off). */
    tokenspeed?: Partial<TokenSpeedDeployConfig> | (() => Partial<TokenSpeedDeployConfig>);
  }) {
    const configured = options?.statePath ?? process.env.KGM_MODEL_STATE_PATH ?? "data/models/store";
    const { stateRoot, legacyMonolithicCatalog } = resolveConfiguredModelStateRoot(configured);
    this.stateRoot = stateRoot;
    this.artifactDir = path.resolve(options?.artifactDir ?? process.env.KGM_MODEL_ARTIFACT_DIR ?? "data/model-artifacts");
    this.healthIntervalMs = parseNumber(process.env.KGM_MODEL_HEALTHCHECK_INTERVAL_MS) ?? 15000;
    this.llamaCppOverrides = options?.llamaCpp;
    this.ds4Overrides = options?.ds4;
    this.tokenspeedOverrides = options?.tokenspeed;
    this.workerRestartConfig = resolveWorkerAutoRestartConfig();
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

  private resolveLlamaCppConfig() {
    const raw = typeof this.llamaCppOverrides === "function" ? this.llamaCppOverrides() : this.llamaCppOverrides;
    return resolveLlamaCppDeployConfig(raw);
  }

  private resolveDs4Config() {
    const raw = typeof this.ds4Overrides === "function" ? this.ds4Overrides() : this.ds4Overrides;
    return resolveDs4DeployConfig(raw);
  }

  private resolveTokenSpeedConfig() {
    const raw = typeof this.tokenspeedOverrides === "function" ? this.tokenspeedOverrides() : this.tokenspeedOverrides;
    return resolveTokenSpeedDeployConfig(raw);
  }

  close(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
    this.restartAttempts.clear();
    this.intentionalStops.clear();
    this.nativeRuntimes.clear();
  }

  listArtifacts(): ManagedModelArtifact[] {
    return [...this.state.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getArtifact(id: string): ManagedModelArtifact | undefined {
    return this.state.artifacts.find((item) => item.id === id);
  }

  listRuntimes(): ManagedModelRuntime[] {
    return [...this.state.runtimes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listModels(): ManagedModelSummary[] {
    const runtimeMap = new Map<string, ManagedModelRuntime>();
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
      } satisfies ManagedModelSummary;
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
      } satisfies ManagedModelSummary));

    return [...artifactSummaries, ...runtimeOnly].sort((a, b) => a.modelName.localeCompare(b.modelName));
  }

  listRunningModels(): ManagedModelSummary[] {
    return this.listModels().filter((item) => item.running);
  }

  getRuntime(id: string): ManagedModelRuntime | undefined {
    return this.state.runtimes.find((item) => item.id === id);
  }

  getRuntimeMetrics(id: string): ManagedRuntimeMetrics | undefined {
    return this.executionState.get(id)?.metrics;
  }

  async probeAllRuntimes(): Promise<ManagedModelRuntime[]> {
    const results: ManagedModelRuntime[] = [];
    for (const runtime of this.state.runtimes) {
      results.push(await this.probeRuntime(runtime.id));
    }
    return results;
  }

  async probeRuntime(id: string): Promise<ManagedModelRuntime> {
    const runtime = this.requireRuntime(id);
    const state = this.ensureRuntimeState(runtime);
    const now = new Date().toISOString();

    if (runtime.status === "stopped") {
      this.patchRuntime(id, { healthStatus: "unknown", lastProbeAt: now });
      return this.requireRuntime(id);
    }

    const pidAlive = runtime.pid ? isPidAlive(runtime.pid) : undefined;
    const endpointHealthy = await this.probeEndpoint(runtime);
    const nextHealth: ManagedRuntimeHealthStatus = endpointHealthy
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

    const nextStatus: ManagedModelRuntimeStatus =
      nextHealth === "unavailable" && runtime.runtime !== "openai-compatible"
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

  getPrometheusMetrics(): string {
    const lines: string[] = [];
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
    lines.push("# HELP kgm_runtime_restarts_total Worker process auto-restart count.");
    lines.push("# TYPE kgm_runtime_restarts_total counter");

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
      lines.push(`kgm_runtime_restarts_total{${labels}} ${metrics.restartsTotal ?? 0}`);
    }
    return `${lines.join("\n")}\n`;
  }

  listOpenAiModels(
    defaultModel?: string,
    defaultOwner = "kgm",
    options?: {
      configuredOnly?: boolean;
      configuredProviders?: import("../llm/providerFactory.js").ProviderConfig[];
    },
  ): Array<Record<string, unknown>> {
    const created = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const models: Array<Record<string, unknown>> = [];

    if (defaultModel) {
      seen.add(defaultModel);
      models.push({
        id: defaultModel,
        object: "model",
        created,
        owned_by: defaultOwner,
      });
    }

    const pushCloud = (id: string, ownedBy: string) => {
      const canonical = resolveCloudModelAlias(id);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      models.push({
        id: canonical,
        object: "model",
        created,
        owned_by: ownedBy,
        kgm: { cloud: true, provider: ownedBy, modelType: "cloud-model" },
      });
    };

    if (options?.configuredOnly) {
      for (const provider of options.configuredProviders ?? []) {
        if (!isProviderConfigured(provider)) continue;
        pushCloud(provider.model, provider.type);
      }
    } else {
      for (const entry of DEFAULT_CLOUD_MODEL_CATALOG) {
        pushCloud(entry.id, entry.owned_by);
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

  findRuntimeForModel(modelName: string): ManagedModelRuntime | undefined {
    const exact = this.state.runtimes.find(
      (runtime) => runtime.status === "running" && runtime.modelName === modelName,
    );
    if (exact) return exact;
    return this.state.runtimes.find(
      (runtime) => runtime.status === "running" && modelsMatchByAlias(runtime.modelName, modelName),
    );
  }

  /** Prefer explicit runtime id (session affinity); fall back to modelName. */
  findRuntimeForExecution(modelName: string, options?: CompletionOptions): ManagedModelRuntime | undefined {
    const runtimeId = resolvePreferredRuntimeId(options);
    if (runtimeId) {
      const byId = this.state.runtimes.find((runtime) => runtime.status === "running" && runtime.id === runtimeId);
      if (byId) {
        return byId;
      }
    }
    return this.findRuntimeForModel(modelName);
  }

  async completeWithManagedRuntime(modelName: string, prompt: string, options?: CompletionOptions): Promise<CompletionResult | null> {
    const runtime = this.findRuntimeForExecution(modelName, options);
    if (!runtime) {
      return null;
    }
    return this.executeRuntimeCompletion(runtime, prompt, options);
  }

  streamWithManagedRuntime(
    modelName: string,
    prompt: string,
    options?: CompletionOptions,
  ): AsyncIterable<CompletionStreamEvent> | null {
    const runtime = this.findRuntimeForExecution(modelName, options);
    if (!runtime) {
      return null;
    }
    return this.executeRuntimeCompletionStream(runtime, prompt, options);
  }

  async createModel(request: ManagedModelCreateRequest): Promise<{
    spec: KgmfileSpec;
    artifact: ManagedModelArtifact;
    runtime: ManagedModelRuntime;
  }> {
    const spec =
      request.spec ??
      (request.kgmfile ? parseKgmfile(request.kgmfile) : undefined);
    const requests = spec
      ? toModelRequests(spec)
      : {
          pull: request.pull ?? {},
          runtime: request.runtime ?? ({ runtime: "openai-compatible" } as ManagedModelCreateRuntimeRequest),
        };

    const artifact = await this.pull(requests.pull);
    const requestedRuntime =
      request.runtime?.runtime
      ?? (requests.runtime.runtime === "openai-compatible" && artifact.runtimeHints.includes("native")
        ? "native"
        : requests.runtime.runtime === "openai-compatible" && !artifact.runtimeHints.includes("native")
          ? "auto"
          : requests.runtime.runtime);
    const runtime = this.createRuntime({
      ...requests.runtime,
      runtime: requestedRuntime,
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

  deleteManagedEntity(id: string): { deleted: "runtime" | "artifact" | "model"; id: string } {
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

  async pull(request: ManagedModelPullRequest): Promise<ManagedModelArtifact> {
    const resolved = resolveModelSource(request);
    const existing = this.state.artifacts.find(
      (item) =>
        item.sourceType === resolved.sourceType &&
        item.sourceRef === resolved.sourceRef &&
        (item.filePath ?? "") === (resolved.filePath ?? ""),
    );
    if (existing && existing.status === "ready") {
      return existing;
    }

    const now = new Date().toISOString();
    const artifact: ManagedModelArtifact =
      existing ??
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
        tags: [],
        metadata: resolved.metadata,
        createdAt: now,
        updatedAt: now,
      };

    if (!existing) {
      this.state.artifacts.push(artifact);
    } else {
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
      } else if (resolved.sourceType === "local" && resolved.localPath) {
        this.linkLocalArtifact(artifact, resolved.localPath);
      } else if (resolved.downloadUrl) {
        await this.downloadArtifact(artifact, resolved);
      } else {
        this.patchArtifact(artifact.id, {
          status: "ready",
          notes: [...artifact.notes, "Repository reference recorded. Runtime may pull lazily from upstream when started."],
        });
      }
    } catch (error) {
      this.patchArtifact(artifact.id, {
        status: "error",
        lastError: String(error),
      });
      throw error;
    }

    return this.requireArtifact(artifact.id);
  }

  createRuntime(request: ManagedModelCreateRuntimeRequest): ManagedModelRuntime {
    const artifact = request.artifactId ? this.requireArtifact(request.artifactId) : undefined;
    const assessment = assessArtifactExecution(artifact);
    const llamaCpp = this.resolveLlamaCppConfig();
    const ds4 = this.resolveDs4Config();
    const tokenspeed = this.resolveTokenSpeedConfig();
    const runtime = resolveRuntimeKind({
      requested: request.runtime,
      artifact,
      llamaCpp,
      ds4,
      tokenspeed,
    });
    if (runtime === "llama.cpp") {
      if (!wouldAttachManagedKind("llama.cpp")) {
        assertLlamaCppCallable(llamaCpp);
      }
    }
    if (runtime === "ds4") {
      if (!wouldAttachManagedKind("ds4")) {
        assertDs4Callable(ds4);
      }
    }
    if (runtime === "tokenspeed") {
      assertTokenSpeedCallable(tokenspeed);
    }
    const host = request.host ?? "127.0.0.1";
    const port = request.port ?? (runtime === "tokenspeed" ? tokenspeed.port : defaultPort(runtime));
    const baseUrl =
      request.baseUrl ??
      (runtime === "tokenspeed" && tokenspeed.baseUrl
        ? tokenspeed.baseUrl
        : defaultBaseUrl(runtime, host, port));
    const apiPath = request.apiPath ?? defaultApiPath(runtime);
    const mode = request.mode ?? "chat";
    const modelName = request.modelName ?? artifact?.modelName ?? `managed-${runtime}-${port}`;
    const name = request.name ?? modelName;
    const upstreamModel = request.upstreamModel ?? artifact?.metadata.repoId?.toString() ?? artifact?.sourceRef ?? modelName;
    const createdAt = new Date().toISOString();

    const instance: ManagedModelRuntime = {
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
      loraAdapters: request.loraAdapters?.map((adapter) => ({ ...adapter })),
      maxConcurrentRequests: request.maxConcurrentRequests ?? defaultMaxConcurrent(runtime),
      maxQueueSize: request.maxQueueSize ?? defaultMaxQueueSize(runtime),
      retryMaxRetries: request.retryMaxRetries ?? defaultRetryMaxRetries(),
      circuitBreakerFailures: request.circuitBreakerFailures ?? defaultCircuitBreakerFailures(),
      circuitBreakerCooldownMs: request.circuitBreakerCooldownMs ?? defaultCircuitBreakerCooldownMs(),
      healthPath: request.healthPath ?? "/health",
      healthStatus: "unknown",
      notes: [
        ...runtimeNotes(runtime, artifact),
        `execution_path:${assessment.path}`,
        `weight_format:${assessment.format}`,
        `execution_reason:${assessment.reason}`,
        ...(request.runtime === "auto" ? ["runtime_resolved_from:auto"] : []),
      ],
      tags: [],
      metadata: {
        ...(artifact ? { artifactId: artifact.id, sourceType: artifact.sourceType } : {}),
        executionPolicy: assessment,
        resolvedFrom: request.runtime === "auto" ? "auto" : "explicit",
      },
      createdAt,
      updatedAt: createdAt,
    };

    this.state.runtimes.push(instance);
    this.ensureRuntimeState(instance);
    this.persist();
    return instance;
  }

  async startRuntime(id: string): Promise<ManagedModelRuntime> {
    const runtime = this.requireRuntime(id);
    if (runtime.status === "running" && this.processes.has(id)) {
      return runtime;
    }

    this.intentionalStops.delete(id);
    this.clearRestartTimer(id);
    this.patchRuntime(id, { status: "starting", lastError: undefined });
    const next = this.requireRuntime(id);

    if (next.runtime === "openai-compatible") {
      this.ensureRuntimeState(next);
      this.patchRuntime(id, { status: "running", healthStatus: "unknown" });
      const attached = this.requireRuntime(id);
      const ok = await this.probeEndpoint(attached);
      this.patchRuntime(id, { healthStatus: ok ? "healthy" : "degraded" });
      return this.requireRuntime(id);
    }

    if (next.runtime === "tokenspeed") {
      try {
        const tsCfg = this.resolveTokenSpeedConfig();
        const status = assertTokenSpeedCallable(tsCfg);
        // Attach-first (Ollama-style): BASE_URL / ATTACH / runtime already has external baseUrl
        const attachPreferred =
          status.attachPreferred ||
          Boolean(status.config.baseUrl) ||
          Boolean(next.baseUrl && next.notes?.some((n) => n.startsWith("tokenspeed_attach:")));
        if (attachPreferred && (status.config.baseUrl || next.baseUrl)) {
          const baseUrl = status.config.baseUrl ?? next.baseUrl;
          this.ensureRuntimeState(next);
          this.patchRuntime(id, {
            status: "running",
            healthStatus: "unknown",
            baseUrl,
            notes: Array.from(
              new Set([
                ...(next.notes ?? []),
                `tokenspeed_attach:${baseUrl}`,
                "tokenspeed_kernels_external:not_merged_into_native_gpu",
                "tokenspeed_mode:attach",
              ]),
            ),
            metadata: {
              ...next.metadata,
              tokenspeedMode: "attach",
            },
          });
          const attached = this.requireRuntime(id);
          const ok = await this.probeEndpoint(attached);
          this.patchRuntime(id, { healthStatus: ok ? "healthy" : "degraded" });
          return this.requireRuntime(id);
        }
        if (status.resolvedCommand) {
          this.patchRuntime(id, {
            command: status.resolvedCommand,
            notes: Array.from(
              new Set([
                ...(next.notes ?? []),
                `tokenspeed_binary:${status.resolvedCommand}`,
                ...(status.version ? [`tokenspeed_version:${status.version}`] : []),
                "tokenspeed_kernels_external:not_merged_into_native_gpu",
                "tokenspeed_mode:spawn",
              ]),
            ),
            metadata: {
              ...next.metadata,
              tokenspeedMode: "spawn",
            },
          });
        }
      } catch (error) {
        this.patchRuntime(id, { status: "error", lastError: String(error) });
        throw error;
      }
    }

    if (next.runtime === "native") {
      const artifact = next.artifactId ? this.requireArtifact(next.artifactId) : undefined;
      const assessment = assessArtifactExecution(artifact);
      if (!assessment.nativeAllowed) {
        this.patchRuntime(id, { status: "error", lastError: assessment.reason });
        throw new Error(
          `native_runtime_not_allowed:${assessment.reason};use_via_worker:${assessment.recommendedRuntimes.join(",")}`,
        );
      }
      const modelPath = artifact?.localPath;
      if (!modelPath) {
        throw new Error("Yueli KGM Runtime requires local model artifact");
      }
      const engine = new NativeRuntimeEngine(modelPath, {
        modelRef: resolveNativeModelRef(artifact, next),
        promptCacheLimit: parseValidatedNumber(process.env.KGM_NATIVE_PROMPT_CACHE_SIZE, 8, 1, 1024, "KGM_NATIVE_PROMPT_CACHE_SIZE"),
        sessionCacheLimit: parseValidatedNumber(process.env.KGM_NATIVE_SESSION_CACHE_SIZE, 64, 1, 10000, "KGM_NATIVE_SESSION_CACHE_SIZE"),
        schedulerMaxBatchSize: parseValidatedNumber(process.env.KGM_NATIVE_SCHEDULER_MAX_BATCH_SIZE, 8, 1, 64, "KGM_NATIVE_SCHEDULER_MAX_BATCH_SIZE"),
        schedulerMaxPrefillsPerTick: parseValidatedNumber(process.env.KGM_NATIVE_SCHEDULER_MAX_PREFILLS_PER_TICK, 4, 1, 16, "KGM_NATIVE_SCHEDULER_MAX_PREFILLS_PER_TICK"),
        kvCacheMode: process.env.KGM_NATIVE_KV_CACHE_MODE === "dense" ? "dense" : "paged",
        kvPageSize: parseValidatedNumber(process.env.KGM_NATIVE_KV_PAGE_SIZE, 16, 1, 256, "KGM_NATIVE_KV_PAGE_SIZE"),
        cachedKvPageBudget: parseValidatedNumber(process.env.KGM_NATIVE_CACHED_KV_PAGE_BUDGET, 256, 1, 4096, "KGM_NATIVE_CACHED_KV_PAGE_BUDGET"),
        servingBackend: process.env.KGM_NATIVE_SERVING_BACKEND === "native-core"
          ? "native-core"
          : process.env.KGM_NATIVE_SERVING_BACKEND === "js-reference"
            ? "js-reference"
            : process.env.KGM_NATIVE_SERVING_BACKEND === "native-gpu"
              ? "native-gpu"
              : "auto",
        seed: parseValidatedNumber(process.env.KGM_NATIVE_RUNTIME_SEED, 1, 0, Number.MAX_SAFE_INTEGER, "KGM_NATIVE_RUNTIME_SEED"),
      });
      const manifest = engine.manifest();
      const nativeMetadata = engine.metadata();
      const nativeCore = getNativeCoreBindingStatus();
      const nativeDiagnostics = nativeMetadata.notes
        .filter((note) => note !== "GGUF metadata parsed successfully.")
        .filter((note) => note !== "Executable GGUF tensors loaded into the CPU reference backend.")
        .filter((note) => note !== "Safetensors header parsed successfully.")
        .filter((note) => note !== "Sharded safetensors index parsed successfully.")
        .map((note) => `Yueli KGM Runtime diagnostics: ${note}`);
      const retainedNotes = next.notes.filter(
        (note) =>
          !note.startsWith("Yueli KGM Runtime model format:") &&
          !note.startsWith("Yueli KGM Runtime execution backend:") &&
          !note.startsWith("Yueli KGM Runtime serving backend:") &&
          !note.startsWith("Yueli KGM Runtime backend hints:") &&
          !note.startsWith("Yueli KGM Runtime core binding:") &&
          !note.startsWith("Yueli KGM Runtime diagnostics:"),
      );
      this.nativeRuntimes.set(id, engine);
      this.ensureRuntimeState(next);
      this.patchRuntime(id, {
        status: "running",
        healthStatus: engine.isExecutable() ? "healthy" : "degraded",
        notes: [
          ...retainedNotes,
          `Yueli KGM Runtime model format: ${nativeMetadata.format}`,
          `Yueli KGM Runtime execution backend: ${engine.executionBackend() ?? "none"}`,
          `Yueli KGM Runtime serving backend: ${engine.servingBackend()}`,
          `Yueli KGM Runtime backend hints: ${manifest.backendHints.join(", ")}`,
          nativeCore.configured
            ? `Yueli KGM Runtime core binding: ${nativeCore.available ? "available" : `unavailable (${nativeCore.reason ?? "unknown"})`}`
            : "Yueli KGM Runtime core binding: not configured",
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
      const attached = this.requireRuntime(id);
      const ok = await this.probeEndpoint(attached);
      this.patchRuntime(id, { healthStatus: ok ? "healthy" : "degraded" });
      return this.requireRuntime(id);
    }

    // Attach only when KGM_*_ATTACH=1 or prefer meta/notes (BASE_URL alone serves provider)
    const attachBaseUrl = resolveManagedAttachBaseUrl(next);
    if (attachBaseUrl) {
      this.ensureRuntimeState(next);
      this.patchRuntime(id, {
        status: "running",
        healthStatus: "unknown",
        baseUrl: attachBaseUrl,
        notes: Array.from(
          new Set([
            ...(next.notes ?? []),
            `${next.runtime}_attach:${attachBaseUrl}`,
            `${next.runtime}_mode:attach`,
          ]),
        ),
        metadata: {
          ...next.metadata,
          attachMode: "attach",
        },
      });
      const attached = this.requireRuntime(id);
      const ok = await this.probeEndpoint(attached);
      this.patchRuntime(id, { healthStatus: ok ? "healthy" : "degraded" });
      return this.requireRuntime(id);
    }

    if (next.runtime === "llama.cpp") {
      try {
        const status = assertLlamaCppCallable(this.resolveLlamaCppConfig());
        if (status.resolvedCommand) {
          this.patchRuntime(id, {
            command: status.resolvedCommand,
            notes: Array.from(
              new Set([...(next.notes ?? []), `llama_cpp_binary:${status.resolvedCommand}`, ...(status.version ? [`llama_cpp_version:${status.version}`] : [])]),
            ),
          });
        }
      } catch (error) {
        this.patchRuntime(id, { status: "error", lastError: String(error) });
        throw error;
      }
    }

    if (next.runtime === "ds4") {
      try {
        const status = assertDs4Callable(this.resolveDs4Config());
        if (status.resolvedCommand) {
          this.patchRuntime(id, {
            command: status.resolvedCommand,
            notes: Array.from(
              new Set([
                ...(next.notes ?? []),
                `ds4_binary:${status.resolvedCommand}`,
                ...(status.version ? [`ds4_version:${status.version}`] : []),
                "ds4_kernels_external:not_merged_into_native_gpu",
              ]),
            ),
          });
        }
      } catch (error) {
        this.patchRuntime(id, { status: "error", lastError: String(error) });
        throw error;
      }
    }

    const spawnConfig = this.buildSpawnConfig(this.requireRuntime(id));
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
      if (!current) {
        return;
      }
      if (this.intentionalStops.has(id) || current.status === "stopped") {
        this.intentionalStops.delete(id);
        return;
      }
      const exitError = code === 0 ? undefined : stderr || `process_exit:${code ?? "unknown"}`;
      this.patchRuntime(id, {
        status: "error",
        lastError: exitError ?? `process_exit:${code ?? "unknown"}`,
        pid: undefined,
        healthStatus: "unavailable",
      });
      this.scheduleWorkerAutoRestart(id, code);
    });

    this.patchRuntime(id, {
      status: "starting",
      healthStatus: "unknown",
      pid: child.pid,
      command: spawnConfig.command,
      args: spawnConfig.args,
    });

    await delay(800);
    const afterDelay = this.requireRuntime(id);
    if (afterDelay.status === "error" || !this.processes.has(id)) {
      return afterDelay;
    }
    const ok = await this.probeEndpoint(afterDelay);
    this.patchRuntime(id, {
      status: "running",
      healthStatus: ok ? "healthy" : "degraded",
    });
    return this.requireRuntime(id);
  }

  stopRuntime(id: string): ManagedModelRuntime {
    const runtime = this.requireRuntime(id);
    this.intentionalStops.add(id);
    this.clearRestartTimer(id);
    this.restartAttempts.delete(id);
    this.rejectQueuedRequests(id, new Error(`managed_runtime_stopped:${id}`));
    if (runtime.runtime === "native") {
      this.nativeRuntimes.delete(id);
    }
    const child = this.processes.get(id);
    const targetPid = child?.pid ?? runtime.pid;
    if (targetPid) {
      try {
        process.kill(targetPid, "SIGTERM");
      } catch {
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

  private clearRestartTimer(id: string): void {
    const timer = this.restartTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(id);
    }
  }

  private scheduleWorkerAutoRestart(id: string, exitCode: number | null): void {
    const cfg = this.workerRestartConfig;
    if (!cfg.enabled || cfg.maxAttempts <= 0) {
      return;
    }
    const runtime = this.getRuntime(id);
    if (!runtime || !isSpawnManagedWorkerKind(runtime.runtime)) {
      return;
    }
    if (this.intentionalStops.has(id)) {
      return;
    }

    const nextAttempt = (this.restartAttempts.get(id) ?? 0) + 1;
    if (nextAttempt > cfg.maxAttempts) {
      this.patchRuntime(id, {
        status: "error",
        lastError:
          (runtime.lastError ? `${runtime.lastError}; ` : "") +
          `auto_restart_exhausted:${cfg.maxAttempts}`,
        healthStatus: "unavailable",
      });
      return;
    }

    this.restartAttempts.set(id, nextAttempt);
    const delayMs = workerRestartDelayMs(nextAttempt, cfg);
    this.clearRestartTimer(id);
    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      if (this.intentionalStops.has(id)) {
        return;
      }
      const state = this.ensureRuntimeState(this.requireRuntime(id));
      state.metrics.restartsTotal += 1;
      state.metrics.lastRestartAt = new Date().toISOString();
      this.patchRuntime(id, {
        notes: Array.from(
          new Set([
            ...(this.requireRuntime(id).notes ?? []),
            `auto_restart_attempt:${nextAttempt}`,
            `auto_restart_exit_code:${exitCode ?? "null"}`,
          ]),
        ),
      });
      void this.startRuntime(id)
        .then(() => {
          // 成功拉起后清零连续崩溃计数；健康探测仍由 health checker 负责
          this.restartAttempts.delete(id);
        })
        .catch((error) => {
          this.patchRuntime(id, {
            status: "error",
            lastError: `auto_restart_failed:${String(error)}`,
            healthStatus: "unavailable",
          });
          this.scheduleWorkerAutoRestart(id, exitCode);
        });
    }, delayMs);
    this.restartTimers.set(id, timer);
  }

  private async executeRuntimeCompletion(
    runtime: ManagedModelRuntime,
    prompt: string,
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
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
    } catch (error) {
      updateMetricsOnError(state.metrics, String(error));
      this.maybeOpenCircuit(runtime, state);
      this.patchRuntime(runtime.id, {
        healthStatus: "degraded",
        lastError: String(error),
      });
      throw error as Error;
    } finally {
      this.releaseRuntimeSlot(runtime, state);
    }
  }

  private async *executeRuntimeCompletionStream(
    runtime: ManagedModelRuntime,
    prompt: string,
    options?: CompletionOptions,
  ): AsyncIterable<CompletionStreamEvent> {
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
    state.metrics.lastRequestAt = new Date().toISOString();
    const startedAt = Date.now();
    let finalResult: CompletionResult | undefined;

    try {
      if (runtime.runtime === "native") {
        const engine = this.nativeRuntimes.get(runtime.id);
        if (!engine) {
          throw new Error(`Yueli KGM Runtime not started:${runtime.id}`);
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
      } else {
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
    } catch (error) {
      updateMetricsOnError(state.metrics, String(error));
      this.maybeOpenCircuit(runtime, state);
      this.patchRuntime(runtime.id, {
        healthStatus: "degraded",
        lastError: String(error),
      });
      throw error;
    } finally {
      this.releaseRuntimeSlot(runtime, state);
    }
  }

  private async executeWithRetries(
    runtime: ManagedModelRuntime,
    prompt: string,
    options: CompletionOptions | undefined,
    state: RuntimeExecutionState,
  ): Promise<CompletionResult> {
    const maxRetries = runtime.retryMaxRetries ?? defaultRetryMaxRetries();
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= maxRetries) {
      try {
        if (runtime.runtime === "native") {
          const engine = this.nativeRuntimes.get(runtime.id);
          if (!engine) {
            throw new Error(`Yueli KGM Runtime not started:${runtime.id}`);
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
      } catch (error) {
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

  private drainQueue(runtime: ManagedModelRuntime, state: RuntimeExecutionState): void {
    const limit = runtime.maxConcurrentRequests ?? defaultMaxConcurrent(runtime.runtime);
    while (state.metrics.inflightRequests < limit && state.queue.length > 0) {
      const next = state.queue.shift();
      if (!next) {
        break;
      }
      // 唤醒前先占住 slot，避免微任务批量唤醒导致超发并发
      state.metrics.inflightRequests += 1;
      state.metrics.queuedRequests = state.queue.length;
      void next.run();
    }
  }

  private async acquireRuntimeSlot(runtime: ManagedModelRuntime, state: RuntimeExecutionState): Promise<number> {
    const enqueuedAt = Date.now();
    const limit = runtime.maxConcurrentRequests ?? defaultMaxConcurrent(runtime.runtime);
    if (state.metrics.inflightRequests < limit) {
      state.metrics.inflightRequests += 1;
      return enqueuedAt;
    }
    if (state.queue.length >= (runtime.maxQueueSize ?? defaultMaxQueueSize(runtime.runtime))) {
      state.metrics.queueRejectedTotal += 1;
      state.metrics.lastError = "queue_full";
      state.metrics.lastErrorAt = new Date().toISOString();
      throw new Error(`managed_runtime_queue_full:${runtime.id}`);
    }
    await new Promise<void>((resolve, reject) => {
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

  private releaseRuntimeSlot(runtime: ManagedModelRuntime, state: RuntimeExecutionState): void {
    state.metrics.inflightRequests = Math.max(0, state.metrics.inflightRequests - 1);
    state.metrics.queuedRequests = state.queue.length;
    this.drainQueue(runtime, state);
  }

  private rejectQueuedRequests(runtimeId: string, error: Error): void {
    const state = this.executionState.get(runtimeId);
    if (!state || state.queue.length === 0) {
      return;
    }
    for (const item of state.queue.splice(0)) {
      item.reject(error);
    }
    state.metrics.queuedRequests = 0;
  }

  private ensureRuntimeState(runtime: ManagedModelRuntime): RuntimeExecutionState {
    const existing = this.executionState.get(runtime.id);
    if (existing) {
      return existing;
    }
    const created: RuntimeExecutionState = {
      metrics: createRuntimeMetrics(runtime),
      queue: [],
      seenPromptPrefixes: new Set<string>(),
    };
    this.executionState.set(runtime.id, created);
    return created;
  }

  private isCircuitOpen(state: RuntimeExecutionState): boolean {
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

  private maybeOpenCircuit(runtime: ManagedModelRuntime, state: RuntimeExecutionState): void {
    const threshold = runtime.circuitBreakerFailures ?? defaultCircuitBreakerFailures();
    if (state.metrics.consecutiveFailures < threshold) {
      return;
    }
    const cooldown = runtime.circuitBreakerCooldownMs ?? defaultCircuitBreakerCooldownMs();
    state.circuitOpenUntil = Date.now() + cooldown;
    state.metrics.circuitState = "open";
    state.metrics.circuitOpenUntil = new Date(state.circuitOpenUntil).toISOString();
  }

  private updateCacheMetrics(state: RuntimeExecutionState, prompt: string): void {
    const prefixHash = createHash("sha256").update(prompt.slice(0, 2048)).digest("hex");
    if (state.seenPromptPrefixes.has(prefixHash)) {
      state.metrics.cacheHits += 1;
      return;
    }
    state.seenPromptPrefixes.add(prefixHash);
    state.metrics.cacheMisses += 1;
  }

  private startHealthChecker(): void {
    if (this.healthTimer || this.healthIntervalMs <= 0) {
      return;
    }
    this.healthTimer = setInterval(() => {
      void this.probeAllRuntimes().catch(() => {});
    }, this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  private async probeEndpoint(runtime: ManagedModelRuntime): Promise<boolean> {
    if (runtime.runtime === "native") {
      return this.nativeRuntimes.get(runtime.id)?.isExecutable() ?? false;
    }
    const candidates = buildProbeUrls(runtime);
    const timeoutMs = parseNumber(process.env.KGM_MODEL_RUNTIME_PROBE_TIMEOUT_MS) ?? 2500;
    for (const url of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: runtime.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {},
          signal: controller.signal,
        });
        // Auth required still means the endpoint is reachable; 404 is not healthy.
        if (response.ok || response.status === 401 || response.status === 403) {
          return true;
        }
      } catch {
        // keep trying
      } finally {
        clearTimeout(timer);
      }
    }
    return false;
  }

  private async pullFromOllama(artifact: ManagedModelArtifact, resolved: ResolvedModelSource): Promise<void> {
    const base = normalizeOllamaDaemonBase(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434");
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
    const data = (await response.json()) as Record<string, unknown>;
    this.patchArtifact(artifact.id, {
      status: "ready",
      metadata: {
        ...artifact.metadata,
        ollama: data,
      },
      notes: [...artifact.notes, "Pulled into local Ollama model store."],
    });
  }

  private async downloadArtifact(artifact: ManagedModelArtifact, resolved: ResolvedModelSource): Promise<void> {
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
    const filename = sanitizeFilename(
      path.basename(resolved.filePath ?? new URL(downloadUrl).pathname) || `${artifact.modelName}.bin`,
    );
    const artifactDir = path.join(this.artifactDir, artifact.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const destination = path.join(artifactDir, filename);
    const writer = fs.createWriteStream(destination);
    const body = Readable.fromWeb(response.body as any);
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

  private linkLocalArtifact(artifact: ManagedModelArtifact, localPath: string): void {
    const resolved = path.resolve(localPath);
    const stat = fs.statSync(resolved);
    this.patchArtifact(artifact.id, {
      status: "ready",
      localPath: resolved,
      sizeBytes: stat.isFile() ? stat.size : undefined,
      notes: [...artifact.notes, `Mounted local model artifact at ${resolved}`],
    });
  }

  private buildSpawnConfig(runtime: ManagedModelRuntime): {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  } {
    const artifact = runtime.artifactId ? this.requireArtifact(runtime.artifactId) : undefined;
    const modelRef = artifact?.localPath ?? artifact?.metadata.repoId?.toString() ?? artifact?.sourceRef ?? runtime.upstreamModel;
    
    const config = this.buildSpawnConfigInternal(runtime, modelRef, artifact);
    
    this.validateSpawnConfig(config);
    
    return config;
  }
  
  private buildSpawnConfigInternal(runtime: ManagedModelRuntime, modelRef: string | undefined, artifact: ManagedModelArtifact | undefined): {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  } {
    switch (runtime.runtime) {
      case "llama.cpp":
        if (!artifact?.localPath) {
          throw new Error("llama.cpp runtime requires a downloaded local artifact");
        }
        return {
          command: runtime.command ?? defaultCommand("llama.cpp"),
          args:
            runtime.args ??
            [
              "-m",
              artifact.localPath,
              "--host",
              runtime.host,
              "--port",
              String(runtime.port),
              ...buildLoraSpawnArgs("llama.cpp", runtime.loraAdapters),
            ],
        };
      case "ds4":
        if (!artifact?.localPath) {
          throw new Error("ds4 runtime requires a downloaded local artifact (DeepSeek V4 / GLM specialized GGUF)");
        }
        return {
          command: runtime.command ?? defaultCommand("ds4"),
          args: runtime.args ?? buildDs4ServerArgs({
            modelPath: artifact.localPath,
            host: runtime.host,
            port: runtime.port,
            hints: resolveDs4ServingHints(),
          }),
          cwd: this.resolveDs4Config().chdir,
        };
      case "vllm":
        return {
          command: runtime.command ?? defaultCommand("vllm"),
          args:
            runtime.args ??
            [
              "serve",
              modelRef || "",
              "--host",
              runtime.host,
              "--port",
              String(runtime.port),
              ...buildLoraSpawnArgs("vllm", runtime.loraAdapters),
            ],
          env: runtime.apiKey ? { VLLM_API_KEY: runtime.apiKey } : undefined,
        };
      case "sglang":
        return {
          command: runtime.command ?? defaultCommand("sglang"),
          args:
            runtime.args ??
            [
              "-m",
              "sglang.launch_server",
              "--model-path",
              modelRef || "",
              "--host",
              runtime.host,
              "--port",
              String(runtime.port),
              ...buildLoraSpawnArgs("sglang", runtime.loraAdapters),
            ],
        };
      case "mlx":
        if (!modelRef) {
          throw new Error("mlx_runtime_requires_model_path_or_upstream");
        }
        return {
          command: runtime.command ?? defaultCommand("mlx"),
          args:
            runtime.args ??
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
      case "tokenspeed": {
        const ts = this.resolveTokenSpeedConfig();
        return {
          command: runtime.command ?? defaultCommand("tokenspeed"),
          args:
            runtime.args ??
            buildTokenSpeedServerArgs({
              host: runtime.host,
              port: runtime.port,
              modelPath: artifact?.localPath,
              toolCallParser: ts.toolCallParser,
              reasoningParser: ts.reasoningParser,
              enablePrefixCaching: ts.enablePrefixCaching,
              extraArgs: ts.extraArgs,
            }),
        };
      }
      case "native":
        throw new Error("Yueli KGM Runtime is single process and does not spawn external workers");
      case "openai-compatible":
        throw new Error("openai-compatible runtime attaches to an external endpoint and does not spawn");
      default: {
        const _exhaustive: never = runtime.runtime;
        throw new Error(`unsupported_runtime:${_exhaustive}`);
      }
    }
  }
  
  private validateSpawnConfig(config: { command: string; args: string[] }): void {
    const dangerousPatterns = [
      /[;&|`$<>]/,                    // 命令分隔符和重定向
      /\$\(/,                         // 命令替换
      /\b(cat|rm|cp|mv|chmod|chown|curl|wget|nc|netcat)\b/i, // 危险命令
      /\/etc\/|\/bin\/|\/usr\/|\/home\//i,              // 敏感路径
    ];
    
    if (!config.command || config.command.trim().length === 0) {
      throw new Error("spawn_config_requires_command");
    }
    
    if (dangerousPatterns.some(pattern => pattern.test(config.command))) {
      throw new Error(`unsafe_command_detected: ${config.command}`);
    }
    
    for (const arg of config.args) {
      if (dangerousPatterns.some(pattern => pattern.test(arg))) {
        throw new Error(`unsafe_argument_detected: ${arg}`);
      }
    }
    
    if (config.command.includes('..')) {
      throw new Error("command_path_traversal_detected");
    }
    
    for (const arg of config.args) {
      if (arg.includes('..')) {
        throw new Error(`argument_path_traversal_detected: ${arg}`);
      }
    }
  }

  private createRuntimeClient(runtime: ManagedModelRuntime): LlmClient {
    return new HttpLlmClient({
      baseUrl: runtime.baseUrl,
      model: runtime.upstreamModel,
      path: runtime.apiPath,
      apiKey: runtime.apiKey,
      mode: runtime.mode,
      timeoutMs: parseNumber(process.env.KGM_MODEL_RUNTIME_TIMEOUT_MS) ?? 120000,
    });
  }

  private patchArtifact(id: string, patch: Partial<ManagedModelArtifact>): void {
    const artifact = this.state.artifacts.find((item) => item.id === id);
    if (!artifact) {
      throw new Error(`artifact_not_found:${id}`);
    }
    Object.assign(artifact, patch, { updatedAt: new Date().toISOString() });
    this.persist();
  }

  private patchRuntime(id: string, patch: Partial<ManagedModelRuntime>): void {
    const runtime = this.state.runtimes.find((item) => item.id === id);
    if (!runtime) {
      throw new Error(`runtime_not_found:${id}`);
    }
    Object.assign(runtime, patch, { updatedAt: new Date().toISOString() });
    this.persist();
  }

  /**
   * 为模型添加标签
   */
  addTags(id: string, tags: string[]): void {
    // 先尝试查找 artifact
    const artifact = this.getArtifact(id);
    if (artifact) {
      const newTags = [...new Set([...artifact.tags, ...tags])];
      this.patchArtifact(id, { tags: newTags });
      return;
    }
    // 再尝试查找 runtime
    const runtime = this.getRuntime(id);
    if (runtime) {
      const newTags = [...new Set([...runtime.tags, ...tags])];
      this.patchRuntime(id, { tags: newTags });
      return;
    }
    throw new Error(`model_not_found:${id}`);
  }

  /**
   * Attach LoRA adapters to a managed runtime (applied on next start/restart).
   */
  attachLoraAdapters(runtimeId: string, adapters: ManagedLoraAdapter[]): ManagedModelRuntime {
    const runtime = this.requireRuntime(runtimeId);
    if (runtime.runtime === "native" || runtime.runtime === "openai-compatible" || runtime.runtime === "ollama" || runtime.runtime === "tokenspeed") {
      throw new Error(`lora_not_supported_for_runtime:${runtime.runtime}`);
    }
    const normalized = adapters
      .map((adapter) => ({
        name: adapter.name.trim(),
        path: adapter.path.trim(),
        ...(typeof adapter.scale === "number" ? { scale: adapter.scale } : {}),
      }))
      .filter((adapter) => adapter.name && adapter.path);
    if (normalized.length === 0) {
      throw new Error("lora_adapters_required");
    }
    const merged = [...(runtime.loraAdapters ?? [])];
    for (const adapter of normalized) {
      const idx = merged.findIndex((item) => item.name === adapter.name);
      if (idx >= 0) {
        merged[idx] = adapter;
      } else {
        merged.push(adapter);
      }
    }
    this.patchRuntime(runtimeId, {
      loraAdapters: merged,
      notes: Array.from(new Set([...(runtime.notes ?? []), "lora_adapters_attached"])),
    });
    return this.requireRuntime(runtimeId);
  }

  listLoraAdapters(runtimeId: string): ManagedLoraAdapter[] {
    return [...(this.requireRuntime(runtimeId).loraAdapters ?? [])];
  }

  /**
   * 移除模型标签
   */
  removeTags(id: string, tags: string[]): void {
    const artifact = this.getArtifact(id);
    if (artifact) {
      const newTags = artifact.tags.filter((tag) => !tags.includes(tag));
      this.patchArtifact(id, { tags: newTags });
      return;
    }
    const runtime = this.getRuntime(id);
    if (runtime) {
      const newTags = runtime.tags.filter((tag) => !tags.includes(tag));
      this.patchRuntime(id, { tags: newTags });
      return;
    }
    throw new Error(`model_not_found:${id}`);
  }

  /**
   * 设置模型标签（完全替换）
   */
  setTags(id: string, tags: string[]): void {
    const artifact = this.getArtifact(id);
    if (artifact) {
      this.patchArtifact(id, { tags: [...new Set(tags)] });
      return;
    }
    const runtime = this.getRuntime(id);
    if (runtime) {
      this.patchRuntime(id, { tags: [...new Set(tags)] });
      return;
    }
    throw new Error(`model_not_found:${id}`);
  }

  private requireArtifact(id: string): ManagedModelArtifact {
    const artifact = this.getArtifact(id);
    if (!artifact) {
      throw new Error(`artifact_not_found:${id}`);
    }
    return artifact;
  }

  private requireRuntime(id: string): ManagedModelRuntime {
    const runtime = this.getRuntime(id);
    if (!runtime) {
      throw new Error(`runtime_not_found:${id}`);
    }
    return runtime;
  }

  private migrateLegacyMonolithicCatalog(legacyFile: string): void {
    const raw = fs.readFileSync(legacyFile, "utf8").trim();
    if (!raw) {
      fs.unlinkSync(legacyFile);
      return;
    }
    let state: ManagedModelState;
    try {
      state = JSON.parse(raw) as ManagedModelState;
    } catch {
      try {
        fs.renameSync(legacyFile, `${legacyFile}.corrupt.${Date.now()}`);
      } catch {
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

  private loadState(): ManagedModelState {
    const artifactsDir = path.join(this.stateRoot, STORE_ARTIFACTS_DIR);
    const runtimesDir = path.join(this.stateRoot, STORE_RUNTIMES_DIR);
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.mkdirSync(runtimesDir, { recursive: true });

    const artifacts: ManagedModelArtifact[] = [];
    const runtimes: ManagedModelRuntime[] = [];

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
        artifacts.push(JSON.parse(raw) as ManagedModelArtifact);
      } catch {
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
        runtimes.push(JSON.parse(raw) as ManagedModelRuntime);
      } catch {
        /* 跳过损坏分片 */
      }
    }

    return { artifacts, runtimes };
  }

  private writeManifestSnapshot(state: ManagedModelState): void {
    const manifest = {
      formatVersion: 2,
      storage: "sharded" as const,
      artifactCount: state.artifacts.length,
      runtimeCount: state.runtimes.length,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.stateRoot, STORE_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  }

  private writeAllShards(state: ManagedModelState): void {
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

  private pruneRemovedShardFiles(): void {
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

  private persist(): void {
    this.writeAllShards(this.state);
    this.pruneRemovedShardFiles();
  }
}

function resolveModelSource(request: ManagedModelPullRequest): ResolvedModelSource {
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

function resolveLocalSource(request: ManagedModelPullRequest): ResolvedModelSource {
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
  const runtimeHints: ManagedModelRuntimeKind[] = ollamaStorePath || ollamaManifestPath
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

function resolveHuggingFaceSource(url: URL, request: ManagedModelPullRequest): ResolvedModelSource {
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

function resolveGitHubSource(url: URL, request: ManagedModelPullRequest): ResolvedModelSource {
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
  } else if (parts[2] === "blob" || parts[2] === "raw") {
    revision = parts[3];
    filePath = parts.slice(4).join("/");
    downloadUrl = `https://raw.githubusercontent.com/${repoId}/${revision}/${filePath}`;
  } else if (filePath) {
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

function resolveModelScopeSource(url: URL, request: ManagedModelPullRequest): ResolvedModelSource {
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

function inferRuntimeHints(value: string): ManagedModelRuntimeKind[] {
  const lower = value.toLowerCase();
  if (lower.includes(`${path.sep}.ollama${path.sep}models`) || lower.endsWith(`${path.sep}models`) || lower.includes(`${path.sep}manifests${path.sep}`)) {
    return ["native", "llama.cpp", "ollama"];
  }
  if (lower.endsWith(".kgm.json")) {
    return ["native", "openai-compatible"];
  }
  if (lower.endsWith(".gguf")) {
    if (isDs4SpecializedGguf(lower)) {
      return ["ds4", "llama.cpp", "ollama"];
    }
    return ["native", "llama.cpp", "ollama"];
  }
  if (lower.endsWith(".safetensors") || lower.endsWith(".safetensors.index.json")) {
    try {
      const dir = path.dirname(path.resolve(value));
      if (fs.existsSync(dir) && detectJangInModelDirectory(dir)) {
        return ["mlx", "openai-compatible", "vllm", "sglang"];
      }
    } catch {
      /* ignore */
    }
  }
  if (
    lower.endsWith(".safetensors")
    || lower.endsWith(".bin")
    || lower.endsWith(".pt")
    || lower.endsWith(".pth")
    || lower.endsWith(".h5")
    || lower.endsWith(".ckpt")
    || lower.endsWith(".ckpt.index")
    || lower.endsWith(".pb")
    || lower.endsWith(".pbtxt")
    || lower.includes("config.json")
    || lower.includes("tokenizer")
  ) {
    return ["vllm", "sglang", "openai-compatible"];
  }
  return ["openai-compatible", "vllm", "sglang"];
}

function inferRuntimeHintsForLocalPath(localPath: string, stat: fs.Stats): ManagedModelRuntimeKind[] {
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
    if (hasDirectoryEntry(localPath, (name) => isDs4SpecializedGguf(name))) {
      return ["ds4", "llama.cpp", "ollama"];
    }
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

function runtimeNotes(runtime: ManagedModelRuntimeKind, artifact?: ManagedModelArtifact): string[] {
  const notes = [`Runtime kind: ${runtime}`];
  if (artifact?.localPath) {
    notes.push(`Artifact path: ${artifact.localPath}`);
  } else if (artifact?.sourceRef) {
    notes.push(`Source reference: ${artifact.sourceRef}`);
  }
  if (runtime === "native") {
    notes.push("Runs a single-process CPU reference inference backend inside KGM.");
  } else if (runtime === "llama.cpp") {
    notes.push("Requires llama-server or compatible command to be installed on the host.");
  } else if (runtime === "ds4") {
    const hints = resolveDs4ServingHints();
    notes.push(
      "Requires antirez/ds4 ds4-server for DeepSeek V4 / GLM specialized GGUF. Kernels stay in ds4 — not merged into KGM native-gpu.",
    );
    notes.push(
      `serving:ssd_streaming=${hints.ssdStreaming};batched_session=${hints.batchedSession};micro_batch=${hints.microBatchLabel};token_interleave=${hints.tokenInterleaveOwner}`,
    );
    if (hints.sessionKv.enabled) {
      notes.push(`serving:kv_disk_dir=${hints.sessionKv.diskDir};kv_disk_space_mb=${hints.sessionKv.diskSpaceMb}`);
    }
  } else if (runtime === "tokenspeed") {
    notes.push(
      "Optional TokenSpeed OpenAI-compat worker (preview). Kernels stay in TokenSpeed — not merged into KGM native-gpu. Default deploy gate is off.",
    );
  } else if (runtime === "vllm") {
    notes.push("Requires vLLM runtime on a GPU-capable host.");
  } else if (runtime === "sglang") {
    notes.push("Requires SGLang runtime on the target host.");
  } else if (runtime === "mlx") {
    notes.push(
      "Requires Apple Silicon + mlx-lm (`python -m mlx_lm.server`). Override command with KGM_MLX_CMD / runtime.command; JANG weights use this path instead of KGM native CPU.",
    );
  } else if (runtime === "ollama") {
    notes.push("By default this attaches to an existing Ollama daemon unless autostart is enabled.");
  }
  return notes;
}

function defaultPort(runtime: ManagedModelRuntimeKind): number {
  switch (runtime) {
    case "native":
      return 9100;
    case "llama.cpp":
      return 8080;
    case "ds4":
      return parseNumber(process.env.KGM_DS4_PORT) ?? 8090;
    case "tokenspeed":
      return parseNumber(process.env.KGM_TOKENSPEED_PORT) ?? 8095;
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

/** Exported for unit tests — OpenAI-compat attach often uses `…/v1` as baseUrl. */
export function buildProbeUrls(runtime: Pick<ManagedModelRuntime, "baseUrl" | "healthPath" | "runtime">): string[] {
  const baseUrl = runtime.baseUrl.replace(/\/$/, "");
  const origin = baseUrl.replace(/\/v1$/i, "");
  const healthPath = runtime.healthPath?.startsWith("/")
    ? runtime.healthPath
    : `/${runtime.healthPath ?? "health"}`;
  const urls = new Set<string>();
  // Prefer origin-level health so attach baseUrl `http://host:port/v1` does not probe `/v1/health`
  urls.add(`${origin}${healthPath}`);
  if (origin !== baseUrl) {
    urls.add(`${baseUrl}${healthPath}`);
  }
  // OpenAI-compat workers: probe /v1/models then /models
  if (
    runtime.runtime === "tokenspeed" ||
    runtime.runtime === "openai-compatible" ||
    runtime.runtime === "vllm" ||
    runtime.runtime === "sglang" ||
    runtime.runtime === "llama.cpp" ||
    runtime.runtime === "ds4" ||
    runtime.runtime === "mlx" ||
    runtime.runtime === "ollama"
  ) {
    if (origin !== baseUrl) {
      urls.add(`${baseUrl}/models`);
    } else {
      urls.add(`${baseUrl}/v1/models`);
      urls.add(`${baseUrl}/models`);
    }
  } else {
    urls.add(`${baseUrl}/models`);
  }
  urls.add(baseUrl);
  urls.add(origin);
  return Array.from(urls);
}

function defaultMaxConcurrent(runtime: ManagedModelRuntimeKind): number {
  if (runtime === "native") {
    return parseNumber(process.env.KGM_NATIVE_MAX_CONCURRENT_REQUESTS) ?? 8;
  }
  if (runtime === "llama.cpp" || runtime === "ollama" || runtime === "ds4" || runtime === "tokenspeed") {
    return 2;
  }
  return 8;
}

function defaultMaxQueueSize(runtime: ManagedModelRuntimeKind): number {
  if (runtime === "native") {
    return parseNumber(process.env.KGM_NATIVE_MAX_QUEUE_SIZE) ?? 64;
  }
  if (runtime === "llama.cpp" || runtime === "ollama" || runtime === "ds4" || runtime === "tokenspeed") {
    return 16;
  }
  return 128;
}

function defaultRetryMaxRetries(): number {
  return parseNumber(process.env.KGM_MODEL_RUNTIME_RETRY_MAX_RETRIES) ?? 1;
}

function defaultCircuitBreakerFailures(): number {
  return parseNumber(process.env.KGM_MODEL_RUNTIME_CB_FAILURES) ?? 5;
}

function defaultCircuitBreakerCooldownMs(): number {
  return parseNumber(process.env.KGM_MODEL_RUNTIME_CB_COOLDOWN_MS) ?? 30000;
}

function defaultBaseUrl(runtime: ManagedModelRuntimeKind, host: string, port: number): string {
  if (runtime === "native") {
    return `http://${host}:${port}/native`;
  }
  if (runtime === "llama.cpp" || runtime === "ds4") {
    return `http://${host}:${port}`;
  }
  // OpenAI-compat workers (ollama/vllm/sglang/mlx/tokenspeed): base ends with /v1
  return `http://${host}:${port}/v1`;
}

function defaultApiPath(runtime: ManagedModelRuntimeKind): string {
  if (runtime === "native") {
    return "/v1/chat/completions";
  }
  if (runtime === "llama.cpp" || runtime === "ds4") {
    return "/v1/chat/completions";
  }
  if (
    runtime === "openai-compatible"
    || runtime === "ollama"
    || runtime === "vllm"
    || runtime === "sglang"
    || runtime === "mlx"
    || runtime === "tokenspeed"
  ) {
    return "/chat/completions";
  }
  return "/chat/completions";
}

function buildLoraSpawnArgs(
  runtime: Extract<ManagedModelRuntimeKind, "vllm" | "sglang" | "llama.cpp">,
  adapters: ManagedLoraAdapter[] | undefined,
): string[] {
  if (!adapters?.length) return [];
  switch (runtime) {
    case "vllm":
      return adapters.flatMap((adapter) => ["--lora-modules", `${adapter.name}=${adapter.path}`]);
    case "sglang":
      return adapters.flatMap((adapter) => ["--lora-path", adapter.path]);
    case "llama.cpp":
      return adapters.flatMap((adapter) =>
        typeof adapter.scale === "number"
          ? ["--lora", adapter.path, "--lora-scaled", String(adapter.scale)]
          : ["--lora", adapter.path],
      );
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

function defaultCommand(runtime: ManagedModelRuntimeKind): string {
  switch (runtime) {
    case "native":
      return process.execPath;
    case "llama.cpp":
      return resolveLlamaCppDeployConfig().command;
    case "ds4":
      return resolveDs4DeployConfig().command;
    case "tokenspeed":
      return resolveTokenSpeedDeployConfig().command;
    case "ollama":
      return process.env.KGM_OLLAMA_CMD ?? "ollama";
    case "vllm":
      return process.env.KGM_VLLM_CMD ?? "vllm";
    case "sglang":
      return process.env.KGM_SGLANG_CMD ?? "python";
    case "mlx":
      return process.env.KGM_MLX_CMD ?? "python";
    case "openai-compatible":
      return "";
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

function resolveNativeModelRef(artifact: ManagedModelArtifact | undefined, runtime: ManagedModelRuntime): string | undefined {
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

function shouldAutostartOllama(): boolean {
  return process.env.KGM_OLLAMA_AUTOSTART === "1" || process.env.KGM_OLLAMA_AUTOSTART?.toLowerCase() === "true";
}

function isHuggingFaceHost(hostname: string): boolean {
  return hostname === "huggingface.co";
}

function isGitHubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname === "raw.githubusercontent.com";
}

function isModelScopeHost(hostname: string): boolean {
  return hostname === "www.modelscope.cn" || hostname === "modelscope.cn";
}

function isOllamaReference(value?: string): boolean {
  if (!value) {
    return false;
  }
  return value.startsWith("ollama://") || value.includes("ollama.com/library/");
}

function normalizeOllamaRef(sourceUrl?: string, sourceRef?: string): string {
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

function buildAuthHeaders(sourceType: ManagedModelSourceType | "direct", explicit?: string): Record<string, string> {
  const token =
    explicit ??
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

function normalizeUrlOrThrow(sourceUrl?: string, sourceRef?: string): URL {
  const value = sourceUrl ?? sourceRef;
  if (!value) {
    throw new Error("source_url_required");
  }
  return new URL(value);
}

function isLocalPathReference(value?: string): boolean {
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

function normalizeLocalPath(value: string): string {
  if (value.startsWith("file://")) {
    return decodeURIComponent(new URL(value).pathname);
  }
  if (!path.isAbsolute(value)) {
    throw new Error("local_model_path_must_be_absolute");
  }
  return path.resolve(value);
}

function normalizeOllamaLocalModelRef(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/^ollama:\/\//, "");
  return normalized ? normalized : undefined;
}

function isOllamaStorePath(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory()
      && fs.existsSync(path.join(targetPath, "manifests"))
      && fs.existsSync(path.join(targetPath, "blobs"));
  } catch {
    return false;
  }
}

function isOllamaManifestPath(targetPath: string): boolean {
  return targetPath.includes(`${path.sep}manifests${path.sep}`);
}

function hasDirectoryEntry(baseDir: string, matcher: (name: string) => boolean): boolean {
  try {
    return fs.readdirSync(baseDir).some((name) => matcher(name));
  } catch {
    return false;
  }
}

function isPyTorchFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "pytorch_model.bin"
    || lower === "pytorch_model.bin.index.json"
    || lower.endsWith(".pt")
    || lower.endsWith(".pth")
    || /^consolidated.*\.(pt|pth|bin)$/i.test(name);
}

function isTensorFlowFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "saved_model.pb"
    || lower === "saved_model.pbtxt"
    || lower === "tf_model.h5"
    || lower.endsWith(".h5")
    || lower.endsWith(".ckpt")
    || lower.endsWith(".ckpt.index");
}

function stripExtension(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function joinUrl(base: string, pathname: string): string {
  return `${base.replace(/\/$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

/** Strip trailing `/api` so `OLLAMA_BASE_URL=…/api` + `/api/pull` does not become `/api/api/pull`. */
export function normalizeOllamaDaemonBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.replace(/\/api$/i, "") || "http://127.0.0.1:11434";
}

function parseNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 解析并验证数值型环境变量
 * @param value - 环境变量值
 * @param defaultValue - 默认值
 * @param min - 最小值（包含）
 * @param max - 最大值（包含）
 * @param paramName - 参数名称（用于日志）
 * @returns 验证后的数值
 */
function parseValidatedNumber(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  paramName: string,
): number {
  const parsed = parseNumber(value);
  if (parsed === undefined) {
    return defaultValue;
  }
  if (parsed < min || parsed > max || !Number.isInteger(parsed)) {
    console.warn(
      `[Yueli KGM Runtime] Invalid ${paramName}: ${value}. Using default ${defaultValue} (valid range: ${min}-${max}, integer).`,
    );
    return defaultValue;
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePreferredRuntimeId(options?: CompletionOptions): string | undefined {
  const fromMeta = options?.metadata?.native_runtime_id;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim();
  }
  const fromTarget = options?.routing?.target?.runtimeId;
  if (typeof fromTarget === "string" && fromTarget.trim()) {
    return fromTarget.trim();
  }
  return undefined;
}

/** Env BASE_URL attach for spawn-managed OpenAI-compat workers (TokenSpeed/Ollama-style). */
export function wouldAttachManagedKind(
  kind: Extract<ManagedModelRuntimeKind, "vllm" | "sglang" | "llama.cpp" | "ds4" | "mlx">,
): boolean {
  return Boolean(
    resolveManagedAttachBaseUrl({
      runtime: kind,
      baseUrl: "http://127.0.0.1:9/v1",
      notes: [],
      metadata: {},
    }),
  );
}

export function resolveManagedAttachBaseUrl(
  runtime: Pick<ManagedModelRuntime, "runtime" | "baseUrl" | "notes" | "metadata">,
): string | undefined {
  const kind = runtime.runtime;
  if (
    kind !== "vllm" &&
    kind !== "sglang" &&
    kind !== "llama.cpp" &&
    kind !== "ds4" &&
    kind !== "mlx"
  ) {
    return undefined;
  }
  const attachEnvKey =
    kind === "llama.cpp"
      ? "KGM_LLAMA_CPP_ATTACH"
      : kind === "ds4"
        ? "KGM_DS4_ATTACH"
        : kind === "vllm"
          ? "KGM_VLLM_ATTACH"
          : kind === "sglang"
            ? "KGM_SGLANG_ATTACH"
            : "KGM_MLX_ATTACH";
  const attachRaw = process.env[attachEnvKey]?.trim().toLowerCase();
  if (attachRaw === "0" || attachRaw === "false" || attachRaw === "off") {
    return undefined;
  }
  const envBase =
    kind === "vllm"
      ? process.env.KGM_VLLM_BASE_URL?.trim() || process.env.VLLM_BASE_URL?.trim()
      : kind === "sglang"
        ? process.env.KGM_SGLANG_BASE_URL?.trim() || process.env.SGLANG_BASE_URL?.trim()
        : kind === "llama.cpp"
          ? process.env.KGM_LLAMA_CPP_BASE_URL?.trim() || process.env.LLAMA_CPP_BASE_URL?.trim()
          : kind === "ds4"
            ? process.env.KGM_DS4_BASE_URL?.trim() || process.env.DS4_BASE_URL?.trim()
            : process.env.KGM_MLX_BASE_URL?.trim() || process.env.MLX_BASE_URL?.trim();
  const forceAttach = attachRaw === "1" || attachRaw === "true" || attachRaw === "on";
  const preferFromMeta =
    runtime.metadata?.attachMode === "attach" ||
    runtime.metadata?.preferAttach === true ||
    Boolean(runtime.notes?.some((n) => n.includes("_mode:attach") || n.startsWith(`${kind}_attach:`)));
  // Explicit attach only (KGM_*_ATTACH=1 or prefer meta). BASE_URL alone serves provider path.
  if (preferFromMeta || forceAttach) {
    return envBase || runtime.baseUrl;
  }
  return undefined;
}

function createRuntimeMetrics(runtime: ManagedModelRuntime): ManagedRuntimeMetrics {
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
    restartsTotal: 0,
  };
}

function updateMetricsOnSuccess(
  metrics: ManagedRuntimeMetrics,
  params: {
    latencyMs: number;
    queueWaitMs: number;
    outputTokens: number;
    ttftMs?: number;
    outputTokensPerSecond?: number;
    kvResidentBytes?: number;
  },
): void {
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

function updateMetricsOnError(metrics: ManagedRuntimeMetrics, error: string): void {
  metrics.requestsTotal += 1;
  metrics.errorsTotal += 1;
  metrics.consecutiveFailures += 1;
  metrics.lastError = error;
  metrics.lastErrorAt = new Date().toISOString();
}

function movingAverage(current: number, value: number, count: number): number {
  if (count <= 1) {
    return value;
  }
  return current + (value - current) / count;
}

function estimateTokenCount(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function backoffDelayMs(attempt: number): number {
  return Math.min(250 * (2 ** (attempt - 1)), 2000);
}

function extractNativeRuntimePerf(raw: unknown): {
  ttftMs?: number;
  tokensPerSecond?: number;
  kvResidentBytes?: number;
} | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const nativeRuntime = (raw as { nativeRuntime?: unknown }).nativeRuntime;
  if (!nativeRuntime || typeof nativeRuntime !== "object") {
    return null;
  }
  const record = nativeRuntime as {
    ttftMs?: unknown;
    tokensPerSecond?: unknown;
    memory?: { kvResidentBytes?: unknown } | unknown;
  };
  const memory = (record.memory && typeof record.memory === "object")
    ? (record.memory as { kvResidentBytes?: unknown })
    : undefined;
  return {
    ttftMs: typeof record.ttftMs === "number" ? record.ttftMs : undefined,
    tokensPerSecond: typeof record.tokensPerSecond === "number" ? record.tokensPerSecond : undefined,
    kvResidentBytes: typeof memory?.kvResidentBytes === "number" ? memory.kvResidentBytes : undefined,
  };
}

function circuitStateValue(state: ManagedRuntimeCircuitState): number {
  if (state === "half_open") {
    return 1;
  }
  if (state === "open") {
    return 2;
  }
  return 0;
}

function escapeMetricLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtime hints for a local file or directory (CLI, tests, tooling).
 * JANG / MLX-native layouts return `mlx` first.
 */
export function inferRuntimeHintsForModelPath(modelPath: string): ManagedModelRuntimeKind[] {
  const resolved = path.resolve(modelPath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return inferRuntimeHintsForLocalPath(resolved, stat);
  }
  return inferRuntimeHints(resolved);
}
