import express from 'express';
import http from 'node:http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ServerResponse } from 'node:http';
import { 
  ConfigStore,
  HashEmbedder,
  MockLlmClient,
  createRuntime,
  createRuntimeWithStorage,
} from "../index.js";
import { DEFAULT_SCHEMA_IDS } from "../core/config.js";
import { playgroundRouter } from './playgroundApi.js';
import type { KgmConfigPatch } from "../core/configStore.js";
import { syncPlaygroundFromConfig } from "../playground/syncPlayground.js";
import type { KgmRequest, KgmRetrievalOptions } from "../core/types.js";
import type { GraphRule } from "../graph/store.js";
import { getKgmOpenApiV1 } from "../openapi/kgmOpenApiV1Spec.js";
import { embedImageRemote } from "../multimodal/remoteImageEmbedder.js";
import { kgmErrorBody, KgmJsonParseError } from "../utils/kgmHttpErrors.js";
import { createExpressKgmAccessMiddleware } from "./expressKgmAccess.js";
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
import type { Scheduler } from "../scheduler/fsm.js";
import type { SchemaRegistry } from "../schema/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import { memorySearchOptionsFromKgm } from "../memory/retrievalOptions.js";
import type { MemoryStore } from "../memory/store.js";
import type { Embedder } from "../embedding/canonical.js";
import {
  applyRoutingPatch,
  buildRollbackEntry,
  buildUpdateEntry,
  createRoutingHistoryStoreFromEnv,
  parseRoutingUpdatePayload,
} from "../routing/routingService.js";

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const configPath = process.env.KGM_CONFIG_PATH ?? "data/kgm.config.json";
  const configStore = new ConfigStore({
    initial: loadConfigFromEnv(),
    persistPath: configPath,
    loadFromDisk: true,
  });
  const useMock = process.env.KGM_MOCK_MODE === "1";
  const runtime = useMock
    ? createRuntime({
        llmClient: new MockLlmClient(),
        embedder: new HashEmbedder(),
        configStore,
      })
    : await createRuntimeWithStorage({ configStore });

  const routingHistory = createRoutingHistoryStoreFromEnv();
  const responseStore = new OpenAiResponseStore();

  // 创建Express应用
  const app = express();
  const server = http.createServer(app);

  // 中间件
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(createExpressKgmAccessMiddleware());
  app.use(express.urlencoded({ extended: true }));

  // 静态文件服务
  app.use('/', express.static(path.join(__dirname, '../../playground')));
  app.use('/generated-images', express.static(path.join(__dirname, '../../data/generated-images')));
  app.use('/generated-videos', express.static(path.join(__dirname, '../../data/generated-videos')));
  app.use('/generated-audio', express.static(path.join(__dirname, '../../data/generated-audio')));

  // API路由 - Playground
  app.use('/api/kgm', playgroundRouter);

  // 用 Express 兜底桥接原生 HTTP API，避免与内置 request listener 重复响应。
  app.use(async (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        return sendText(res, 200, runtime.modelManager.getPrometheusMetrics());
      }

      if (req.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/v1/openapi.json")) {
        return sendJson(res, 200, getKgmOpenApiV1());
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, buildOpenAiModelList(runtime.configStore, runtime.modelManager));
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = (await readJson(req)) as OpenAiChatCompletionRequest;
        if (payload.stream) {
          const proxied = await maybeProxyNativeOpenAiStream({
            configStore: runtime.configStore,
            modelManager: runtime.modelManager,
            protocol: "chat",
            payload,
            send: (upstream) => relayUpstreamSse(res, upstream),
          });
          if (proxied) {
            return;
          }
          const events = streamOpenAiChatCompletion({
            request: payload,
            contextBuilder: runtime.contextBuilder,
            llmClient: runtime.llmClient,
            toolRegistry: runtime.toolRegistry,
            configStore: runtime.configStore,
            outputSchema: runtime.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
            responseStore,
            skillRuntime: runtime.skillRuntime,
          });
          return sendSse(res, events);
        }
        const response = await createOpenAiChatCompletion({
          request: payload,
          contextBuilder: runtime.contextBuilder,
          llmClient: runtime.llmClient,
          toolRegistry: runtime.toolRegistry,
          configStore: runtime.configStore,
          outputSchema: runtime.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
          responseStore,
          skillRuntime: runtime.skillRuntime,
        });
        return sendJson(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const payload = (await readJson(req)) as OpenAiResponsesRequest;
        if (payload.stream) {
          const proxied = await maybeProxyNativeOpenAiStream({
            configStore: runtime.configStore,
            modelManager: runtime.modelManager,
            protocol: "responses",
            payload,
            send: (upstream) => relayUpstreamSse(res, upstream),
          });
          if (proxied) {
            return;
          }
          const events = streamOpenAiResponse({
            request: payload,
            contextBuilder: runtime.contextBuilder,
            llmClient: runtime.llmClient,
            toolRegistry: runtime.toolRegistry,
            configStore: runtime.configStore,
            outputSchema: runtime.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
            responseStore,
            skillRuntime: runtime.skillRuntime,
          });
          return sendSse(res, events);
        }
        const response = await createOpenAiResponse({
          request: payload,
          contextBuilder: runtime.contextBuilder,
          llmClient: runtime.llmClient,
          toolRegistry: runtime.toolRegistry,
          configStore: runtime.configStore,
          outputSchema: runtime.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {},
          responseStore,
          skillRuntime: runtime.skillRuntime,
        });
        return sendJson(res, 200, response);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/config") {
        return sendJson(res, 200, runtime.configStore.get());
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/auto-routing") {
        return sendJson(res, 200, runtime.configStore.get().autoRouting);
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/auto-routing") {
        const payload = (await readJson(req)) as KgmConfigPatch["autoRouting"];
        const updated = runtime.configStore.update({ autoRouting: payload ?? {} });
        return sendJson(res, 200, updated.autoRouting);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/auto-routing/summary") {
        const limit = parseQueryNumber(url.searchParams.get("limit"));
        return sendJson(res, 200, runtime.autoRoutingClient.getAuditSummary(limit));
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/auto-routing/audit") {
        const limit = parseQueryNumber(url.searchParams.get("limit"));
        return sendJson(res, 200, { items: runtime.autoRoutingClient.listAuditEntries(limit) });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/config") {
        const payload = await readJson(req);
        if (typeof payload === 'object' && payload !== null) {
          const typed = payload as KgmConfigPatch & { routingNote?: string };
          let routingEntry: ReturnType<typeof buildUpdateEntry> | null = null;
          if (typed.routing) {
            const nextRouting = applyRoutingPatch(runtime.configStore.get().routing, typed.routing);
            typed.routing = nextRouting;
            routingEntry = buildUpdateEntry(nextRouting, typed.routingNote);
          }
          const updated = runtime.configStore.update(typed);
          syncPlaygroundFromConfig({
            skillRegistry: runtime.skillRuntime.getSkillRegistry(),
            toolRegistry: runtime.toolRegistry,
            configStore: runtime.configStore,
          });
          if (routingEntry) {
            routingHistory.record(routingEntry);
          }
          return sendJson(res, 200, updated);
        } else {
          return sendJson(res, 400, { error: "invalid_payload" });
        }
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/routing") {
        return sendJson(res, 200, runtime.configStore.get().routing);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/routing/versions") {
        const limit = parseQueryNumber(url.searchParams.get("limit"));
        return sendJson(res, 200, { items: routingHistory.list(limit ?? undefined) });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/routing") {
        const payload = await readJson(req);
        const parsed = parseRoutingUpdatePayload(payload);
        if (!parsed) {
          return sendJson(res, 400, { error: "invalid_payload" });
        }
        const current = runtime.configStore.get().routing;
        const nextRouting = applyRoutingPatch(current, parsed.patch);
        runtime.configStore.update({ routing: nextRouting });
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
        const rollbackFrom = runtime.configStore.get().routing.version;
        runtime.configStore.update({ routing: target.config });
        routingHistory.record(buildRollbackEntry(target.config, rollbackFrom, payload?.note));
        return sendJson(res, 200, target.config);
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/tools") {
        return sendJson(res, 200, { tools: runtime.toolRegistry.listDefinitions() });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/tools/stats") {
        return sendJson(res, 200, runtime.toolRegistry.getCallStats());
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/schemas/")) {
        const schemaId = url.pathname.replace("/v1/kgm/schemas/", "");
        const record = runtime.schemaRegistry.get(schemaId);
        if (!record) {
          return sendJson(res, 404, { error: "schema_not_found" });
        }
        return sendJson(res, 200, record);
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/schemas") {
        const payload = await readJson(req);
        if (typeof payload === 'object' && payload !== null) {
          const typedPayload = payload as {
            schemaId: string;
            version: string;
            status: "draft" | "active" | "deprecated" | "retired";
            schema: Record<string, unknown>;
          };
          const record = runtime.schemaRegistry.register(typedPayload);
          return sendJson(res, 200, record);
        } else {
          return sendJson(res, 400, { error: "invalid_payload" });
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/memory") {
        const payload = await readJson(req);
        if (typeof payload === 'object' && payload !== null) {
          const typedPayload = payload as {
            userId: string;
            text: string;
            source: string;
          };
          const embedding = await runtime.embedder.embed(typedPayload.text);
          await runtime.memoryStore.add({
            id: `mem_${Date.now()}`,
            userId: typedPayload.userId,
            text: typedPayload.text,
            embedding,
            embeddingVersion: runtime.configStore.get().embedding.version,
            source: typedPayload.source,
            createdAt: new Date().toISOString(),
          });
          return sendJson(res, 200, { status: "ok" });
        } else {
          return sendJson(res, 400, { error: "invalid_payload" });
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/memory/search") {
        const payload = await readJson(req);
        if (typeof payload === "object" && payload !== null) {
          const typedPayload = payload as KgmRetrievalOptions & {
            userId: string;
            query: string;
            topK?: number;
          };
          const topK = Math.max(1, Math.min(typedPayload.topK ?? 5, 50));
          const memOpts = memorySearchOptionsFromKgm({
            strategy: typedPayload.strategy,
            lexicalWeight: typedPayload.lexicalWeight,
            overFetch: typedPayload.overFetch,
            rerank: typedPayload.rerank,
            rerankBlend: typedPayload.rerankBlend,
          });
          const evidence = await runtime.memoryStore.search(
            typedPayload.userId,
            typedPayload.query,
            runtime.embedder,
            topK,
            memOpts,
          );
          return sendJson(res, 200, { evidence });
        }
        return sendJson(res, 400, { error: "invalid_payload" });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/shortest_path") {
        const payload = (await readJson(req)) as { from?: string; to?: string; maxHops?: number };
        const from = payload.from?.trim();
        const to = payload.to?.trim();
        if (!from || !to) {
          return sendJson(res, 400, kgmErrorBody("from_to_required", "from and to required", 400));
        }
        if (!runtime.graphStore.shortestPath) {
          return sendJson(res, 501, kgmErrorBody("graph_path_unavailable", "shortestPath not available", 501));
        }
        const result = await runtime.graphStore.shortestPath({ from, to, maxHops: payload.maxHops });
        return sendJson(res, 200, { result });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/communities") {
        if (!runtime.graphStore.connectedCommunities) {
          return sendJson(res, 501, kgmErrorBody("graph_communities_unavailable", "no API", 501));
        }
        return sendJson(res, 200, await runtime.graphStore.connectedCommunities());
      }
      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/reason/expand") {
        if (!runtime.graphStore.reasonExpand) {
          return sendJson(res, 501, kgmErrorBody("graph_expand_unavailable", "no API", 501));
        }
        const b = (await readJson(req)) as { entity?: string; maxDepth?: number; relations?: string[] };
        if (!b.entity?.trim()) {
          return sendJson(res, 400, kgmErrorBody("entity_required", "entity required", 400));
        }
        const result = await runtime.graphStore.reasonExpand({
          entity: b.entity.trim(),
          maxDepth: b.maxDepth ?? 2,
          relations: b.relations,
        });
        return sendJson(res, 200, { result });
      }
      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/reason/rules") {
        if (!runtime.graphStore.applyRules) {
          return sendJson(res, 501, kgmErrorBody("graph_rules_unavailable", "no API", 501));
        }
        const b = (await readJson(req)) as { rules?: GraphRule[]; maxRounds?: number; source?: string };
        const maxR = Math.max(1, Math.min(20, b.maxRounds ?? 5));
        const added = await runtime.graphStore.applyRules({ rules: b.rules ?? [], maxRounds: maxR, source: b.source });
        return sendJson(res, 200, { added, count: added.length });
      }
      if (req.method === "POST" && url.pathname === "/v1/kgm/multimodal/embed") {
        const b = (await readJson(req)) as { imageBase64?: string; mimeType?: string; text?: string; model?: string };
        if (!b.imageBase64) {
          return sendJson(res, 400, kgmErrorBody("image_required", "imageBase64 required", 400));
        }
        const embedding = await embedImageRemote({
          request: { imageBase64: b.imageBase64, mimeType: b.mimeType, text: b.text, model: b.model },
        });
        return sendJson(res, 200, { embedding, dim: embedding.length });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/triples") {
        const payload = (await readJson(req)) as {
          triples?: Array<{ subject: string; predicate: string; object: string; weight?: number }>;
          source?: string;
        };
        const stored = await runtime.graphStore.addTriples({
          triples: payload.triples ?? [],
          source: payload.source ?? "api",
        });
        return sendJson(res, 200, { status: "ok", count: stored.length, triples: stored });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models") {
        return sendJson(res, 200, { models: runtime.modelManager.listModels() });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models/running") {
        return sendJson(res, 200, { models: runtime.modelManager.listRunningModels() });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/models/create") {
        const created = await runtime.modelManager.createModel((await readJson(req)) as Parameters<typeof runtime.modelManager.createModel>[0]);
        return sendJson(res, 200, created);
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/models/") && url.pathname.endsWith("/metrics")) {
        const id = url.pathname.replace("/v1/kgm/models/", "").replace(/\/metrics$/, "");
        const metrics = runtime.modelManager.getRuntimeMetrics(id)
          ?? runtime.modelManager.listModels().find((item) => item.id === id || item.modelName === id)?.metrics;
        if (!metrics) {
          return sendJson(res, 404, { error: "model_metrics_not_found" });
        }
        return sendJson(res, 200, { metrics });
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/v1/kgm/models/")) {
        const id = url.pathname.replace("/v1/kgm/models/", "");
        return sendJson(res, 200, runtime.modelManager.deleteManagedEntity(id));
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models/artifacts") {
        return sendJson(res, 200, { artifacts: runtime.modelManager.listArtifacts() });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/models/pull") {
        const artifact = await runtime.modelManager.pull((await readJson(req)) as {
          name?: string;
          modelName?: string;
          sourceType?: "huggingface" | "ollama" | "github" | "modelscope" | "direct" | "local";
          sourceUrl?: string;
          sourceRef?: string;
          filePath?: string;
          revision?: string;
          authToken?: string;
        });
        return sendJson(res, 200, { artifact });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/models/artifacts/")) {
        const id = url.pathname.replace("/v1/kgm/models/artifacts/", "");
        const artifact = runtime.modelManager.getArtifact(id);
        if (!artifact) {
          return sendJson(res, 404, { error: "artifact_not_found" });
        }
        return sendJson(res, 200, { artifact });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/models/runtimes") {
        return sendJson(res, 200, { runtimes: runtime.modelManager.listRuntimes() });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/models/runtimes") {
        const instance = runtime.modelManager.createRuntime((await readJson(req)) as {
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
        });
        return sendJson(res, 200, { runtime: instance });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/models/runtimes/")) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/(start|stop)$/, "");
        const instance = runtime.modelManager.getRuntime(id);
        if (!instance) {
          return sendJson(res, 404, { error: "runtime_not_found" });
        }
        return sendJson(res, 200, { runtime: instance });
      }

      if (req.method === "POST" && url.pathname.endsWith("/start") && url.pathname.startsWith("/v1/kgm/models/runtimes/")) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/start$/, "");
        return sendJson(res, 200, { runtime: await runtime.modelManager.startRuntime(id) });
      }

      if (req.method === "POST" && url.pathname.endsWith("/stop") && url.pathname.startsWith("/v1/kgm/models/runtimes/")) {
        const id = url.pathname.replace("/v1/kgm/models/runtimes/", "").replace(/\/stop$/, "");
        return sendJson(res, 200, { runtime: runtime.modelManager.stopRuntime(id) });
      }

      if (req.method === "GET" && url.pathname === "/v1/kgm/sandboxes") {
        return sendJson(res, 200, { sandboxes: runtime.sandboxManager.list() });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/sandboxes") {
        const payload = (await readJson(req)) as { kind?: "computer" | "browser" | "mobile"; name?: string; notes?: string[] };
        const sandbox = runtime.sandboxManager.create({
          kind: payload.kind ?? "computer",
          name: payload.name,
          notes: payload.notes,
        });
        return sendJson(res, 200, { sandbox });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/sandboxes/")) {
        const id = url.pathname.replace("/v1/kgm/sandboxes/", "").replace(/\/(start|stop)$/, "");
        const sandbox = runtime.sandboxManager.get(id);
        if (!sandbox) {
          return sendJson(res, 404, { error: "sandbox_not_found" });
        }
        return sendJson(res, 200, { sandbox });
      }

      if (req.method === "POST" && url.pathname.endsWith("/start") && url.pathname.startsWith("/v1/kgm/sandboxes/")) {
        const id = url.pathname.replace("/v1/kgm/sandboxes/", "").replace(/\/start$/, "");
        return sendJson(res, 200, { sandbox: runtime.sandboxManager.start(id) });
      }

      if (req.method === "POST" && url.pathname.endsWith("/stop") && url.pathname.startsWith("/v1/kgm/sandboxes/")) {
        const id = url.pathname.replace("/v1/kgm/sandboxes/", "").replace(/\/stop$/, "");
        return sendJson(res, 200, { sandbox: runtime.sandboxManager.stop(id) });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/artifacts/")) {
        const id = url.pathname.replace("/v1/kgm/artifacts/", "");
        try {
          const data = runtime.artifactStore.read(id, {
            offset: parseQueryNumber(url.searchParams.get("offset")),
            limit: parseQueryNumber(url.searchParams.get("limit")),
          });
          return sendJson(res, 200, data);
        } catch (error) {
          return sendJson(res, 404, { error: String(error) });
        }
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/sessions/")) {
        const id = url.pathname.replace("/v1/kgm/sessions/", "");
        try {
          const data = runtime.sessionStore.read(id, {
            offset: parseQueryNumber(url.searchParams.get("offset")),
            limit: parseQueryNumber(url.searchParams.get("limit")),
          });
          return sendJson(res, 200, data);
        } catch (error) {
          return sendJson(res, 404, { error: String(error) });
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/execute") {
        const payload = await readJson(req);
        if (typeof payload === 'object' && payload !== null) {
          const response = await runtime.scheduler.run(payload as KgmRequest);
          return sendJson(res, 200, response);
        } else {
          return sendJson(res, 400, { error: "invalid_payload" });
        }
      }

      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent) {
        return;
      }
      if (error instanceof KgmJsonParseError) {
        return sendJson(res, error.status, kgmErrorBody(error.code, error.message, error.status));
      }
      return sendJson(
        res,
        500,
        kgmErrorBody("internal_error", error instanceof Error ? error.message : String(error), 500),
      );
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`KGM server with Playground listening on ${port}`);
    console.log(`Playground UI available at http://localhost:${port}`);
  });
}

async function readJson(req: http.IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) {
    return req.body;
  }
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
  if (res.headersSent) {
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
    return;
  }
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendSse(res: ServerResponse, events: AsyncIterable<string> | Iterable<string>): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  for await (const event of events) {
    res.write(`data: ${event}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
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
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function parseQueryNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function loadConfigFromEnv(): KgmConfigPatch {
  const embedding = pickDefined({
    baseUrl: process.env.KGM_EMBEDDING_BASE_URL,
    apiKey: process.env.KGM_EMBEDDING_API_KEY,
    model: process.env.KGM_EMBEDDING_MODEL,
    path: process.env.KGM_EMBEDDING_PATH,
    version: process.env.KGM_EMBEDDING_VERSION,
    timeoutMs: parseNumber(process.env.KGM_EMBEDDING_TIMEOUT_MS),
    provider: process.env.KGM_EMBEDDING_PROVIDER as "openai" | "custom" | "ollama" | undefined,
  });

  const llm = pickDefined({
    baseUrl: process.env.KGM_LLM_BASE_URL,
    apiKey: process.env.KGM_LLM_API_KEY,
    model: process.env.KGM_LLM_MODEL,
    path: process.env.KGM_LLM_PATH,
    mode: process.env.KGM_LLM_MODE as "completions" | "chat" | undefined,
    temperature: parseNumber(process.env.KGM_LLM_TEMPERATURE),
    maxTokens: parseNumber(process.env.KGM_LLM_MAX_TOKENS),
    timeoutMs: parseNumber(process.env.KGM_LLM_TIMEOUT_MS),
    provider: process.env.KGM_LLM_PROVIDER as "openai" | "custom" | "ollama" | undefined,
  });

  const database = pickDefined({
    provider: process.env.KGM_DB_PROVIDER as "sqlite" | undefined,
    filePath: process.env.KGM_DB_PATH,
    journalMode: process.env.KGM_DB_JOURNAL as "WAL" | "DELETE" | undefined,
  });

  const vector = pickDefined({
    backend: process.env.KGM_VECTOR_BACKEND as "memory" | "chroma" | undefined,
    baseUrl: process.env.KGM_VECTOR_BASE_URL,
    apiPath: process.env.KGM_VECTOR_API_PATH,
    collection: process.env.KGM_VECTOR_COLLECTION,
    distance: process.env.KGM_VECTOR_DISTANCE as "cosine" | "l2" | undefined,
    timeoutMs: parseNumber(process.env.KGM_VECTOR_TIMEOUT_MS),
  });

  const adapter = pickDefined({
    enabled: parseBool(process.env.KGM_ADAPTER_ENABLED),
    baseUrl: process.env.KGM_ADAPTER_BASE_URL,
    secret: process.env.KGM_ADAPTER_SECRET,
    timeoutMs: parseNumber(process.env.KGM_ADAPTER_TIMEOUT_MS),
    sendPerformance: parseBool(process.env.KGM_ADAPTER_SEND_PERFORMANCE),
    sendContextQuality: parseBool(process.env.KGM_ADAPTER_SEND_CONTEXT_QUALITY),
    performancePath: process.env.KGM_ADAPTER_PERFORMANCE_PATH,
    contextQualityPath: process.env.KGM_ADAPTER_CONTEXT_QUALITY_PATH,
  });

  return {
    embedding: Object.keys(embedding).length ? embedding : undefined,
    llm: Object.keys(llm).length ? llm : undefined,
    database: Object.keys(database).length ? database : undefined,
    vector: Object.keys(vector).length ? vector : undefined,
    adapter: Object.keys(adapter).length ? adapter : undefined,
  };
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

function pickDefined<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== "") {
      result[key] = value;
    }
  }
  return result as T;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
