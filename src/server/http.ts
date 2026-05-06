import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KgmRequest } from "../core/types.js";
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
import { SandboxManager } from "../sandbox/manager.js";
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
  const kceEngine = new KceEngine({
    contextBuilder: params.contextBuilder,
    graphStore: params.graphStore,
    memoryStore: params.memoryStore,
    embedder: params.embedder,
    llmClient: params.llmClient,
  });

  const server = http.createServer(async (req, res) => {
    try {
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

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, buildOpenAiModelList(params.configStore, modelManager));
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
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
        await params.memoryStore.add({
          id: `mem_${Date.now()}`,
          userId: payload.userId,
          text: payload.text,
          embedding,
          embeddingVersion: params.configStore.get().embedding.version,
          source: payload.source,
          createdAt: new Date().toISOString(),
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
      if (!res.headersSent) {
        return sendJson(
          res,
          500,
          kgmErrorBody("internal_error", error instanceof Error ? error.message : String(error), 500),
        );
      }
    }
  });

  // Setup graceful shutdown
  setupGracefulShutdown(server);

  logger.info('Server created successfully');
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
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
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendSse(
  res: ServerResponse,
  events: AsyncIterable<string> | Iterable<string>,
  options?: { appendDone?: boolean },
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  for await (const event of events) {
    res.write(`data: ${event}\n\n`);
  }
  if (options?.appendDone !== false) {
    res.write("data: [DONE]\n\n");
  }
  res.end();
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
