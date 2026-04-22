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
  const modelManager = params.modelManager ?? new ManagedModelManager();
  const routingHistory = createRoutingHistoryStoreFromEnv();
  const responseStore = new OpenAiResponseStore();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        return sendText(res, 200, modelManager.getPrometheusMetrics());
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
        const payload = (await readJson(req)) as {
          userId: string;
          query: string;
          topK?: number;
        };
        const topK = Math.max(1, Math.min(payload.topK ?? 5, 50));
        const evidence = await params.memoryStore.search(payload.userId, payload.query, params.embedder, topK);
        return sendJson(res, 200, { evidence });
      }

      if (req.method === "POST" && url.pathname === "/v1/kgm/graph/triples") {
        const payload = (await readJson(req)) as {
          triples?: Array<{ subject: string; predicate: string; object: string; weight?: number }>;
          source?: string;
        };
        const triples = payload.triples ?? [];
        const stored = await params.graphStore.addTriples({
          triples,
          source: payload.source ?? "api",
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

      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      return sendJson(res, 500, { error: String(error) });
    }
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
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
