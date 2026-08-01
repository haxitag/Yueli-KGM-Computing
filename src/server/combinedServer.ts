import express from 'express';
import http from 'node:http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_SCHEMA_IDS } from '../core/config.js';
import type { KgmRequest, KgmRetrievalOptions } from '../core/types.js';
import type { ConfigStore, KgmConfigPatch } from '../core/configStore.js';
import { toPublicKgmConfig } from '../core/publicConfig.js';
import type { ContextBuilder } from '../context/contextBuilder.js';
import { Scheduler } from '../scheduler/fsm.js';
import type { LlmClient } from '../llm/client.js';
import type { AutoRoutingLlmClient } from '../llm/autoRoutingClient.js';
import { buildOpenAiModelList, createOpenAiChatCompletion, type OpenAiChatCompletionRequest } from '../openai/compat.js';
import { OpenAiResponseStore } from '../openai/responseStore.js';
import { SchemaRegistry } from '../schema/registry.js';
import type { SkillRuntime } from '../skills/runtime.js';
import { ToolRegistry } from '../tools/registry.js';
import { memorySearchOptionsFromKgm } from "../memory/retrievalOptions.js";
import type { MemoryStore } from '../memory/store.js';
import type { GraphStore, GraphRule } from "../graph/store.js";
import { getKgmOpenApiV1 } from "../openapi/kgmOpenApiV1Spec.js";
import { embedImageRemote } from "../multimodal/remoteImageEmbedder.js";
import { kgmErrorBody, KgmJsonParseError } from "../utils/kgmHttpErrors.js";
import { readKgmHttpJsonBody as readJson, sendKgmHttpJson as sendJson } from "./httpJsonHelpers.js";
import { createExpressKgmAccessMiddleware } from "./expressKgmAccess.js";
import type { Embedder } from '../embedding/canonical.js';
import { configurePlaygroundApi, playgroundRouter } from './playgroundApi.js';
import { createPlaygroundSpaFallbackMiddleware } from './playgroundSpaFallback.js';
import { syncPlaygroundFromConfig } from '../playground/syncPlayground.js';
import type { SandboxManager } from '../sandbox/manager.js';
import {
  applyRoutingPatch,
  buildRollbackEntry,
  buildUpdateEntry,
  createRoutingHistoryStoreFromEnv,
  parseRoutingUpdatePayload,
} from '../routing/routingService.js';
import { createExpressCorsOptions } from "./corsPolicy.js";
import { buildControlPlaneStatus } from "./controlPlaneStatus.js";

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createCombinedServer(params: {
  scheduler: Scheduler;
  contextBuilder: ContextBuilder;
  llmClient: LlmClient;
  schemaRegistry: SchemaRegistry;
  toolRegistry: ToolRegistry;
  memoryStore: MemoryStore;
  embedder: Embedder;
  configStore: ConfigStore;
  autoRoutingClient?: AutoRoutingLlmClient;
  skillRuntime?: SkillRuntime;
  /** 缺省则图谱相关新路由返回 501 */
  graphStore?: GraphStore;
  sandboxManager?: SandboxManager;
}, port: number = 3000) {
  const app = express();
  const server = http.createServer(app);
  const routingHistory = createRoutingHistoryStoreFromEnv();
  const responseStore = new OpenAiResponseStore();

  // 中间件（CORS 与主服务同源策略）
  app.use(cors(createExpressCorsOptions()));
  app.use(express.json({ limit: '50mb' }));
  app.use(createExpressKgmAccessMiddleware());
  app.use(express.urlencoded({ extended: true }));

  // 静态文件服务
  app.use('/', express.static(path.join(__dirname, '../../playground')));
  app.use('/generated-images', express.static(path.join(__dirname, '../../data/generated-images')));
  app.use('/generated-videos', express.static(path.join(__dirname, '../../data/generated-videos')));
  app.use('/generated-audio', express.static(path.join(__dirname, '../../data/generated-audio')));

  // API路由 - Playground（与 /v1 共用 AutoRouting llmClient）
  configurePlaygroundApi({ llmClient: params.llmClient });
  app.use('/api/kgm', playgroundRouter);

  // /dynamic 等误开路径 → Playground；浏览器 HTML 导航避免落到 JSON 404
  app.use(createPlaygroundSpaFallbackMiddleware());

  // 用 Express 兜底桥接原生 HTTP API，避免与内置 request listener 重复响应。
  app.use(async (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/v1/openapi.json")) {
        return sendJson(res, 200, getKgmOpenApiV1());
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, buildOpenAiModelList(params.configStore));
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = (await readJson(req)) as OpenAiChatCompletionRequest;
        if (payload.stream) {
          return sendJson(res, 400, {
            error: "stream_not_supported",
            message: "Streaming is not implemented for the OpenAI-compatible bridge.",
          });
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
        const payload = await readJson(req);
        if (typeof payload === 'object' && payload !== null) {
          const typed = payload as KgmConfigPatch & { routingNote?: string };
          let routingEntry: ReturnType<typeof buildUpdateEntry> | null = null;
          if (typed.routing) {
            const nextRouting = applyRoutingPatch(params.configStore.get().routing, typed.routing);
            typed.routing = nextRouting;
            routingEntry = buildUpdateEntry(nextRouting, typed.routingNote);
          }
          const updated = params.configStore.update(typed as KgmConfigPatch);
          if (typed.sandboxAdapters) {
            params.sandboxManager?.reloadAdapters();
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
        } else {
          return sendJson(res, 400, { error: "invalid_payload" });
        }
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

      if (req.method === "GET" && url.pathname.startsWith("/v1/kgm/schemas/")) {
        const schemaId = url.pathname.replace("/v1/kgm/schemas/", "");
        const record = params.schemaRegistry.get(schemaId);
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
          const record = params.schemaRegistry.register(typedPayload);
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
          const embedding = await params.embedder.embed(typedPayload.text);
          const now = new Date().toISOString();
          await params.memoryStore.add({
            id: `mem_${Date.now()}`,
            userId: typedPayload.userId,
            text: typedPayload.text,
            embedding,
            embeddingVersion: params.configStore.get().embedding.version,
            source: typedPayload.source,
            createdAt: now,
            lastAccessedAt: now,
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
          const evidence = await params.memoryStore.search(typedPayload.userId, typedPayload.query, params.embedder, topK, memOpts);
          return sendJson(res, 200, { evidence });
        }
        return sendJson(res, 400, { error: "invalid_payload" });
      }

      const graph = params.graphStore;
      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/communities") {
        if (!graph?.connectedCommunities) {
          return sendJson(
            res,
            501,
            kgmErrorBody("graph_communities_unavailable", "graphStore not provided or unsupported", 501),
          );
        }
        const payload = (await readJson(req)) as { userId?: string; namespace?: string };
        const namespace = readGraphNamespace(payload);
        if (!namespace) {
          return sendJson(res, 400, kgmErrorBody("graph_namespace_required", "userId or namespace required", 400));
        }
        return sendJson(res, 200, await graph.connectedCommunities({ namespace }));
      }
      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/reason/expand") {
        if (!graph?.reasonExpand) {
          return sendJson(res, 501, kgmErrorBody("graph_expand_unavailable", "graphStore not provided", 501));
        }
        const b = (await readJson(req)) as {
          entity?: string;
          maxDepth?: number;
          relations?: string[];
          userId?: string;
          namespace?: string;
        };
        if (!b.entity?.trim()) {
          return sendJson(res, 400, kgmErrorBody("entity_required", "entity is required", 400));
        }
        const namespace = readGraphNamespace(b);
        if (!namespace) {
          return sendJson(res, 400, kgmErrorBody("graph_namespace_required", "userId or namespace required", 400));
        }
        return sendJson(
          res,
          200,
          {
            result: await graph.reasonExpand({
              entity: b.entity.trim(),
              maxDepth: b.maxDepth ?? 2,
              relations: b.relations,
              namespace,
            }),
          },
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/reason/rules") {
        if (!graph?.applyRules) {
          return sendJson(res, 501, kgmErrorBody("graph_rules_unavailable", "graphStore not provided", 501));
        }
        const b = (await readJson(req)) as {
          rules?: GraphRule[];
          maxRounds?: number;
          source?: string;
          userId?: string;
          namespace?: string;
        };
        const maxR = Math.max(1, Math.min(20, b.maxRounds ?? 5));
        const namespace = readGraphNamespace(b);
        if (!namespace) {
          return sendJson(res, 400, kgmErrorBody("graph_namespace_required", "userId or namespace required", 400));
        }
        const added = await graph.applyRules({
          rules: b.rules ?? [],
          maxRounds: maxR,
          source: b.source,
          namespace,
        });
        return sendJson(res, 200, { added, count: added.length });
      }
      if (req.method === "POST" && url.pathname === "/v1/kgm/multimodal/embed") {
        const b = (await readJson(req)) as { imageBase64?: string; mimeType?: string; text?: string; model?: string };
        if (!b.imageBase64) {
          return sendJson(res, 400, kgmErrorBody("image_required", "imageBase64 is required", 400));
        }
        const embedding = await embedImageRemote({ request: { imageBase64: b.imageBase64, mimeType: b.mimeType, text: b.text, model: b.model } });
        return sendJson(res, 200, { embedding, dim: embedding.length });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/execute") {
        const payload = await readJson(req);
        if (typeof payload === 'object' && payload !== null) {
          const response = await params.scheduler.run(payload as KgmRequest);
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

  // 启动服务器
  server.listen(port, () => {
    console.log(`KGM-Computing server running on http://localhost:${port}`);
    console.log(`Playground UI available at http://localhost:${port}`);
  });

  return server;
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function readGraphNamespace(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const payload = value as Record<string, unknown>;
  return typeof payload.namespace === "string" && payload.namespace.trim()
    ? payload.namespace.trim()
    : typeof payload.userId === "string" && payload.userId.trim()
      ? payload.userId.trim()
      : undefined;
}

// 如果直接运行此文件，则启动服务器
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("Combined server needs to be initialized with proper dependencies.");
  console.log("Please use src/server/start.ts to start the full server.");
}
