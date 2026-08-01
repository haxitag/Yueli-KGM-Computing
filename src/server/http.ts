import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KgmRequest, SkillDefinition, ToolDefinition } from "../core/types.js";
import { DEFAULT_SCHEMA_IDS } from "../core/config.js";
import type { ConfigStore, KgmConfigPatch } from "../core/configStore.js";
import { toPublicKgmConfig } from "../core/publicConfig.js";
import { syncPlaygroundFromConfig } from "../playground/syncPlayground.js";
import type { ContextBuilder } from "../context/contextBuilder.js";
import type { GraphStore } from "../graph/store.js";
import { Scheduler } from "../scheduler/fsm.js";
import { MultiAgentRuntime } from "../agents/multiAgentRuntime.js";
import type { LlmClient } from "../llm/client.js";
import {
  createAnthropicMessagesResponse,
  streamAnthropicMessagesJsonLines,
  type AnthropicMessagesRequest,
} from "../anthropic/compat.js";
import {
  postAnthropicMessages,
  streamAnthropicMessagesNative,
} from "../llm/maas/anthropicNative.js";
import { shouldProxyAnthropicMessagesNative } from "../llm/maas/reasoning.js";
import {
  buildOpenAiModelList,
  createOpenAiChatCompletion,
  createOpenAiResponse,
  streamOpenAiChatCompletion,
  streamOpenAiResponse,
  type OpenAiChatCompletionRequest,
  type OpenAiResponsesRequest,
} from "../openai/compat.js";
import {
  proxyAudioSpeech,
  proxyAudioTranscriptions,
  proxyAudioTranscriptionsMultipart,
  proxyAudioTranslations,
  proxyImagesEdits,
  proxyImagesGenerations,
  proxyImagesVariations,
  proxyRerank,
  startVideoGenerationJob,
  toCanonicalMediaProxyFailure,
  type MediaProxyResult,
} from "../openai/mediaCompat.js";
import { getMediaJobStore } from "../openai/mediaJobs.js";
import { maybeProxyNativeOpenAiStream, sendNormalizedUpstreamSse } from "../openai/passthrough.js";
import { handleGetModelProviders, handlePutModelProviders } from "./adminModelProviders.js";
import { ProviderConfigurationManager } from "../models/providerConfigManager.js";
import { normalizeIncomingHttpHeaders } from "../output/gfmNormalize.js";
import { OpenAiResponseStore } from "../openai/responseStore.js";
import { SandboxConfigurationError, SandboxManager } from "../sandbox/manager.js";
import { SchemaRegistry } from "../schema/registry.js";
import type { SkillRuntime } from "../skills/runtime.js";
import { ToolRegistry } from "../tools/registry.js";
import type { MemoryStore } from "../memory/store.js";
import type { Embedder } from "../embedding/canonical.js";
import type { ArtifactStore } from "../context/artifactStore.js";
import type { SessionStore } from "../context/sessionStore.js";
import { ManagedModelManager } from "../models/modelManager.js";
import type { AutoRoutingLlmClient } from "../llm/autoRoutingClient.js";
import {
  applyRoutingPatch,
  buildRollbackEntry,
  buildUpdateEntry,
  createRoutingHistoryStoreFromEnv,
  parseRoutingUpdatePayload,
} from "../routing/routingService.js";
import {
  assertHttpAccessConfig,
  createHttpAccessConfigFromEnv,
  HttpRequestAccess,
} from "./httpAccess.js";
import { getOpsStore } from "../admin/opsStore.js";
import { runWithOpsAuthAsync } from "../admin/opsAuthContext.js";
import { handleOpsAdminRoute } from "./routes/opsAdmin.js";
import { handleObservabilityRoute } from "./routes/observability.js";
import { buildControlPlaneStatus } from "./controlPlaneStatus.js";
import { resolveModelAlias } from "../admin/modelAliasResolve.js";
import { mediaFail } from "../openai/mediaErrors.js";
import { kgmErrorBody, KgmJsonParseError, KgmRequestValidationError } from "../utils/kgmHttpErrors.js";
import { readKgmHttpJsonBody as readJson, sendKgmHttpJson as sendJson, sendKgmHttpText as sendText, getKgmHttpMaxBodyBytes } from "./httpJsonHelpers.js";
import { getOptimizer } from "../optimization/optimizer.js";
import { memorySearchOptionsFromKgm } from "../memory/retrievalOptions.js";
import type { KgmRetrievalOptions } from "../core/types.js";
import { getKgmOpenApiV1 } from "../openapi/kgmOpenApiV1Spec.js";
import { embedImageRemote } from "../multimodal/remoteImageEmbedder.js";
import type { GraphRule } from "../graph/store.js";
import { KceEngine, KceExecutionFailure, type KceComputeRequest } from "../kce/engine.js";
import { generateId } from "../utils/id.js";
import { logger } from "../observability/logger.js";
import { validateEnv } from "../config/envValidation.js";
import { setupGracefulShutdown } from "../observability/gracefulShutdown.js";
import { evaluateReadiness } from "./readiness.js";
import { resolveRequestTraceIds, traceResponseHeaders } from "../observability/requestTrace.js";
import { InferenceDiscoveryService } from "../runtime/discoveryService.js";
import { handleRuntimeRoute } from "./routes/runtime.js";
import { handleGraphRoute } from "./routes/graph.js";
import { buildEffectiveModels, buildRawModels } from "../models/modelTypeAnnotator.js";
import { getWeightCapabilityReport } from "../native/weightCapabilities.js";
import {
  assessArtifactExecution,
  getNativeGpuClosedLoopStatus,
  resolveRuntimeKind,
} from "../native/executionPolicy.js";
import { inferRuntimeHintsForModelPath } from "../models/modelManager.js";
import { planGpuThroughput } from "../inference/gpuThroughputRouter.js";
import type { ManagedLoraAdapter } from "../models/modelManager.js";
import { toHostKgmError, toKgmStructuredError } from "../errors/structuredError.js";
import {
  assertVirtualKeyModelAllowed,
  modelFromBody,
} from "./virtualKeyModelGuard.js";
import { appendHttpAccessLog, snapshotHttpAccessLog } from "./httpRequestRing.js";
import { handleYueliaiRoute } from "../yueliai/routes.js";
import {
  parseStreamIdleMs,
  relayUpstreamSseNormalized,
  writeSseStructuredError,
} from "../openai/sseStreamNormalize.js";
import { isOriginAllowed, resolveCorsPolicy } from "./corsPolicy.js";

export type KgmServerParams = {
  scheduler: Scheduler;
  contextBuilder: ContextBuilder;
  llmClient: LlmClient;
  schemaRegistry: SchemaRegistry;
  toolRegistry: ToolRegistry;
  memoryStore: MemoryStore;
  graphStore: GraphStore;
  embedder: Embedder;
  sandboxManager: SandboxManager;
  modelManager?: ManagedModelManager;
  autoRoutingClient?: AutoRoutingLlmClient;
  configStore: ConfigStore;
  skillRuntime?: SkillRuntime;
  artifactStore?: ArtifactStore;
  sessionStore?: SessionStore;
};

export function createKgmRequestListener(
  params: KgmServerParams,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // Validate environment variables on startup
  const env = validateEnv();
  logger.info({ env: { NODE_ENV: env.NODE_ENV, PORT: env.PORT } }, 'Environment validated');

  const modelManager =
    params.modelManager ??
    new ManagedModelManager({
      llamaCpp: () => {
        const worker = params.configStore.get().workers.llamaCpp;
        return {
          enabled: worker.enabled,
          command: worker.command,
          installHint: worker.installHint,
        };
      },
      ds4: () => {
        const worker = params.configStore.get().workers.ds4;
        return {
          enabled: worker.enabled,
          command: worker.command,
          installHint: worker.installHint,
          chdir: worker.chdir,
        };
      },
      tokenspeed: () => {
        const worker = params.configStore.get().workers.tokenspeed;
        return {
          enabled: worker.enabled,
          command: worker.command,
          installHint: worker.installHint,
          baseUrl: worker.baseUrl,
          port: worker.port,
          attach: worker.attach,
          toolCallParser: worker.toolCallParser,
          reasoningParser: worker.reasoningParser,
          enablePrefixCaching: worker.enablePrefixCaching,
          extraArgs: worker.extraArgs,
        };
      },
    });
  const routingHistory = createRoutingHistoryStoreFromEnv();
  const responseStore = new OpenAiResponseStore();
  const accessConfig = createHttpAccessConfigFromEnv();
  assertHttpAccessConfig(accessConfig);
  const access = new HttpRequestAccess(accessConfig, {
    resolveVirtualKey: async (raw) => {
      try {
        const store = await getOpsStore();
        return store.findVirtualKeyByRaw(raw);
      } catch {
        return undefined;
      }
    },
    checkBudget: async (keyId) => {
      try {
        const store = await getOpsStore();
        const result = store.assertBudgetAllows(keyId);
        if (!result.ok) {
          return {
            ok: false as const,
            status: 402,
            message: `Budget exceeded (${result.status.budget.name}): spent $${result.status.spentUsd.toFixed(4)} / $${result.status.budget.limitUsd.toFixed(4)}`,
          };
        }
        return { ok: true as const };
      } catch {
        return { ok: true as const };
      }
    },
  });
  logger.info(
    {
      securityMode: accessConfig.securityMode,
      apiKeyEnabled: Boolean(accessConfig.apiKey),
      rateLimit: accessConfig.rateLimit,
      trustProxy: accessConfig.trustProxy,
      virtualKeys: true,
    },
    "HTTP access policy ready",
  );
  const startedAt = Date.now();
  const discoveryService = new InferenceDiscoveryService();
  const kceEngine = new KceEngine({
    contextBuilder: params.contextBuilder,
    graphStore: params.graphStore,
    memoryStore: params.memoryStore,
    embedder: params.embedder,
    llmClient: params.llmClient,
  });

  interface Agent {
    id: string;
    name: string;
    model: string;
    systemPrompt: string;
    tools: string[];
    memory: boolean;
    createdAt: string;
  }

  interface Task {
    id: string;
    type: string;
    agentId?: string;
    input: string;
    sessionId?: string;
    status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "timeout";
    progress: number;
    result?: any;
    error?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
  }

  interface Workflow {
    id: string;
    name: string;
    description?: string;
    nodes: Array<{
      id: string;
      type: string;
      agentId?: string;
      tool?: string;
      config?: any;
    }>;
    edges: Array<{
      source: string;
      target: string;
      condition?: string;
    }>;
    state: "draft" | "active" | "paused" | "archived";
    createdAt: string;
    updatedAt: string;
  }

  interface WorkflowExecution {
    id: string;
    workflowId: string;
    input: any;
    status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
    currentNodeId?: string;
    history: Array<{
      nodeId: string;
      timestamp: string;
      status: string;
      output?: any;
    }>;
    output?: any;
    error?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
  }

  interface Evaluation {
    id: string;
    name: string;
    type: "model" | "agent" | "prompt" | "workflow";
    targetId?: string;
    benchmark?: string;
    config: any;
    status: "queued" | "running" | "paused" | "completed" | "failed";
    result?: any;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
  }

  interface EvaluationRun {
    id: string;
    evaluationId: string;
    input: any;
    output?: any;
    score?: number;
    metrics?: Record<string, number>;
    feedback?: string;
    createdAt: string;
  }

  const agentStore: {
    agents: Record<string, Agent>;
    create: (data: Omit<Agent, "id" | "createdAt">) => Agent;
    get: (id: string) => Agent | undefined;
    list: () => Agent[];
    delete: (id: string) => boolean;
  } = {
    agents: {},
    create(data) {
      const id = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const agent: Agent = {
        ...data,
        id,
        createdAt: new Date().toISOString(),
      };
      this.agents[id] = agent;
      return agent;
    },
    get(id) {
      return this.agents[id];
    },
    list() {
      return Object.values(this.agents);
    },
    delete(id) {
      if (this.agents[id]) {
        delete this.agents[id];
        return true;
      }
      return false;
    },
  };

  const multiAgentRuntime = new MultiAgentRuntime({
    scheduler: params.scheduler,
    resolveAgent: (id) => agentStore.get(id),
  });

  const taskStore: {
    tasks: Record<string, Task>;
    create: (data: Omit<Task, "id" | "createdAt" | "progress">) => string;
    get: (id: string) => Task | undefined;
    list: () => Task[];
    update: (id: string, updates: Partial<Task>) => boolean;
    delete: (id: string) => boolean;
    cancel: (id: string) => boolean;
  } = {
    tasks: {},
    create(data) {
      const id = `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      this.tasks[id] = {
        ...data,
        id,
        progress: 0,
        createdAt: new Date().toISOString(),
      };
      return id;
    },
    get(id) {
      return this.tasks[id];
    },
    list() {
      return Object.values(this.tasks);
    },
    update(id, updates) {
      if (this.tasks[id]) {
        this.tasks[id] = { ...this.tasks[id], ...updates };
        return true;
      }
      return false;
    },
    delete(id) {
      if (this.tasks[id]) {
        delete this.tasks[id];
        return true;
      }
      return false;
    },
    cancel(id) {
      const t = this.tasks[id];
      if (!t) {
        return false;
      }
      if (t.status === "queued" || t.status === "running") {
        t.status = "cancelled";
        t.completedAt = new Date().toISOString();
        return true;
      }
      return false;
    },
  };

  const taskPollMsRaw = Number.parseInt(process.env.KGM_TASK_POLL_MS ?? "750", 10);
  const taskPollMs = Number.isFinite(taskPollMsRaw) && taskPollMsRaw >= 200 ? taskPollMsRaw : 750;
  const taskPollHandle = setInterval(() => {
    const queued = Object.values(taskStore.tasks).filter((t) => t.status === "queued");
    const q = queued[0];
    if (!q) {
      return;
    }
    taskStore.update(q.id, { status: "running", startedAt: new Date().toISOString(), progress: 1 });
    void (async () => {
      try {
        const cur = taskStore.get(q.id);
        if (!cur || cur.status === "cancelled") {
          return;
        }
        if (cur.type === "agent_execute" && cur.agentId) {
          const ag = agentStore.get(cur.agentId);
          if (!ag) {
            taskStore.update(q.id, {
              status: "failed",
              error: "agent_not_found",
              completedAt: new Date().toISOString(),
            });
            return;
          }
          const kgmRequest: KgmRequest = {
            userId: cur.sessionId || "anonymous",
            input: cur.input,
            sessionId: cur.sessionId,
            model: ag.model,
            metadata: { agentId: ag.id, tools: ag.tools, mode: ag.systemPrompt ? "reasoning" : "chat" },
          };
          const response = await params.scheduler.run(kgmRequest);
          const fin = taskStore.get(q.id);
          if (!fin || fin.status === "cancelled") {
            return;
          }
          taskStore.update(q.id, {
            status: "completed",
            result: response,
            progress: 100,
            completedAt: new Date().toISOString(),
          });
        } else {
          const kgmRequest: KgmRequest = {
            userId: cur.sessionId || "anonymous",
            input: cur.input,
            sessionId: cur.sessionId,
          };
          const response = await params.scheduler.run(kgmRequest);
          const fin = taskStore.get(q.id);
          if (!fin || fin.status === "cancelled") {
            return;
          }
          taskStore.update(q.id, {
            status: "completed",
            result: response,
            progress: 100,
            completedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const fin = taskStore.get(q.id);
        if (fin && fin.status !== "cancelled") {
          taskStore.update(q.id, {
            status: "failed",
            error: msg,
            completedAt: new Date().toISOString(),
          });
        }
      }
    })();
  }, taskPollMs);
  taskPollHandle.unref();

  const workflowStore: {
    workflows: Record<string, Workflow>;
    create: (data: Omit<Workflow, "id" | "createdAt" | "updatedAt">) => Workflow;
    get: (id: string) => Workflow | undefined;
    list: () => Workflow[];
    update: (id: string, updates: Partial<Workflow>) => boolean;
    delete: (id: string) => boolean;
  } = {
    workflows: {},
    create(data) {
      const id = `workflow_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const workflow: Workflow = {
        ...data,
        id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.workflows[id] = workflow;
      return workflow;
    },
    get(id) {
      return this.workflows[id];
    },
    list() {
      return Object.values(this.workflows);
    },
    update(id, updates) {
      if (this.workflows[id]) {
        this.workflows[id] = { ...this.workflows[id], ...updates, updatedAt: new Date().toISOString() };
        return true;
      }
      return false;
    },
    delete(id) {
      if (this.workflows[id]) {
        delete this.workflows[id];
        return true;
      }
      return false;
    },
  };

  const workflowExecutionStore: {
    executions: Record<string, WorkflowExecution>;
    create: (data: Omit<WorkflowExecution, "id" | "history" | "createdAt">) => WorkflowExecution;
    get: (id: string) => WorkflowExecution | undefined;
    list: () => WorkflowExecution[];
    update: (id: string, updates: Partial<WorkflowExecution>) => boolean;
    delete: (id: string) => boolean;
  } = {
    executions: {},
    create(data) {
      const id = `wfexec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const execution: WorkflowExecution = {
        ...data,
        id,
        history: [],
        createdAt: new Date().toISOString(),
      };
      this.executions[id] = execution;
      return execution;
    },
    get(id) {
      return this.executions[id];
    },
    list() {
      return Object.values(this.executions);
    },
    update(id, updates) {
      if (this.executions[id]) {
        this.executions[id] = { ...this.executions[id], ...updates };
        return true;
      }
      return false;
    },
    delete(id) {
      if (this.executions[id]) {
        delete this.executions[id];
        return true;
      }
      return false;
    },
  };

  const evaluationStore: {
    evaluations: Record<string, Evaluation>;
    runs: Record<string, EvaluationRun[]>;
    create: (data: Omit<Evaluation, "id" | "createdAt">) => Evaluation;
    get: (id: string) => Evaluation | undefined;
    list: () => Evaluation[];
    update: (id: string, updates: Partial<Evaluation>) => boolean;
    delete: (id: string) => boolean;
    addRun: (evaluationId: string, run: Omit<EvaluationRun, "id" | "createdAt" | "evaluationId">) => EvaluationRun;
    getRuns: (evaluationId: string) => EvaluationRun[];
  } = {
    evaluations: {},
    runs: {},
    create(data) {
      const id = `eval_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const evaluation: Evaluation = {
        ...data,
        id,
        createdAt: new Date().toISOString(),
      };
      this.evaluations[id] = evaluation;
      this.runs[id] = [];
      return evaluation;
    },
    get(id) {
      return this.evaluations[id];
    },
    list() {
      return Object.values(this.evaluations);
    },
    update(id, updates) {
      if (this.evaluations[id]) {
        this.evaluations[id] = { ...this.evaluations[id], ...updates };
        return true;
      }
      return false;
    },
    delete(id) {
      if (this.evaluations[id]) {
        delete this.evaluations[id];
        delete this.runs[id];
        return true;
      }
      return false;
    },
    addRun(evaluationId, run) {
      const id = `evalrun_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const evaluationRun: EvaluationRun = {
        ...run,
        id,
        evaluationId,
        createdAt: new Date().toISOString(),
      };
      if (!this.runs[evaluationId]) {
        this.runs[evaluationId] = [];
      }
      this.runs[evaluationId].push(evaluationRun);
      return evaluationRun;
    },
    getRuns(evaluationId) {
      return this.runs[evaluationId] || [];
    },
  };

  // CORS — 与 Express Playground 共用 resolveCorsPolicy（禁止非白名单回显 origins[0]）
  const corsPolicy = resolveCorsPolicy();
  const corsMethods = corsPolicy.methods;
  const corsHeaders = corsPolicy.headers;
  const corsMaxAge = corsPolicy.maxAge;

  // 安全响应头配置
  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": process.env.KGM_X_FRAME_OPTIONS || "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": process.env.KGM_CSP || "default-src 'self'",
    "Permissions-Policy": process.env.KGM_PERMISSIONS_POLICY || "geolocation=(), microphone=(), camera=()",
  };

  function applySecurityHeaders(res: ServerResponse): void {
    for (const [header, value] of Object.entries(securityHeaders)) {
      res.setHeader(header, value);
    }
  }

  function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
    applySecurityHeaders(res);

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const isPreflight = req.method === "OPTIONS";

    if (corsPolicy.allowAll) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && isOriginAllowed(origin, corsPolicy)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (corsPolicy.allowCredentials) {
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    } else if (origin && isPreflight) {
      // 非白名单 Origin：预检直接拒绝，不回显任意允许源
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "cors_origin_denied", message: "Origin not allowed" } }));
      return true;
    }

    res.setHeader("Access-Control-Allow-Methods", corsMethods);
    res.setHeader("Access-Control-Allow-Headers", corsHeaders);
    res.setHeader("Access-Control-Max-Age", corsMaxAge);

    if (isPreflight) {
      res.writeHead(204);
      res.end();
      return true;
    }

    return false;
  }

  return async (req, res) => {
    try {
      // 处理CORS
      if (handleCors(req, res)) {
        return;
      }
      
      const url = new URL(req.url ?? "", "http://localhost");
      if (!(await access.checkAsync(req, res, url.pathname))) {
        return;
      }
      const auth = access.getLastAuth();
      await runWithOpsAuthAsync(auth, async () => {
      appendHttpAccessLog({
        ts: new Date().toISOString(),
        method: req.method ?? "?",
        pathname: url.pathname,
      });

      if (await handleYueliaiRoute(req, res, url.pathname, { configStore: params.configStore })) {
        return;
      }

      const isOpsAdminPath =
        url.pathname === "/v1/kgm/ops/overview" ||
        url.pathname.startsWith("/v1/kgm/keys") ||
        url.pathname.startsWith("/v1/kgm/usage") ||
        url.pathname.startsWith("/v1/kgm/budgets") ||
        url.pathname.startsWith("/v1/kgm/aliases");
      if (isOpsAdminPath) {
        const queryObj = Object.fromEntries(url.searchParams.entries());
        let body: unknown = { __query: queryObj };
        if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "HEAD") {
          const parsed = await readJson(req);
          body = { ...(parsed as object), __query: queryObj };
        }
        if (
          await handleOpsAdminRoute({
            method: req.method ?? "GET",
            pathname: url.pathname,
            body,
            res,
            sendJson,
            isMaster: auth.kind === "master" || (!accessConfig.apiKey && auth.kind === "anonymous"),
          })
        ) {
          return;
        }
      }

      if (
        url.pathname === "/v1/kgm/observability/context" ||
        url.pathname === "/v1/kgm/memory/records" ||
        url.pathname === "/v1/kgm/observability/retrieval-cache/clear"
      ) {
        if (
          await handleObservabilityRoute({
            method: req.method ?? "GET",
            pathname: url.pathname,
            url,
            req,
            res,
            sendJson,
            memoryStore: params.memoryStore,
            contextBuilder: params.contextBuilder,
            modelManager,
          })
        ) {
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const health = {
          status: "ok",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          environment: env.NODE_ENV,
          version: process.env.npm_package_version || "0.2.0",
          checks: {
            memory: {
              used: process.memoryUsage().heapUsed / 1024 / 1024,
              total: process.memoryUsage().heapTotal / 1024 / 1024,
              rss: process.memoryUsage().rss / 1024 / 1024,
            },
            cpu: process.cpuUsage(),
          },
          probes: {
            liveness: "/health",
            readiness: "/ready",
          },
        };
        return sendJson(res, 200, health);
      }

      /** 就绪探针：可否接流量；与 /health 存活探针分层（K8s readinessProbe 用此路径） */
      if (req.method === "GET" && url.pathname === "/ready") {
        const cfg = params.configStore.get();
        const llmConfigured = Boolean(
          (cfg.llm?.baseUrl && String(cfg.llm.baseUrl).trim()) ||
            params.autoRoutingClient ||
            params.llmClient,
        );
        const runtimes = modelManager.listRuntimes();
        let running = 0;
        let error = 0;
        let degraded = 0;
        for (const rt of runtimes) {
          if (rt.status === "running") running += 1;
          else if (rt.status === "error") error += 1;
          if (rt.healthStatus === "degraded") degraded += 1;
        }
        const report = evaluateReadiness({
          env: process.env,
          processStartedAtMs: startedAt,
          llmConfigured,
          workers: {
            running,
            error,
            degraded,
            total: runtimes.length,
          },
        });
        return sendJson(res, report.status === "ready" ? 200 : 503, report);
      }

      /** OpenAI-adjacent / 文稿常用路径：与 `/health` 互补，便于负载均衡与控制台探测统一走 `/v1/*`。 */
      if (req.method === "GET" && url.pathname === "/v1/status") {
        return sendJson(res, 200, {
          status: "ok",
          service: "yueli-kgm-computing",
          timestamp: new Date().toISOString(),
          uptime_seconds: process.uptime(),
          version: process.env.npm_package_version || "0.2.0",
          node: process.version,
          environment: env.NODE_ENV,
          endpoints: {
            health: "/health",
            ready: "/ready",
            metrics: "/metrics",
            openapi: "/openapi.json",
            runtime_status: "/v1/runtime/status",
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        return sendText(res, 200, modelManager.getPrometheusMetrics());
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/optimize/stats") {
        const optimizer = getOptimizer();
        return sendJson(res, 200, {
          optimizer: optimizer.getStats(),
          timestamp: new Date().toISOString(),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/optimize/clear-cache") {
        const optimizer = getOptimizer();
        optimizer.clearCache();
        return sendJson(res, 200, { cleared: true, timestamp: new Date().toISOString() });
      }

      if (req.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/v1/openapi.json")) {
        return sendJson(res, 200, getKgmOpenApiV1());
      }

      if (url.pathname.startsWith("/v1/runtime/")) {
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const handled = await handleRuntimeRoute({
          method: req.method ?? "GET",
          pathname: url.pathname,
          body,
          res,
          sendJson,
          configStore: params.configStore,
          modelManager,
          discoveryService,
          startedAt,
        });
        if (handled) return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/v1/kgm/graph/export" ||
          url.pathname === "/v1/kgm/graph/import" ||
          url.pathname === "/v1/kgm/graph/query" ||
          url.pathname === "/v1/kgm/graph/reason/dual_track")
      ) {
        const body = await readJson(req);
        const handled = await handleGraphRoute({
          method: req.method,
          pathname: url.pathname,
          body,
          res,
          sendJson,
          graphStore: params.graphStore,
          memoryStore: params.memoryStore,
          embedder: params.embedder,
          llm: params.llmClient,
          requireGraphNamespace,
        });
        if (handled) return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const configuredOnly =
          url.searchParams.get("configured") === "true" ||
          url.searchParams.get("configured_only") === "1";
        const typeFilter =
          url.searchParams.get("type")?.trim() ||
          url.searchParams.get("model_type")?.trim() ||
          url.searchParams.get("capability")?.trim() ||
          "";
        let configuredProviders: import("../llm/providerFactory.js").ProviderConfig[] | undefined;
        if (configuredOnly) {
          const pcm = new ProviderConfigurationManager(
            process.env.KGM_PROVIDER_CONFIG_PATH ?? "config/model-providers.json",
          );
          await pcm.loadConfiguration();
          pcm.updateFromEnvironment();
          configuredProviders = pcm.getActiveProviderConfigs().filter((p) => p.apiKey || p.apiKeys?.length);
        }
        const list = buildOpenAiModelList(params.configStore, modelManager, {
          configuredOnly,
          configuredProviders,
        });
        if (typeFilter) {
          list.data = list.data.filter((m) => {
            const kgm = (m.kgm ?? {}) as Record<string, unknown>;
            const caps = Array.isArray(kgm.capabilities) ? (kgm.capabilities as string[]) : [];
            const mt = typeof kgm.model_type === "string" ? kgm.model_type : "";
            return mt === typeFilter || caps.includes(typeFilter);
          });
        }
        return sendJson(res, 200, list);
      }

      if (req.method === "GET" && url.pathname === "/v1/admin/model-providers") {
        return handleGetModelProviders(res);
      }

      if (req.method === "PUT" && url.pathname === "/v1/admin/model-providers") {
        return handlePutModelProviders(req, res, params.configStore);
      }

      if (req.method === "GET" && url.pathname === "/v1/models/effective") {
        const discovery = discoveryService.getLastResult() ?? await discoveryService.discover();
        return sendJson(res, 200, buildEffectiveModels({ configStore: params.configStore, modelManager, discovery }));
      }

      if (req.method === "GET" && url.pathname === "/v1/models/raw") {
        const discovery = discoveryService.getLastResult() ?? await discoveryService.discover();
        return sendJson(res, 200, buildRawModels({ configStore: params.configStore, modelManager, discovery }));
      }

      // 模型管理 API: 扫描/发现本地模型
      if (req.method === "POST" && url.pathname === "/v1/kgm/models/discover") {
        const payload = (await readJson(req)) as {
          scanHuggingFace?: boolean;
          scanOllama?: boolean;
          scanLocalDirs?: string[];
          maxDepth?: number;
          minSizeMB?: number;
        };
        const { globalModelDiscovery } = await import("../inference/modelDiscovery.js");
        const models = await globalModelDiscovery.discoverAll(payload);
        return sendJson(res, 200, { models, discoveredAt: new Date().toISOString() });
      }

      // 模型管理 API: 获取已发现的模型
      if (req.method === "GET" && url.pathname === "/v1/kgm/models/discovered") {
        const { globalModelDiscovery } = await import("../inference/modelDiscovery.js");
        return sendJson(res, 200, { models: globalModelDiscovery.getDiscoveredModels() });
      }

      // 模型管理 API: 导入已发现的模型
      if (req.method === "POST" && url.pathname.startsWith("/v1/kgm/models/discovered/")) {
        const modelId = url.pathname.substring("/v1/kgm/models/discovered/".length);
        const { globalModelDiscovery } = await import("../inference/modelDiscovery.js");
        const discovered = globalModelDiscovery.getModel(modelId);
        if (!discovered) {
          return sendJson(res, 404, kgmErrorBody("model_not_found", `Model not found: ${modelId}`, 404));
        }
        const payload = (await readJson(req)) as {
          runtime?: "native" | "ollama" | "openai-compatible";
          autoStart?: boolean;
        };
        const result = await modelManager.createModel({
          pull: {
            sourceType: discovered.source,
            localPath: discovered.path,
            modelName: discovered.id,
          },
          runtime: payload.runtime ? { runtime: payload.runtime } : undefined,
          autoStart: payload.autoStart ?? false,
        });
        return sendJson(res, 200, result);
      }

      // 模型管理 API: 上传本地模型
      if (req.method === "POST" && url.pathname === "/v1/kgm/models/upload") {
        const payload = (await readJson(req)) as {
          localPath: string;
          name?: string;
          modelName?: string;
          runtime?: "native" | "ollama" | "openai-compatible";
          autoStart?: boolean;
        };
        const result = await modelManager.createModel({
          pull: {
            sourceType: "local",
            localPath: payload.localPath,
            name: payload.name,
            modelName: payload.modelName,
          },
          runtime: payload.runtime ? { runtime: payload.runtime } : undefined,
          autoStart: payload.autoStart ?? false,
        });
        return sendJson(res, 200, result);
      }

      // 模型管理 API: 列出所有模型（详细）
      if (req.method === "GET" && url.pathname === "/v1/kgm/models") {
        return sendJson(res, 200, {
          artifacts: modelManager.listArtifacts(),
          runtimes: modelManager.listRuntimes(),
          models: modelManager.listModels(),
        });
      }

      // 模型管理 API: 删除模型
      if (req.method === "DELETE" && url.pathname.startsWith("/v1/kgm/models/")) {
        const modelId = url.pathname.substring("/v1/kgm/models/".length);
        const result = modelManager.deleteManagedEntity(modelId);
        return sendJson(res, 200, { success: true, result });
      }

      // 模型管理 API: 标签管理 - 添加标签
      if (req.method === "POST" && url.pathname.match(/^\/v1\/kgm\/models\/([^/]+)\/tags\/add$/)) {
        const match = url.pathname.match(/^\/v1\/kgm\/models\/([^/]+)\/tags\/add$/);
        if (!match) return sendJson(res, 404, kgmErrorBody("not_found", "Not found", 404));
        const modelId = match[1];
        const payload = (await readJson(req)) as { tags: string[] };
        modelManager.addTags(modelId, payload.tags);
        return sendJson(res, 200, { success: true, modelId, tags: payload.tags });
      }

      // 模型管理 API: 标签管理 - 移除标签
      if (req.method === "POST" && url.pathname.match(/^\/v1\/kgm\/models\/([^/]+)\/tags\/remove$/)) {
        const match = url.pathname.match(/^\/v1\/kgm\/models\/([^/]+)\/tags\/remove$/);
        if (!match) return sendJson(res, 404, kgmErrorBody("not_found", "Not found", 404));
        const modelId = match[1];
        const payload = (await readJson(req)) as { tags: string[] };
        modelManager.removeTags(modelId, payload.tags);
        return sendJson(res, 200, { success: true, modelId, tags: payload.tags });
      }

      // 模型管理 API: 标签管理 - 设置标签
      if (req.method === "PUT" && url.pathname.match(/^\/v1\/kgm\/models\/([^/]+)\/tags$/)) {
        const match = url.pathname.match(/^\/v1\/kgm\/models\/([^/]+)\/tags$/);
        if (!match) return sendJson(res, 404, kgmErrorBody("not_found", "Not found", 404));
        const modelId = match[1];
        const payload = (await readJson(req)) as { tags: string[] };
        modelManager.setTags(modelId, payload.tags);
        return sendJson(res, 200, { success: true, modelId, tags: payload.tags });
      }

      if (req.method === "POST" && (url.pathname === "/v1/embeddings" || url.pathname === "/v1/embed")) {
        const payload = (await readJson(req)) as {
          model?: string;
          input: string | string[];
          encoding_format?: string;
        };
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        const embeddings = await Promise.all(inputs.map((text) => params.embedder.embed(text)));
        const results = embeddings.map((embedding, index) => ({
          object: "embedding",
          index,
          embedding: payload.encoding_format === "base64" ? Buffer.from(embedding).toString("base64") : embedding,
        }));
        return sendJson(res, 200, {
          object: "list",
          data: results,
          model: payload.model || params.configStore.get().embedding.model,
          usage: {
            prompt_tokens: inputs.reduce((acc, text) => acc + Math.ceil(text.length / 4), 0),
            total_tokens: inputs.reduce((acc, text) => acc + Math.ceil(text.length / 4), 0),
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/images/generations") {
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await proxyImagesGenerations(payload, params.configStore.get());
        return sendMediaProxyResult(res, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/images/edits") {
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await proxyImagesEdits(payload, params.configStore.get());
        return sendMediaProxyResult(res, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/images/variations") {
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await proxyImagesVariations(payload, params.configStore.get());
        return sendMediaProxyResult(res, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await proxyAudioSpeech(payload, params.configStore.get());
        return sendMediaProxyResult(res, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
        const contentType = String(req.headers["content-type"] ?? "");
        if (contentType.toLowerCase().includes("multipart/form-data")) {
          const allow = assertVirtualKeyModelAllowed(auth, []);
          if (!allow.ok) return sendJson(res, allow.status, allow.body);
          const raw = await readRawHttpBody(req);
          const result = await proxyAudioTranscriptionsMultipart(
            raw,
            contentType,
            params.configStore.get(),
          );
          return sendMediaProxyResult(res, result);
        }
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await proxyAudioTranscriptions(payload, params.configStore.get());
        return sendMediaProxyResult(res, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/audio/translations") {
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await proxyAudioTranslations(payload, params.configStore.get());
        return sendMediaProxyResult(res, result);
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/v1/videos/generations" || url.pathname === "/v1/kgm/media/video")
      ) {
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await startVideoGenerationJob(payload, params.configStore.get(), undefined, {
          ownerKeyId: auth.keyId,
        });
        return sendMediaProxyResult(res, result);
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/media/jobs/")) {
        const id = url.pathname.slice("/v1/kgm/media/jobs/".length).replace(/\/$/, "");
        if (!id) return sendJson(res, 400, kgmErrorBody("invalid_job_id", "Missing job id", 400));
        const job = getMediaJobStore().getForCaller(id, auth);
        if (!job) {
          return sendJson(res, 404, mediaFail("job_not_found", `Unknown job: ${id}`).body);
        }
        return sendJson(res, 200, job);
      }

      if (req.method === "POST" && url.pathname === "/v1/rerank") {
        const payload = (await readJson(req)) as Record<string, unknown>;
        const allow = assertVirtualKeyModelAllowed(auth, [modelFromBody(payload)]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const result = await proxyRerank(payload, params.configStore.get());
        return sendMediaProxyResult(res, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/search") {
        const payload = (await readJson(req)) as {
          query: string;
          mode?: "hybrid" | "vector" | "lexical" | "web" | "kg";
          top_k?: number;
          userId?: string;
          namespace?: string;
        };
        const topK = Math.max(1, Math.min(payload.top_k ?? 10, 50));
        const mode = payload.mode ?? "hybrid";
        
        const results: Array<{
          id: string;
          type: string;
          title: string;
          snippet: string;
          url?: string;
          score: number;
        }> = [];

        if (mode === "lexical") {
          if (payload.userId) {
            const memResults = await params.memoryStore.search(
              payload.userId,
              payload.query,
              params.embedder,
              topK,
              { lexicalWeight: 0.95, overFetch: 5 },
            );
            results.push(
              ...memResults.map((r) => ({
                id: r.id,
                type: "memory",
                title: r.text.substring(0, 50) + "...",
                snippet: r.text.substring(0, 200) + "...",
                score: r.score ?? 0.5,
              })),
            );
          }
        }

        if (mode === "vector" || mode === "hybrid") {
          if (payload.userId) {
            const memOpts = memorySearchOptionsFromKgm({});
            const memResults = await params.memoryStore.search(
              payload.userId,
              payload.query,
              params.embedder,
              topK,
              memOpts,
            );
            results.push(
              ...memResults.map((r) => ({
                id: r.id,
                type: "memory",
                title: r.text.substring(0, 50) + "...",
                snippet: r.text.substring(0, 200) + "...",
                score: r.score ?? 0.5,
              })),
            );
          }
        }

        if (mode === "kg" || mode === "hybrid") {
          const namespace = payload.namespace || payload.userId;
          if (namespace) {
            try {
              const kgSubgraph = await params.graphStore.querySubgraph({
                query: payload.query,
                namespace,
                limit: topK,
              });
              results.push(
                ...kgSubgraph.triples.map((r, idx) => ({
                  id: r.id,
                  type: "kg",
                  title: `${r.subject} ${r.predicate} ${r.object}`,
                  snippet: `${r.subject} ${r.predicate} ${r.object}`,
                  score: 0.3 - (idx * 0.01),
                })),
              );
            } catch {
              // Graph search not available
            }
          }
        }

        if (mode === "web" || mode === "hybrid") {
          const searchTool = params.toolRegistry.getDefinition("search_web");
          if (searchTool) {
            try {
              const webResult = await params.toolRegistry.execute("search_web", { query: payload.query, top_k: topK });
              if (webResult && webResult.results) {
                results.push(
                  ...(webResult.results as any[]).map((r: any) => ({
                    id: r.url || `web_${results.length}`,
                    type: "web",
                    title: r.title || "Untitled",
                    snippet: r.snippet || "",
                    url: r.url,
                    score: 0.7,
                  })),
                );
              }
            } catch {
              // Web search not available
            }
          }
        }

        results.sort((a, b) => b.score - a.score);
        
        return sendJson(res, 200, {
          query: payload.query,
          mode,
          top_k: topK,
          results: results.slice(0, topK),
          total: results.length,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/agents") {
        return sendJson(res, 200, { agents: agentStore.list() });
      }

      if (req.method === "POST" && url.pathname === "/v1/agents") {
        const payload = (await readJson(req)) as {
          name: string;
          model?: string;
          system_prompt?: string;
          tools?: string[];
          memory?: { enabled: boolean };
        };
        const agent = agentStore.create({
          name: payload.name,
          model: payload.model || params.configStore.get().llm.model,
          systemPrompt: payload.system_prompt || "",
          tools: payload.tools || [],
          memory: payload.memory?.enabled ?? true,
        });
        return sendJson(res, 201, { agent });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/agents/")) {
        const id = url.pathname.replace("/v1/agents/", "");
        const agent = agentStore.get(id);
        if (!agent) {
          return sendJson(res, 404, { error: "agent_not_found" });
        }
        return sendJson(res, 200, { agent });
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/v1/agents/")) {
        const id = url.pathname.replace("/v1/agents/", "");
        const deleted = agentStore.delete(id);
        return sendJson(res, 200, { deleted });
      }

      if (req.method === "POST" && url.pathname.match(/^\/v1\/agents\/[^/]+\/execute$/)) {
        const match = url.pathname.match(/^\/v1\/agents\/([^/]+)\/execute$/);
        if (!match) {
          return sendJson(res, 404, { error: "invalid_agent_path" });
        }
        const agentId = match[1];
        const agent = agentStore.get(agentId);
        if (!agent) {
          return sendJson(res, 404, { error: "agent_not_found" });
        }
        
        const payload = (await readJson(req)) as {
          input: string;
          session_id?: string;
          stream?: boolean;
          async?: boolean;
          collaborate_with?: string[];
          collaborateWith?: string[];
          max_agent_hops?: number;
        };

        const collaborateWith = payload.collaborate_with ?? payload.collaborateWith;
        if (collaborateWith && collaborateWith.length > 0) {
          const run = await multiAgentRuntime.start({
            goal: payload.input,
            sessionId: payload.session_id,
            collaborateWith: [agentId, ...collaborateWith],
            maxAgentHops: payload.max_agent_hops,
            agents: [
              {
                id: agent.id,
                name: agent.name,
                role: "supervisor",
                systemPrompt: agent.systemPrompt,
                model: agent.model,
                tools: agent.tools,
              },
            ],
          });
          return sendJson(res, 200, run);
        }

        if (payload.async) {
          const taskId = taskStore.create({
            type: "agent_execute",
            agentId,
            input: payload.input,
            sessionId: payload.session_id,
            status: "queued",
          });
          return sendJson(res, 202, { task_id: taskId, status: "queued" });
        }

        const kgmRequest: KgmRequest = {
          userId: payload.session_id || "anonymous",
          input: payload.input,
          sessionId: payload.session_id,
          model: agent.model,
          metadata: {
            agentId,
            tools: agent.tools,
            mode: agent.systemPrompt ? "reasoning" : "chat",
            system_prompt_addon: agent.systemPrompt,
          },
          toolPolicy:
            agent.tools.length > 0 ? { allowed: agent.tools, maxRounds: 3 } : undefined,
          kgm: agent.systemPrompt
            ? { playground: { extraSystemPrompt: agent.systemPrompt } }
            : undefined,
        };

        const response = await params.scheduler.run(kgmRequest);
        return sendJson(res, 200, response);
      }

      if (req.method === "GET" && url.pathname === "/v1/agent-runs") {
        return sendJson(res, 200, { runs: multiAgentRuntime.listRuns() });
      }

      if (req.method === "POST" && url.pathname === "/v1/agent-runs") {
        const payload = (await readJson(req)) as {
          goal: string;
          session_id?: string;
          strategy?: "supervisor";
          max_agent_hops?: number;
          agents?: Array<{
            id?: string;
            name: string;
            role?: "supervisor" | "specialist";
            system_prompt?: string;
            model?: string;
            tools?: string[];
            task_type?: string;
          }>;
          collaborate_with?: string[];
        };
        if (!payload.goal?.trim()) {
          return sendJson(res, 400, { error: "goal_required" });
        }
        const run = await multiAgentRuntime.start({
          goal: payload.goal,
          sessionId: payload.session_id,
          strategy: payload.strategy ?? "supervisor",
          maxAgentHops: payload.max_agent_hops,
          agents: payload.agents,
          collaborateWith: payload.collaborate_with,
        });
        return sendJson(res, run.status === "failed" ? 500 : 200, run);
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/agent-runs/")) {
        const id = url.pathname.replace("/v1/agent-runs/", "");
        const run = multiAgentRuntime.getRun(id);
        if (!run) {
          return sendJson(res, 404, { error: "agent_run_not_found" });
        }
        return sendJson(res, 200, { run });
      }

      if (req.method === "POST" && url.pathname === "/v1/tasks") {
        const payload = (await readJson(req)) as {
          type?: string;
          input: string;
          agent_id?: string;
          session_id?: string;
        };
        const taskId = taskStore.create({
          type: payload.type || "inference",
          input: payload.input,
          agentId: payload.agent_id,
          sessionId: payload.session_id,
          status: "queued",
        });
        return sendJson(res, 202, { task_id: taskId, status: "queued" });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/tasks/")) {
        const id = url.pathname.replace("/v1/tasks/", "");
        const task = taskStore.get(id);
        if (!task) {
          return sendJson(res, 404, { error: "task_not_found" });
        }
        return sendJson(res, 200, { task });
      }

      if (req.method === "POST" && url.pathname.match(/^\/v1\/tasks\/[^/]+\/cancel$/)) {
        const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
        if (!match) {
          return sendJson(res, 404, { error: "invalid_task_path" });
        }
        const taskId = match[1];
        const cancelled = taskStore.cancel(taskId);
        return sendJson(res, 200, { cancelled, task_id: taskId });
      }

      if (req.method === "GET" && url.pathname === "/v1/tasks") {
        const status = url.searchParams.get("status");
        let tasks = taskStore.list();
        if (status) {
          tasks = tasks.filter((t) => t.status === status);
        }
        return sendJson(res, 200, { tasks });
      }

      if (req.method === "GET" && url.pathname === "/v1/workflows") {
        const state = url.searchParams.get("state");
        let workflows = workflowStore.list();
        if (state) {
          workflows = workflows.filter((w) => w.state === state);
        }
        return sendJson(res, 200, { workflows });
      }

      if (req.method === "POST" && url.pathname === "/v1/workflows") {
        const payload = (await readJson(req)) as {
          name: string;
          description?: string;
          nodes: Array<{ id: string; type: string; agentId?: string; tool?: string; config?: any }>;
          edges: Array<{ source: string; target: string; condition?: string }>;
          state?: "draft" | "active" | "paused" | "archived";
        };
        const workflow = workflowStore.create({
          name: payload.name,
          description: payload.description,
          nodes: payload.nodes,
          edges: payload.edges,
          state: payload.state || "draft",
        });
        return sendJson(res, 201, { workflow });
      }

      if (req.method === "GET" && url.pathname.match(/^\/v1\/workflows\/[^/]+$/)) {
        const id = url.pathname.replace("/v1/workflows/", "");
        const workflow = workflowStore.get(id);
        if (!workflow) {
          return sendJson(res, 404, { error: "workflow_not_found" });
        }
        return sendJson(res, 200, { workflow });
      }

      if (req.method === "PUT" && url.pathname.match(/^\/v1\/workflows\/[^/]+$/)) {
        const id = url.pathname.replace("/v1/workflows/", "");
        const payload = (await readJson(req)) as Partial<{
          name?: string;
          description?: string;
          nodes?: any[];
          edges?: any[];
          state?: "draft" | "active" | "paused" | "archived";
        }>;
        const updated = workflowStore.update(id, payload);
        if (!updated) {
          return sendJson(res, 404, { error: "workflow_not_found" });
        }
        const workflow = workflowStore.get(id);
        return sendJson(res, 200, { workflow });
      }

      if (req.method === "DELETE" && url.pathname.match(/^\/v1\/workflows\/[^/]+$/)) {
        const id = url.pathname.replace("/v1/workflows/", "");
        const deleted = workflowStore.delete(id);
        if (!deleted) {
          return sendJson(res, 404, { error: "workflow_not_found" });
        }
        return sendJson(res, 200, { deleted: true, workflow_id: id });
      }

      if (req.method === "POST" && url.pathname.match(/^\/v1\/workflows\/[^/]+\/execute$/)) {
        const match = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/execute$/);
        if (!match) {
          return sendJson(res, 404, { error: "invalid_workflow_path" });
        }
        const workflowId = match[1];
        const workflow = workflowStore.get(workflowId);
        if (!workflow) {
          return sendJson(res, 404, { error: "workflow_not_found" });
        }
        const payload = (await readJson(req)) as { input: any };
        const execution = workflowExecutionStore.create({
          workflowId,
          input: payload.input,
          status: "queued",
        });
        return sendJson(res, 202, { execution });
      }

      if (req.method === "GET" && url.pathname === "/v1/workflow-executions") {
        const workflowId = url.searchParams.get("workflow_id");
        let executions = workflowExecutionStore.list();
        if (workflowId) {
          executions = executions.filter((e) => e.workflowId === workflowId);
        }
        return sendJson(res, 200, { executions });
      }

      if (req.method === "GET" && url.pathname.match(/^\/v1\/workflow-executions\/[^/]+$/)) {
        const id = url.pathname.replace("/v1/workflow-executions/", "");
        const execution = workflowExecutionStore.get(id);
        if (!execution) {
          return sendJson(res, 404, { error: "execution_not_found" });
        }
        return sendJson(res, 200, { execution });
      }

      if (req.method === "GET" && url.pathname === "/v1/evaluations") {
        const type = url.searchParams.get("type");
        const status = url.searchParams.get("status");
        let evaluations = evaluationStore.list();
        if (type) {
          evaluations = evaluations.filter((e) => e.type === type);
        }
        if (status) {
          evaluations = evaluations.filter((e) => e.status === status);
        }
        return sendJson(res, 200, { evaluations });
      }

      if (req.method === "POST" && url.pathname === "/v1/evaluations") {
        const payload = (await readJson(req)) as {
          name: string;
          type: "model" | "agent" | "prompt" | "workflow";
          target_id?: string;
          benchmark?: string;
          config?: any;
        };
        const evaluation = evaluationStore.create({
          name: payload.name,
          type: payload.type,
          targetId: payload.target_id,
          benchmark: payload.benchmark,
          config: payload.config || {},
          status: "queued",
        });
        return sendJson(res, 201, { evaluation });
      }

      if (req.method === "GET" && url.pathname.match(/^\/v1\/evaluations\/[^/]+$/)) {
        const id = url.pathname.replace("/v1/evaluations/", "");
        const evaluation = evaluationStore.get(id);
        if (!evaluation) {
          return sendJson(res, 404, { error: "evaluation_not_found" });
        }
        const runs = evaluationStore.getRuns(id);
        return sendJson(res, 200, { evaluation, runs });
      }

      if (req.method === "POST" && url.pathname.match(/^\/v1\/evaluations\/[^/]+\/runs$/)) {
        const match = url.pathname.match(/^\/v1\/evaluations\/([^/]+)\/runs$/);
        if (!match) {
          return sendJson(res, 404, { error: "invalid_evaluation_path" });
        }
        const evaluationId = match[1];
        const evaluation = evaluationStore.get(evaluationId);
        if (!evaluation) {
          return sendJson(res, 404, { error: "evaluation_not_found" });
        }
        const payload = (await readJson(req)) as {
          input: any;
          output?: any;
          score?: number;
          metrics?: Record<string, number>;
          feedback?: string;
        };
        const run = evaluationStore.addRun(evaluationId, payload);
        return sendJson(res, 201, { run });
      }

      if (req.method === "DELETE" && url.pathname.match(/^\/v1\/evaluations\/[^/]+$/)) {
        const id = url.pathname.replace("/v1/evaluations/", "");
        const deleted = evaluationStore.delete(id);
        if (!deleted) {
          return sendJson(res, 404, { error: "evaluation_not_found" });
        }
        return sendJson(res, 200, { deleted: true, evaluation_id: id });
      }

      if (req.method === "GET" && url.pathname === "/v1/skills") {
        const tools = params.toolRegistry.listDefinitions();
        if (params.skillRuntime) {
          const skillRegistry = params.skillRuntime.getSkillRegistry();
          const skillNames = skillRegistry.listNames();
          const skills = skillNames.map(name => {
            const skill = skillRegistry.get(name);
            return skill || { name, description: "", steps: [] };
          });
          return sendJson(res, 200, { tools, skills });
        }
        return sendJson(res, 200, { tools, skills: [] });
      }

      if (req.method === "POST" && url.pathname === "/v1/skills") {
        const payload = (await readJson(req)) as {
          name: string;
          description: string;
          schema?: Record<string, unknown>;
          type?: "tool" | "skill";
        };
        if (payload.type === "skill" && params.skillRuntime) {
          const skillRegistry = params.skillRuntime.getSkillRegistry();
          const skill: SkillDefinition = {
            name: payload.name,
            description: payload.description,
            steps: [],
          };
          skillRegistry.register(skill);
          return sendJson(res, 201, { skill });
        } else {
          const toolDef: ToolDefinition = {
            name: payload.name,
            kind: "tool" as const,
            description: payload.description,
            inputSchema: payload.schema || {},
            outputSchema: {},
          };
          params.toolRegistry.register(toolDef, async () => ({ status: "not_implemented" }));
          return sendJson(res, 201, { tool: toolDef });
        }
      }

      if (req.method === "GET" && url.pathname.match(/^\/v1\/models\/[^/]+$/)) {
        const modelId = url.pathname.replace("/v1/models/", "");
        const discovery = discoveryService.getLastResult() ?? await discoveryService.discover();
        const effectiveModels = buildEffectiveModels({ configStore: params.configStore, modelManager, discovery });
        const model = (effectiveModels.data as any[]).find((m: any) => m.id === modelId);
        if (!model) {
          return sendJson(res, 404, { error: "model_not_found" });
        }
        return sendJson(res, 200, model);
      }

      if (req.method === "POST" && url.pathname === "/v1/models/pull") {
        const payload = (await readJson(req)) as { model: string };
        const artifact = await modelManager.pull({ name: payload.model });
        return sendJson(res, 200, { artifact });
      }

      if (req.method === "GET" && url.pathname === "/v1/logs") {
        const limit = parseNumber(url.searchParams.get("limit")) ?? 100;
        const type = url.searchParams.get("type");
        const logs = snapshotHttpAccessLog(limit);
        return sendJson(res, 200, {
          logs,
          limit,
          type,
          total: logs.length,
          note: "Recent HTTP paths after auth (ring buffer); not full application audit logs.",
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/admin/config") {
        return sendJson(res, 200, toPublicKgmConfig(params.configStore.get()));
      }

      if (req.method === "GET" && url.pathname === "/v1/admin/versions") {
        return sendJson(res, 200, {
          version: process.env.npm_package_version || "0.2.1",
          nodeVersion: process.version,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/admin/reload") {
        const reloaded = params.configStore.reloadFromDisk();
        if (reloaded && params.skillRuntime) {
          syncPlaygroundFromConfig({
            skillRegistry: params.skillRuntime.getSkillRegistry(),
            toolRegistry: params.toolRegistry,
            configStore: params.configStore,
          });
        }
        return sendJson(res, 200, {
          status: "ok",
          reloaded: Boolean(reloaded),
          message: reloaded ? "Config reloaded from disk" : "No persistPath or config file to reload",
        });
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/v1/memory/")) {
        const id = url.pathname.replace("/v1/memory/", "");
        const deleted = await params.memoryStore.deleteByChunkId(id);
        if (!deleted) {
          return sendJson(res, 404, { error: "memory_not_found", deleted: false });
        }
        return sendJson(res, 200, { deleted: true, id });
      }

      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/completions")) {
        const payload = (await readJson(req)) as OpenAiChatCompletionRequest & { model?: string };
        const requestedModel = typeof payload.model === "string" ? payload.model : undefined;
        const resolved = await resolveModelAlias(requestedModel);
        if (resolved?.alias) {
          payload.model = resolved.model;
        }
        if (auth.kind === "virtual" && auth.virtualKey?.allowedModels?.length) {
          const allow = assertVirtualKeyModelAllowed(auth, [
            requestedModel,
            typeof payload.model === "string" ? payload.model : undefined,
            resolved?.alias?.alias,
          ]);
          if (!allow.ok) {
            return sendJson(res, allow.status, allow.body);
          }
        }
        const requestHeaders = normalizeIncomingHttpHeaders(
          req.headers as Record<string, string | string[] | undefined>,
        );
        if (payload.stream) {
          const proxied = await maybeProxyNativeOpenAiStream({
            configStore: params.configStore,
            modelManager,
            protocol: "chat",
            payload,
            send: (upstream, meta) => sendNormalizedUpstreamSse(res, upstream, meta),
          });
          if (proxied) {
            return;
          }
          const events = streamOpenAiChatCompletion({
            request: payload,
            contextBuilder: params.contextBuilder,
            llmClient: params.llmClient,
            toolRegistry: params.toolRegistry,
            configStore: params.configStore,
            outputSchema: params.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
            responseStore,
            skillRuntime: params.skillRuntime,
            requestHeaders,
          });
          return await sendSse(res, events, { streamSource: "bridge:auto-routing" });
        }
        const response = await createOpenAiChatCompletion({
          request: payload,
          contextBuilder: params.contextBuilder,
          llmClient: params.llmClient,
          toolRegistry: params.toolRegistry,
          configStore: params.configStore,
          outputSchema: params.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
          responseStore,
          skillRuntime: params.skillRuntime,
          requestHeaders,
        });
        const corr = (response.kgm as { correlation?: { requestId?: string; traceId?: string } } | undefined)
          ?.correlation;
        const ops = (response.kgm as { ops?: { traceId?: string } } | undefined)?.ops;
        return sendJson(
          res,
          200,
          response,
          traceResponseHeaders({
            requestId: corr?.requestId ?? String(response.id ?? ""),
            traceId: corr?.traceId ?? ops?.traceId ?? String(response.id ?? ""),
          }),
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const payload = (await readJson(req)) as OpenAiResponsesRequest;
        const requestedModel = typeof payload.model === "string" ? payload.model : undefined;
        const allow = assertVirtualKeyModelAllowed(auth, [requestedModel]);
        if (!allow.ok) return sendJson(res, allow.status, allow.body);
        const requestHeaders = normalizeIncomingHttpHeaders(
          req.headers as Record<string, string | string[] | undefined>,
        );
        if (payload.stream) {
          const proxied = await maybeProxyNativeOpenAiStream({
            configStore: params.configStore,
            modelManager,
            protocol: "responses",
            payload,
            send: (upstream, meta) => sendNormalizedUpstreamSse(res, upstream, meta),
          });
          if (proxied) {
            return;
          }
          const events = streamOpenAiResponse({
            request: payload,
            contextBuilder: params.contextBuilder,
            llmClient: params.llmClient,
            toolRegistry: params.toolRegistry,
            configStore: params.configStore,
            outputSchema: params.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
            responseStore,
            skillRuntime: params.skillRuntime,
            requestHeaders,
          });
          return await sendSse(res, events, { streamSource: "bridge:auto-routing" });
        }
        const response = await createOpenAiResponse({
          request: payload,
          contextBuilder: params.contextBuilder,
          llmClient: params.llmClient,
          toolRegistry: params.toolRegistry,
          configStore: params.configStore,
          outputSchema: params.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
          responseStore,
          skillRuntime: params.skillRuntime,
          requestHeaders,
        });
        const corr = (response.kgm as { correlation?: { requestId?: string; traceId?: string } } | undefined)
          ?.correlation;
        const ops = (response.kgm as { ops?: { traceId?: string } } | undefined)?.ops;
        return sendJson(
          res,
          200,
          response,
          traceResponseHeaders({
            requestId: corr?.requestId ?? String(response.id ?? ""),
            traceId: corr?.traceId ?? ops?.traceId ?? String(response.id ?? ""),
          }),
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        void readAnthropicApiKey(req);
        const payload = (await readJson(req)) as AnthropicMessagesRequest;
        const requestHeaders = normalizeIncomingHttpHeaders(
          req.headers as Record<string, string | string[] | undefined>,
        );
        if (shouldProxyAnthropicMessagesNative(payload as unknown as Record<string, unknown>)) {
          const apiKey =
            readAnthropicApiKey(req) ??
            params.configStore.get().llm.apiKey ??
            process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            return sendJson(res, 400, { error: "anthropic_api_key_required" });
          }
          const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
          const nativeBody = { ...payload } as Record<string, unknown>;
          delete nativeBody.kgm;
          if (payload.stream) {
            const events = streamAnthropicMessagesNative({
              baseUrl,
              apiKey,
              body: nativeBody,
              requestHeaders,
              timeoutMs: params.configStore.get().llm.timeoutMs,
            });
            return await sendSse(res, events, { appendDone: false });
          }
          const response = await postAnthropicMessages({
            baseUrl,
            apiKey,
            body: nativeBody,
            requestHeaders,
            timeoutMs: params.configStore.get().llm.timeoutMs,
          });
          return sendJson(res, 200, response);
        }
        if (payload.stream) {
          const events = streamAnthropicMessagesJsonLines({
            request: payload,
            contextBuilder: params.contextBuilder,
            llmClient: params.llmClient,
            toolRegistry: params.toolRegistry,
            configStore: params.configStore,
            outputSchema: params.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
            responseStore,
            skillRuntime: params.skillRuntime,
          });
          return await sendSse(res, events, { appendDone: false });
        }
        const response = await createAnthropicMessagesResponse({
          request: payload,
          contextBuilder: params.contextBuilder,
          llmClient: params.llmClient,
          toolRegistry: params.toolRegistry,
          configStore: params.configStore,
          outputSchema: params.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
          responseStore,
          skillRuntime: params.skillRuntime,
        });
        return sendJson(res, 200, response);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/config") {
        return sendJson(res, 200, toPublicKgmConfig(params.configStore.get()));
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/ops/config-status") {
        return sendJson(res, 200, buildControlPlaneStatus(params.configStore));
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/auto-routing") {
        return sendJson(res, 200, params.configStore.get().autoRouting);
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/auto-routing") {
        const payload = (await readJson(req)) as KgmConfigPatch["autoRouting"];
        const updated = params.configStore.update({ autoRouting: payload ?? {} });
        return sendJson(res, 200, updated.autoRouting);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/auto-routing/summary") {
        if (!params.autoRoutingClient) {
          return sendJson(res, 501, { error: "auto_routing_not_enabled" });
        }
        const limit = parseNumber(url.searchParams.get("limit"));
        return sendJson(res, 200, params.autoRoutingClient.getAuditSummary(limit));
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/auto-routing/audit") {
        if (!params.autoRoutingClient) {
          return sendJson(res, 501, { error: "auto_routing_not_enabled" });
        }
        const limit = parseNumber(url.searchParams.get("limit"));
        return sendJson(res, 200, { items: params.autoRoutingClient.listAuditEntries(limit) });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/config") {
        const payload = (await readJson(req)) as KgmConfigPatch & { routingNote?: string };
        const current = params.configStore.get();
        let routingEntry: ReturnType<typeof buildUpdateEntry> | null = null;
        if (payload.routing) {
          const nextRouting = applyRoutingPatch(current.routing, payload.routing);
          payload.routing = nextRouting;
          routingEntry = buildUpdateEntry(nextRouting, payload.routingNote);
        }
        const updated = params.configStore.update(payload);
        if (payload.sandboxAdapters) {
          params.sandboxManager.reloadAdapters();
        }
        if (params.skillRuntime) {
          syncPlaygroundFromConfig({
            skillRegistry: params.skillRuntime.getSkillRegistry(),
            toolRegistry: params.toolRegistry,
            configStore: params.configStore,
          });
        }
        if (routingEntry) {
          routingHistory.record(routingEntry);
        }
        return sendJson(res, 200, toPublicKgmConfig(updated));
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/routing") {
        return sendJson(res, 200, params.configStore.get().routing);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/routing/versions") {
        const limit = parseNumber(url.searchParams.get("limit"));
        return sendJson(res, 200, { items: routingHistory.list(limit ?? undefined) });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/routing") {
        const payload = await readJson(req);
        const parsed = parseRoutingUpdatePayload(payload);
        if (!parsed) {
          return sendJson(res, 400, { error: "invalid_payload" });
        }
        const current = params.configStore.get().routing;
        const nextRouting = applyRoutingPatch(current, parsed.patch);
        params.configStore.update({ routing: nextRouting });
        routingHistory.record(buildUpdateEntry(nextRouting, parsed.note));
        return sendJson(res, 200, nextRouting);
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/routing/rollback") {
        const payload = (await readJson(req)) as { version?: string; note?: string };
        const version = payload?.version;
        if (!version) {
          return sendJson(res, 400, { error: "version_required" });
        }
        const target = routingHistory.get(version);
        if (!target) {
          return sendJson(res, 404, { error: "version_not_found" });
        }
        const rollbackFrom = params.configStore.get().routing.version;
        params.configStore.update({ routing: target.config });
        routingHistory.record(buildRollbackEntry(target.config, rollbackFrom, payload?.note));
        return sendJson(res, 200, target.config);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/tools") {
        return sendJson(res, 200, { tools: params.toolRegistry.listDefinitions() });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/tools/stats") {
        return sendJson(res, 200, params.toolRegistry.getCallStats());
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/schemas/")) {
        const schemaId = url.pathname.replace("/v1/kgm/schemas/", "");
        const record = params.schemaRegistry.get(schemaId);
        if (!record) {
          return sendJson(res, 404, { error: "schema_not_found" });
        }
        return sendJson(res, 200, record);
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/schemas") {
        const payload = (await readJson(req)) as {
          schemaId: string;
          version: string;
          status: "draft" | "active" | "deprecated" | "retired";
          schema: Record<string, unknown>;
        };
        const record = params.schemaRegistry.register(payload);
        return sendJson(res, 200, record);
      }

      /**
       * 记忆写入：canonical `POST /v1/kgm/memory`，别名 `POST /v1/memory/store`（与常见 API 文稿对齐，语义完全相同）。
       */
      if (
        req.method === "POST" &&
        (url.pathname === "/v1/kgm/memory" || url.pathname === "/v1/memory/store")
      ) {
        const payload = (await readJson(req)) as {
          userId: string;
          text: string;
          source: string;
        };
        const embedding = await params.embedder.embed(payload.text);
        const now = new Date().toISOString();
        await params.memoryStore.add({
          id: `mem_${Date.now()}`,
          userId: payload.userId,
          text: payload.text,
          embedding,
          embeddingVersion: params.configStore.get().embedding.version,
          source: payload.source,
          createdAt: now,
          lastAccessedAt: now,
        });
        return sendJson(res, 200, { status: "ok" });
      }

      /**
       * 记忆检索：canonical `POST /v1/kgm/memory/search`，别名 `POST /v1/memory/query`。
       */
      if (
        req.method === "POST" &&
        (url.pathname === "/v1/kgm/memory/search" || url.pathname === "/v1/memory/query")
      ) {
        const payload = (await readJson(req)) as KgmRetrievalOptions & { userId: string; query: string; topK?: number };
        const topK = Math.max(1, Math.min(payload.topK ?? 5, 50));
        const memOpts = memorySearchOptionsFromKgm({
          strategy: payload.strategy,
          lexicalWeight: payload.lexicalWeight,
          overFetch: payload.overFetch,
          rerank: payload.rerank,
          rerankBlend: payload.rerankBlend,
        });
        const evidence = await params.memoryStore.search(
          payload.userId,
          payload.query,
          params.embedder,
          topK,
          memOpts,
        );
        return sendJson(res, 200, { evidence });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/shortest_path") {
        const payload = (await readJson(req)) as {
          from?: string;
          to?: string;
          maxHops?: number;
          userId?: string;
          namespace?: string;
        };
        const from = payload.from?.trim();
        const to = payload.to?.trim();
        if (!from || !to) {
          return sendJson(
            res,
            400,
            kgmErrorBody("from_to_required", "Request body must include from and to", 400),
          );
        }
        if (!params.graphStore.shortestPath) {
          return sendJson(
            res,
            501,
            kgmErrorBody("graph_path_unavailable", "Graph backend does not expose shortestPath", 501),
          );
        }
        const namespace = requireGraphNamespace(payload);
        const result = await params.graphStore.shortestPath({
          from,
          to,
          maxHops: payload.maxHops,
          namespace,
        });
        return sendJson(res, 200, { result });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/communities") {
        if (!params.graphStore.connectedCommunities) {
          return sendJson(
            res,
            501,
            kgmErrorBody("graph_communities_unavailable", "Graph backend has no community API", 501),
          );
        }
        const payload = (await readJson(req)) as { userId?: string; namespace?: string };
        const namespace = requireGraphNamespace(payload);
        const result = await params.graphStore.connectedCommunities({ namespace });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/reason/expand") {
        const body = (await readJson(req)) as {
          entity?: string;
          maxDepth?: number;
          relations?: string[];
          userId?: string;
          namespace?: string;
        };
        if (!body.entity?.trim()) {
          return sendJson(res, 400, kgmErrorBody("entity_required", "entity is required", 400));
        }
        if (!params.graphStore.reasonExpand) {
          return sendJson(
            res,
            501,
            kgmErrorBody("graph_expand_unavailable", "Graph backend has no reasonExpand", 501),
          );
        }
        const namespace = requireGraphNamespace(body);
        const result = await params.graphStore.reasonExpand({
          entity: body.entity.trim(),
          maxDepth: body.maxDepth ?? 2,
          relations: body.relations,
          namespace,
        });
        return sendJson(res, 200, { result });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/reason/rules") {
        const body = (await readJson(req)) as {
          rules?: GraphRule[];
          maxRounds?: number;
          source?: string;
          userId?: string;
          namespace?: string;
        };
        if (!params.graphStore.applyRules) {
          return sendJson(
            res,
            501,
            kgmErrorBody("graph_rules_unavailable", "Graph backend has no applyRules", 501),
          );
        }
        const rules = body.rules ?? [];
        const maxR = Math.max(1, Math.min(20, body.maxRounds ?? 5));
        const namespace = requireGraphNamespace(body);
        const added = await params.graphStore.applyRules({
          rules,
          maxRounds: maxR,
          source: body.source,
          namespace,
        });
        return sendJson(res, 200, { added, count: added.length });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/multimodal/embed") {
        const body = (await readJson(req)) as {
          imageBase64?: string;
          mimeType?: string;
          text?: string;
          model?: string;
        };
        if (!body.imageBase64) {
          return sendJson(res, 400, kgmErrorBody("image_required", "imageBase64 is required", 400));
        }
        const embedding = await embedImageRemote({
          request: {
            imageBase64: body.imageBase64,
            mimeType: body.mimeType,
            text: body.text,
            model: body.model,
          },
        });
        return sendJson(res, 200, { embedding, dim: embedding.length });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/triples") {
        const payload = (await readJson(req)) as {
          triples?: Array<{ subject: string; predicate: string; object: string; weight?: number }>;
          source?: string;
          userId?: string;
          namespace?: string;
        };
        const triples = payload.triples ?? [];
        const namespace = requireGraphNamespace(payload);
        const stored = await params.graphStore.addTriples({
          triples,
          source: payload.source ?? "api",
          namespace,
        });
        return sendJson(res, 200, { status: "ok", count: stored.length, triples: stored });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models") {
        return sendJson(res, 200, { models: modelManager.listModels() });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models/running") {
        return sendJson(res, 200, { models: modelManager.listRunningModels() });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/models/create") {
        const payload = (await readJson(req)) as Parameters<typeof modelManager.createModel>[0];
        const created = await modelManager.createModel(payload);
        return sendJson(res, 200, created);
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/models/") && url.pathname.endsWith("/metrics")) {
        const id = url.pathname.replace("/v1/kgm/models/", "").replace(/\/metrics$/, "");
        const metrics = modelManager.getRuntimeMetrics(id)
          ?? modelManager.listModels().find((item) => item.id === id || item.modelName === id)?.metrics;
        if (!metrics) {
          return sendJson(res, 404, { error: "model_metrics_not_found" });
        }
        return sendJson(res, 200, { metrics });
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/v1/kgm/models/")) {
        const id = url.pathname.replace("/v1/kgm/models/", "");
        return sendJson(res, 200, modelManager.deleteManagedEntity(id));
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models/artifacts") {
        return sendJson(res, 200, { artifacts: modelManager.listArtifacts() });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/models/pull") {
        const payload = (await readJson(req)) as {
          name?: string;
          modelName?: string;
          sourceType?: "huggingface" | "ollama" | "github" | "modelscope" | "direct" | "local";
          sourceUrl?: string;
          sourceRef?: string;
          filePath?: string;
          revision?: string;
          authToken?: string;
        };
        const artifact = await modelManager.pull(payload);
        return sendJson(res, 200, { artifact });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/models/artifacts/")) {
        const id = url.pathname.replace("/v1/kgm/models/artifacts/", "");
        const artifact = modelManager.getArtifact(id);
        if (!artifact) {
          return sendJson(res, 404, { error: "artifact_not_found" });
        }
        return sendJson(res, 200, { artifact });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models/runtimes") {
        return sendJson(res, 200, { runtimes: modelManager.listRuntimes() });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/models/runtimes") {
        const payload = (await readJson(req)) as {
          name?: string;
          modelName?: string;
          runtime: "native" | "llama.cpp" | "ds4" | "tokenspeed" | "ollama" | "vllm" | "sglang" | "mlx" | "openai-compatible" | "auto";
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
        };
        try {
          const runtime = modelManager.createRuntime(payload);
          return sendJson(res, 200, { runtime });
        } catch (error) {
          return sendJson(res, 400, kgmErrorBody("runtime_create_failed", String(error), 400));
        }
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/v1/kgm/models/runtimes/") &&
        url.pathname.endsWith("/lora")
      ) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/lora$/, "");
        const payload = (await readJson(req)) as { adapters?: ManagedLoraAdapter[]; adapter?: ManagedLoraAdapter };
        const adapters = payload.adapters ?? (payload.adapter ? [payload.adapter] : []);
        try {
          const runtime = modelManager.attachLoraAdapters(id, adapters);
          return sendJson(res, 200, { runtime, loraAdapters: runtime.loraAdapters ?? [] });
        } catch (error) {
          return sendJson(res, 400, kgmErrorBody("lora_attach_failed", String(error), 400));
        }
      }

      if (
        req.method === "GET" &&
        url.pathname.startsWith("/v1/kgm/models/runtimes/") &&
        url.pathname.endsWith("/lora")
      ) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/lora$/, "");
        try {
          return sendJson(res, 200, { loraAdapters: modelManager.listLoraAdapters(id) });
        } catch {
          return sendJson(res, 404, { error: "runtime_not_found" });
        }
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/weights/capabilities") {
        return sendJson(res, 200, getWeightCapabilityReport());
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/weights/resolve") {
        const payload = (await readJson(req)) as {
          artifactId?: string;
          localPath?: string;
          runtimeHints?: Array<"native" | "llama.cpp" | "ds4" | "tokenspeed" | "ollama" | "vllm" | "sglang" | "mlx" | "openai-compatible">;
          requestedRuntime?: "auto" | "native" | "llama.cpp" | "ds4" | "tokenspeed" | "ollama" | "vllm" | "sglang" | "mlx" | "openai-compatible";
        };
        const artifact = payload.artifactId
          ? modelManager.getArtifact(payload.artifactId)
          : payload.localPath
            ? {
                id: "ephemeral",
                name: "ephemeral",
                modelName: "ephemeral",
                sourceType: "local" as const,
                sourceRef: payload.localPath,
                localPath: payload.localPath,
                status: "ready" as const,
                runtimeHints: payload.runtimeHints ?? inferRuntimeHintsForModelPath(payload.localPath),
                notes: [],
                tags: [],
                metadata: {},
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }
            : undefined;
        const assessment = assessArtifactExecution(artifact);
        let resolvedRuntime: string | undefined;
        let resolveError: string | undefined;
        try {
          resolvedRuntime = resolveRuntimeKind({
            requested: payload.requestedRuntime ?? "auto",
            artifact,
          });
        } catch (error) {
          resolveError = String(error);
        }
        return sendJson(res, 200, {
          assessment,
          resolvedRuntime,
          resolveError,
          nativeGpu: getNativeGpuClosedLoopStatus(),
          closedLoop: getWeightCapabilityReport().closedLoop,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/runtime/gpu_throughput/plan") {
        const payload = (await readJson(req)) as {
          preference?: "vllm" | "sglang" | "auto";
          modelName?: string;
        };
        return sendJson(res, 200, planGpuThroughput({
          modelManager,
          preference: payload.preference,
          modelName: payload.modelName,
        }));
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/models/runtimes/")) {
        const id = url.pathname
          .replace("/v1/kgm/models/runtimes/", "")
          .replace(/\/(start|stop|lora|metrics)$/, "");
        const runtime = modelManager.getRuntime(id);
        if (!runtime) {
          return sendJson(res, 404, { error: "runtime_not_found" });
        }
        return sendJson(res, 200, { runtime });
      }

      if (req.method === "POST" && url.pathname.endsWith("/start") && url.pathname.startsWith("/v1/kgm/models/runtimes/")) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/start$/, "");
        const runtime = await modelManager.startRuntime(id);
        return sendJson(res, 200, { runtime });
      }

      if (req.method === "POST" && url.pathname.endsWith("/stop") && url.pathname.startsWith("/v1/kgm/models/runtimes/")) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/stop$/, "");
        const runtime = modelManager.stopRuntime(id);
        return sendJson(res, 200, { runtime });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/sandboxes/adapters") {
        return sendJson(res, 200, {
          adapters: params.sandboxManager.adapterStatus(),
          config: params.configStore.get().sandboxAdapters,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/sandboxes") {
        return sendJson(res, 200, {
          sandboxes: params.sandboxManager.list(),
          adapters: params.sandboxManager.adapterStatus(),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/sandboxes") {
        const payload = (await readJson(req)) as {
          kind?: "computer" | "browser" | "mobile";
          name?: string;
          notes?: string[];
        };
        const sandbox = params.sandboxManager.create({
          kind: payload.kind ?? "computer",
          name: payload.name,
          notes: payload.notes,
        });
        return sendJson(res, 200, { sandbox });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/sandboxes/")) {
        const id = url.pathname.replace("/v1/kgm/sandboxes/", "").replace(/\/(start|stop)$/, "");
        const sandbox = params.sandboxManager.get(id);
        if (!sandbox) {
          return sendJson(res, 404, { error: "sandbox_not_found" });
        }
        return sendJson(res, 200, { sandbox });
      }

      if (req.method === "POST" && url.pathname.endsWith("/start") && url.pathname.startsWith("/v1/kgm/sandboxes/")) {
        const id = url.pathname.replace("/v1/kgm/sandboxes/", "").replace(/\/start$/, "");
        return sendJson(res, 200, { sandbox: params.sandboxManager.start(id) });
      }

      if (req.method === "POST" && url.pathname.endsWith("/stop") && url.pathname.startsWith("/v1/kgm/sandboxes/")) {
        const id = url.pathname.replace("/v1/kgm/sandboxes/", "").replace(/\/stop$/, "");
        return sendJson(res, 200, { sandbox: params.sandboxManager.stop(id) });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/artifacts/")) {
        if (!params.artifactStore) {
          return sendJson(res, 501, { error: "artifact_store_not_enabled" });
        }
        const id = url.pathname.replace("/v1/kgm/artifacts/", "");
        try {
          const data = params.artifactStore.read(id, {
            offset: parseNumber(url.searchParams.get("offset")),
            limit: parseNumber(url.searchParams.get("limit")),
          });
          return sendJson(res, 200, data);
        } catch (error) {
          return sendJson(res, 404, { error: String(error) });
        }
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/sessions/")) {
        if (!params.sessionStore) {
          return sendJson(res, 501, { error: "session_store_not_enabled" });
        }
        const id = url.pathname.replace("/v1/kgm/sessions/", "");
        try {
          const data = params.sessionStore.read(id, {
            offset: parseNumber(url.searchParams.get("offset")),
            limit: parseNumber(url.searchParams.get("limit")),
          });
          return sendJson(res, 200, data);
        } catch (error) {
          return sendJson(res, 404, { error: String(error) });
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/execute") {
        const payload = (await readJson(req)) as KgmRequest;
        const response = await params.scheduler.run(payload);
        return sendJson(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/kce/compute") {
        const payload = validateKceComputePayload(await readJson(req));
        const requestId = payload.requestId ?? generateId("kce");
        const traceId =
          readTraceId(payload.metadata) ??
          resolveRequestTraceIds({
            headers: req.headers as Record<string, string | string[] | undefined>,
            body: {
              requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
              metadata: payload.metadata as Record<string, unknown> | undefined,
            },
            fallbackRequestId: requestId,
          }).traceId;
        const sessionId = payload.sessionId ?? payload.userId;
        const previewChars = params.configStore.get().context.artifactPreviewChars ?? 240;
        const enrichedPayload: KceComputeRequest = {
          ...payload,
          requestId,
          sessionId,
          metadata: {
            ...(payload.metadata ?? {}),
            traceId,
          },
        };

        if (params.sessionStore) {
          params.sessionStore.append(sessionId, {
            timestamp: new Date().toISOString(),
            role: "user",
            type: "input",
            content: payload.input,
          });
        }

        const requestArtifact = params.artifactStore?.writeJson(
          "kce_request",
          {
            request_id: requestId,
            session_id: sessionId,
            trace_id: traceId,
            payload: enrichedPayload,
          },
          previewChars,
        );

        try {
          const response = await kceEngine.compute(enrichedPayload);
          const traceArtifact = params.artifactStore?.writeJson(
            "kce_trace",
            {
              request_id: requestId,
              trace_id: traceId,
              reasoning_trace: response.reasoning_trace,
              execution_plan: response.execution_plan,
              validation: response.validation,
            },
            previewChars,
          );
          const responseArtifact = params.artifactStore?.writeJson(
            "kce_response",
            {
              request_id: requestId,
              session_id: sessionId,
              trace_id: traceId,
              response,
            },
            previewChars,
          );
          const sessionRef = params.sessionStore?.getRef(
            sessionId,
            params.configStore.get().context.sessionPreviewChars ?? 240,
          );
          if (params.sessionStore) {
            params.sessionStore.append(sessionId, {
              timestamp: new Date().toISOString(),
              role: "assistant",
              type: "final",
              content: response.answer,
            });
            params.sessionStore.append(sessionId, {
              timestamp: new Date().toISOString(),
              role: "tool",
              type: "tool",
              name: "kce_audit",
              output: {
                request_id: requestId,
                trace_id: traceId,
                validation: response.validation,
                artifacts: {
                  request: requestArtifact,
                  trace: traceArtifact,
                  response: responseArtifact,
                },
              },
            });
          }
          return sendJson(res, 200, {
            ...response,
            request_id: requestId,
            session_id: sessionId,
            trace_id: traceId,
            session_ref: sessionRef,
            artifacts: {
              request: requestArtifact,
              trace: traceArtifact,
              response: responseArtifact,
            },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorArtifact = params.artifactStore?.writeJson(
            "kce_error",
            {
              request_id: requestId,
              session_id: sessionId,
              trace_id: traceId,
              error: errorMessage,
            },
            previewChars,
          );
          if (params.sessionStore) {
            params.sessionStore.append(sessionId, {
              timestamp: new Date().toISOString(),
              role: "tool",
              type: "tool",
              name: "kce_compute_error",
              output: {
                request_id: requestId,
                trace_id: traceId,
                error: errorMessage,
                artifact: errorArtifact,
              },
            });
          }
          if (error instanceof KceExecutionFailure) {
            return sendJson(res, error.status, {
              ...kgmErrorBody(error.code, error.message, error.status),
              request_id: requestId,
              trace_id: traceId,
              failed_step: error.step,
            });
          }
          throw error;
        }
      }

      return sendJson(res, 404, { error: "not_found" });
      }); // runWithOpsAuthAsync
    } catch (error) {
      if (error instanceof KgmJsonParseError) {
        return sendJson(res, error.status, kgmErrorBody(error.code, error.message, error.status));
      }
      if (error instanceof KgmRequestValidationError) {
        return sendJson(res, error.status, kgmErrorBody(error.code, error.message, error.status));
      }
      if (error instanceof SandboxConfigurationError) {
        return sendJson(res, error.status, kgmErrorBody(error.code, error.message, error.status));
      }
      if (!res.headersSent) {
        const hostErr = toHostKgmError(error);
        return sendJson(res, hostErr.status, hostErr.body);
      }
    }
  };
}

export function createKgmServer(params: KgmServerParams): http.Server {
  const server = http.createServer(createKgmRequestListener(params));
  setupGracefulShutdown(server);
  logger.info("Server created successfully");
  return server;
}

async function sendSse(
  res: ServerResponse,
  events: AsyncIterable<string> | Iterable<string>,
  options?: { appendDone?: boolean; timeoutMs?: number; streamSource?: string },
): Promise<void> {
  if (res.headersSent) {
    console.warn("Attempted to send SSE response after headers were already sent");
    return;
  }

  const abortController = new AbortController();
  const timeoutMsValue = options?.timeoutMs ?? parseInt(process.env.KGM_STREAM_TIMEOUT_MS || "300000", 10);
  const timeoutMs = Number.isNaN(timeoutMsValue) ? 300000 : timeoutMsValue;
  const idleMs = parseStreamIdleMs();
  const appendDone = options?.appendDone !== false;

  const timeoutId = setTimeout(() => {
    abortController.abort(new Error("Stream timeout"));
  }, timeoutMs);

  let lastActivity = Date.now();
  const idleTimer =
    idleMs > 0
      ? setInterval(() => {
          if (Date.now() - lastActivity > idleMs) {
            abortController.abort(new Error("Stream idle timeout"));
          }
        }, Math.min(idleMs, 5000))
      : undefined;

  const onClose = () => {
    abortController.abort(new Error("Client disconnected"));
  };
  res.on("close", onClose);

  let headersOpened = false;
  const openHeaders = () => {
    if (headersOpened || res.headersSent) {
      headersOpened = true;
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...(options?.streamSource ? { "x-kgm-stream-source": options.streamSource } : {}),
    });
    headersOpened = true;
  };

  try {
    for await (const event of events) {
      if (abortController.signal.aborted) {
        const reason = abortController.signal.reason;
        const message =
          reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "aborted";
        if (message === "Client disconnected") {
          break;
        }
        openHeaders();
        writeSseStructuredError(res, toKgmStructuredError(new Error(message)), { appendDone });
        break;
      }
      openHeaders();
      lastActivity = Date.now();
      res.write(`data: ${event}\n\n`);
    }
    if (
      headersOpened &&
      appendDone &&
      !abortController.signal.aborted &&
      !res.destroyed &&
      !res.writableEnded
    ) {
      res.write("data: [DONE]\n\n");
    }
  } catch (error) {
    const isClientGone =
      (error instanceof Error && error.message === "Client disconnected") ||
      (abortController.signal.aborted &&
        abortController.signal.reason instanceof Error &&
        abortController.signal.reason.message === "Client disconnected");
    if (!isClientGone) {
      if (!headersOpened && !res.headersSent) {
        // 首帧前失败：交由外层写成与同步路径一致的 JSON 502/503（不在此记 SSE error）
        throw error;
      }
      logger.error({ err: error }, "SSE stream mid-flight error");
      openHeaders();
      writeSseStructuredError(res, error, { appendDone });
    }
  } finally {    clearTimeout(timeoutId);
    if (idleTimer) clearInterval(idleTimer);
    res.off("close", onClose);
    if (!res.destroyed && (headersOpened || res.headersSent)) {
      res.end();
    }
  }
}

/** 接受 `x-api-key` 或 `Authorization: Bearer`（与 Anthropic SDK 对齐）；当前不强制校验，供网关或后续中间件使用。 */
function readAnthropicApiKey(req: IncomingMessage): string | undefined {
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) {
    return x.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return undefined;
}

/** @deprecated Prefer sendNormalizedUpstreamSse */
async function relayUpstreamSse(res: ServerResponse, upstream: Response): Promise<void> {
  return relayUpstreamSseNormalized(res, upstream);
}

async function readRawHttpBody(req: IncomingMessage): Promise<Buffer> {
  const maxBytes = getKgmHttpMaxBodyBytes();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new KgmRequestValidationError(
        "request_too_large",
        `Request body too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))}MB`,
        413,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendMediaProxyResult(res: ServerResponse, result: MediaProxyResult): void {
  if (!result.ok) {
    const canonical = toCanonicalMediaProxyFailure(result.status, result.body);
    sendJson(res, canonical.status, canonical.body);
    return;
  }
  if (result.binary) {
    if (res.headersSent) return;
    res.writeHead(result.status, {
      "content-type": result.contentType || "application/octet-stream",
      "content-length": result.binary.length,
    });
    res.end(result.binary);
    return;
  }
  sendJson(res, result.status, result.json ?? {});
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function validateKceComputePayload(payload: unknown): KceComputeRequest {
  if (!isRecord(payload)) {
    throw new KgmRequestValidationError("invalid_kce_request", "KCE request body must be an object");
  }
  const userId = typeof payload.userId === "string" ? payload.userId.trim() : "";
  const input = typeof payload.input === "string" ? payload.input.trim() : "";
  if (!userId) {
    throw new KgmRequestValidationError("user_id_required", "KCE request must include non-empty userId");
  }
  if (!input) {
    throw new KgmRequestValidationError("input_required", "KCE request must include non-empty input");
  }
  if (payload.kce !== undefined) {
    if (!isRecord(payload.kce)) {
      throw new KgmRequestValidationError("invalid_kce_options", "kce must be an object");
    }
    if (payload.kce.mode !== undefined && !["fast", "balanced", "quality"].includes(String(payload.kce.mode))) {
      throw new KgmRequestValidationError("invalid_kce_mode", "kce.mode must be one of fast, balanced, quality");
    }
    if (payload.kce.llm !== undefined && !isRecord(payload.kce.llm)) {
      throw new KgmRequestValidationError("invalid_kce_llm", "kce.llm must be an object");
    }
    if (payload.kce.llm && payload.kce.llm.enabled !== undefined && typeof payload.kce.llm.enabled !== "boolean") {
      throw new KgmRequestValidationError("invalid_kce_llm_enabled", "kce.llm.enabled must be a boolean");
    }
    validateIntegerRange(payload.kce.graphLimit, "kce.graphLimit", 1, 32);
    validateIntegerRange(payload.kce.memoryTopK, "kce.memoryTopK", 0, 16);
    validateIntegerRange(payload.kce.maxParallel, "kce.maxParallel", 1, 8);
  }
  if (payload.kgm?.graph?.triples !== undefined) {
    if (!Array.isArray(payload.kgm.graph.triples)) {
      throw new KgmRequestValidationError("invalid_graph_triples", "kgm.graph.triples must be an array");
    }
    for (const triple of payload.kgm.graph.triples) {
      if (
        !isRecord(triple) ||
        typeof triple.subject !== "string" ||
        typeof triple.predicate !== "string" ||
        typeof triple.object !== "string" ||
        !triple.subject.trim() ||
        !triple.predicate.trim() ||
        !triple.object.trim()
      ) {
        throw new KgmRequestValidationError(
          "invalid_graph_triple_item",
          "Each kgm.graph.triples item must include non-empty subject, predicate, and object",
        );
      }
    }
  }
  return payload as KceComputeRequest;
}

function validateIntegerRange(value: unknown, field: string, min: number, max: number): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new KgmRequestValidationError(
      "invalid_numeric_range",
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
}

function requireGraphNamespace(value: unknown): string {
  if (!isRecord(value)) {
    throw new KgmRequestValidationError("graph_namespace_required", "Graph request must include userId or namespace");
  }
  const namespace =
    typeof value.namespace === "string" && value.namespace.trim()
      ? value.namespace.trim()
      : typeof value.userId === "string" && value.userId.trim()
        ? value.userId.trim()
        : "";
  if (!namespace) {
    throw new KgmRequestValidationError("graph_namespace_required", "Graph request must include userId or namespace");
  }
  return namespace;
}

function readTraceId(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const traceId = metadata.traceId;
  return typeof traceId === "string" && traceId.trim() ? traceId.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
