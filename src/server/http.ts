import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KgmRequest, SkillDefinition, ToolDefinition } from "../core/types.js";
import { DEFAULT_SCHEMA_IDS } from "../core/config.js";
import type { ConfigStore, KgmConfigPatch } from "../core/configStore.js";
import { syncPlaygroundFromConfig } from "../playground/syncPlayground.js";
import type { ContextBuilder } from "../context/contextBuilder.js";
import type { GraphStore } from "../graph/store.js";
import { Scheduler } from "../scheduler/fsm.js";
import type { LlmClient } from "../llm/client.js";
import {
  createAnthropicMessagesResponse,
  streamAnthropicMessagesJsonLines,
  type AnthropicMessagesRequest,
} from "../anthropic/compat.js";
import {
  buildOpenAiModelList,
  createOpenAiChatCompletion,
  createOpenAiResponse,
  streamOpenAiChatCompletion,
  streamOpenAiResponse,
  type OpenAiChatCompletionRequest,
  type OpenAiResponsesRequest,
} from "../openai/compat.js";
import { maybeProxyNativeOpenAiStream } from "../openai/passthrough.js";
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
import { createHttpAccessConfigFromEnv, HttpRequestAccess } from "./httpAccess.js";
import { kgmErrorBody, KgmJsonParseError } from "../utils/kgmHttpErrors.js";
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
import { InferenceDiscoveryService } from "../runtime/discoveryService.js";
import { handleRuntimeRoute } from "./routes/runtime.js";
import { buildEffectiveModels, buildRawModels } from "../models/modelTypeAnnotator.js";
import { structuredErrorBody, toKgmStructuredError } from "../errors/structuredError.js";

export function createKgmServer(params: {
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
}): http.Server {
  // Validate environment variables on startup
  const env = validateEnv();
  logger.info({ env: { NODE_ENV: env.NODE_ENV, PORT: env.PORT } }, 'Environment validated');

  const modelManager = params.modelManager ?? new ManagedModelManager();
  const routingHistory = createRoutingHistoryStoreFromEnv();
  const responseStore = new OpenAiResponseStore();
  const access = new HttpRequestAccess(createHttpAccessConfigFromEnv());
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
      if (this.tasks[id] && this.tasks[id].status === "queued") {
        this.tasks[id].status = "cancelled";
        this.tasks[id].completedAt = new Date().toISOString();
        return true;
      }
      return false;
    },
  };

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

  // CORS配置
  const corsOrigins = process.env.KGM_CORS_ORIGINS ? process.env.KGM_CORS_ORIGINS.split(",") : ["*"];
  const corsMethods = process.env.KGM_CORS_METHODS || "GET,POST,PUT,DELETE,OPTIONS,PATCH";
  const corsHeaders = process.env.KGM_CORS_HEADERS || "Content-Type,Authorization,X-API-Key,X-KGM-Error";
  const corsMaxAge = process.env.KGM_CORS_MAX_AGE || "86400"; // 24小时
  const hasWildcardOrigin = corsOrigins.includes("*");

  function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    
    // 设置CORS头部
    if (origin) {
      const allowedOrigin = hasWildcardOrigin ? "*" : 
        corsOrigins.includes(origin) ? origin : corsOrigins[0];
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    } else if (hasWildcardOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    
    res.setHeader("Access-Control-Allow-Methods", corsMethods);
    res.setHeader("Access-Control-Allow-Headers", corsHeaders);
    res.setHeader("Access-Control-Max-Age", corsMaxAge);
    
    // 只有在不是通配符源时才允许携带凭证
    if (!hasWildcardOrigin) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    
    // 处理OPTIONS预检请求
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    
    return false;
  }

  const server = http.createServer(async (req, res) => {
    try {
      // 处理CORS
      if (handleCors(req, res)) {
        return;
      }
      
      const url = new URL(req.url ?? "", "http://localhost");
      if (!access.check(req, res, url.pathname)) {
        return;
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
        };
        return sendJson(res, 200, health);
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

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, buildOpenAiModelList(params.configStore, modelManager));
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

      if (req.method === "POST" && url.pathname === "/v1/embeddings") {
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
        };

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
          metadata: { agentId, tools: agent.tools, mode: agent.systemPrompt ? "reasoning" : "chat" },
        };

        const response = await params.scheduler.run(kgmRequest);
        return sendJson(res, 200, response);
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
        return sendJson(res, 200, {
          logs: [],
          limit,
          type,
          total: 0,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/admin/config") {
        return sendJson(res, 200, params.configStore.get());
      }

      if (req.method === "GET" && url.pathname === "/v1/admin/versions") {
        return sendJson(res, 200, {
          version: process.env.npm_package_version || "0.2.1",
          nodeVersion: process.version,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/admin/reload") {
        return sendJson(res, 200, { status: "ok", message: "Config reloaded" });
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/v1/memory/")) {
        const id = url.pathname.replace("/v1/memory/", "");
        // MemoryStore doesn't support delete, just return ok
        return sendJson(res, 200, { deleted: false });
      }

      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/completions")) {
        const payload = (await readJson(req)) as OpenAiChatCompletionRequest;
        if (payload.stream) {
          const proxied = await maybeProxyNativeOpenAiStream({
            configStore: params.configStore,
            modelManager,
            protocol: "chat",
            payload,
            send: (upstream) => relayUpstreamSse(res, upstream),
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
          });
          return sendSse(res, events);
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
        });
        return sendJson(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const payload = (await readJson(req)) as OpenAiResponsesRequest;
        if (payload.stream) {
          const proxied = await maybeProxyNativeOpenAiStream({
            configStore: params.configStore,
            modelManager,
            protocol: "responses",
            payload,
            send: (upstream) => relayUpstreamSse(res, upstream),
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
          });
          return sendSse(res, events);
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
        });
        return sendJson(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        void readAnthropicApiKey(req);
        const payload = (await readJson(req)) as AnthropicMessagesRequest;
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
          return sendSse(res, events, { appendDone: false });
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
        return sendJson(res, 200, params.configStore.get());
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
        return sendJson(res, 200, updated);
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

      if (req.method === "POST" && url.pathname === "/v1/kgm/memory") {
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

      if (req.method === "POST" && url.pathname === "/v1/kgm/memory/search") {
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
          runtime: "native" | "llama.cpp" | "ollama" | "vllm" | "sglang" | "mlx" | "openai-compatible";
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
        };
        const runtime = modelManager.createRuntime(payload);
        return sendJson(res, 200, { runtime });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/models/runtimes/")) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/(start|stop)$/, "");
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

      if (req.method === "GET" && url.pathname === "/v1/kgm/sandboxes") {
        return sendJson(res, 200, { sandboxes: params.sandboxManager.list() });
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
        const traceId = readTraceId(payload.metadata) ?? generateId("trace");
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
        const structured = toKgmStructuredError(error);
        return sendJson(
          res,
          structured.status,
          structuredErrorBody(structured),
        );
      }
    }
  });

  // Setup graceful shutdown
  setupGracefulShutdown(server);

  logger.info('Server created successfully');
  return server;
}

// 默认请求体大小限制为 5MB，可通过环境变量 KGM_HTTP_MAX_BODY_SIZE_MB 配置
const DEFAULT_MAX_BODY_SIZE = 5 * 1024 * 1024; 
const MAX_BODY_SIZE = (() => {
  const envMb = process.env.KGM_HTTP_MAX_BODY_SIZE_MB;
  if (envMb) {
    const mb = Number(envMb);
    if (!isNaN(mb) && mb > 0) {
      return mb * 1024 * 1024;
    }
  }
  return DEFAULT_MAX_BODY_SIZE;
})();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    totalSize += buffer.length;
    
    // 检查是否超过大小限制
    if (totalSize > MAX_BODY_SIZE) {
      throw new KgmRequestValidationError(
        "request_too_large",
        `Request body too large. Maximum size is ${Math.round(MAX_BODY_SIZE / (1024 * 1024))}MB`,
        413
      );
    }
    
    chunks.push(buffer);
  }
  
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new KgmJsonParseError();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    console.warn("Attempted to send JSON response after headers were already sent");
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  if (res.headersSent) {
    console.warn("Attempted to send text response after headers were already sent");
    return;
  }
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendSse(
  res: ServerResponse,
  events: AsyncIterable<string> | Iterable<string>,
  options?: { appendDone?: boolean; timeoutMs?: number },
): Promise<void> {
  if (res.headersSent) {
    console.warn("Attempted to send SSE response after headers were already sent");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const abortController = new AbortController();
  const timeoutMsValue = options?.timeoutMs ?? parseInt(process.env.KGM_STREAM_TIMEOUT_MS || "300000", 10); // 默认5分钟
  const timeoutMs = isNaN(timeoutMsValue) ? 300000 : timeoutMsValue;

  // 设置超时
  const timeoutId = setTimeout(() => {
    abortController.abort(new Error("Stream timeout"));
  }, timeoutMs);

  // 监听客户端断开连接
  const onClose = () => {
    abortController.abort(new Error("Client disconnected"));
  };
  res.on("close", onClose);

  try {
    for await (const event of events) {
      if (abortController.signal.aborted) {
        break;
      }
      res.write(`data: ${event}\n\n`);
    }
    if (options?.appendDone !== false && !abortController.signal.aborted) {
      res.write("data: [DONE]\n\n");
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Client disconnected") {
      console.error("SSE stream error:", error);
    }
  } finally {
    clearTimeout(timeoutId);
    res.off("close", onClose);
    if (!res.destroyed) {
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

async function relayUpstreamSse(res: ServerResponse, upstream: Response): Promise<void> {
  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    res.write(Buffer.from(value));
  }
  res.end();
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

class KgmRequestValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "KgmRequestValidationError";
    this.code = code;
    this.status = status;
  }
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
