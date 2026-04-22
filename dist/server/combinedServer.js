import express from 'express';
import http from 'node:http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_SCHEMA_IDS } from '../core/config.js';
import { buildOpenAiModelList, createOpenAiChatCompletion } from '../openai/compat.js';
import { OpenAiResponseStore } from '../openai/responseStore.js';
import { playgroundRouter } from './playgroundApi.js';
import { syncPlaygroundFromConfig } from '../playground/syncPlayground.js';
import { applyRoutingPatch, buildRollbackEntry, buildUpdateEntry, createRoutingHistoryStoreFromEnv, parseRoutingUpdatePayload, } from '../routing/routingService.js';
// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export function createCombinedServer(params, port = 3000) {
    const app = express();
    const server = http.createServer(app);
    const routingHistory = createRoutingHistoryStoreFromEnv();
    const responseStore = new OpenAiResponseStore();
    // 中间件
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
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
            if (req.method === "GET" && url.pathname === "/v1/models") {
                return sendJson(res, 200, buildOpenAiModelList(params.configStore));
            }
            if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
                const payload = (await readJson(req));
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
                return sendJson(res, 200, params.configStore.get());
            }
            if (req.method === "GET" && url.pathname === "/v1/kgm/auto-routing") {
                return sendJson(res, 200, params.configStore.get().autoRouting);
            }
            if (req.method === "POST" && url.pathname === "/v1/kgm/auto-routing") {
                const payload = (await readJson(req));
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
                    const typed = payload;
                    let routingEntry = null;
                    if (typed.routing) {
                        const nextRouting = applyRoutingPatch(params.configStore.get().routing, typed.routing);
                        typed.routing = nextRouting;
                        routingEntry = buildUpdateEntry(nextRouting, typed.routingNote);
                    }
                    const updated = params.configStore.update(typed);
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
                else {
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
                const payload = (await readJson(req));
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
                    const typedPayload = payload;
                    const record = params.schemaRegistry.register(typedPayload);
                    return sendJson(res, 200, record);
                }
                else {
                    return sendJson(res, 400, { error: "invalid_payload" });
                }
            }
            if (req.method === "POST" && url.pathname === "/v1/kgm/memory") {
                const payload = await readJson(req);
                if (typeof payload === 'object' && payload !== null) {
                    const typedPayload = payload;
                    const embedding = await params.embedder.embed(typedPayload.text);
                    await params.memoryStore.add({
                        id: `mem_${Date.now()}`,
                        userId: typedPayload.userId,
                        text: typedPayload.text,
                        embedding,
                        embeddingVersion: params.configStore.get().embedding.version,
                        source: typedPayload.source,
                        createdAt: new Date().toISOString(),
                    });
                    return sendJson(res, 200, { status: "ok" });
                }
                else {
                    return sendJson(res, 400, { error: "invalid_payload" });
                }
            }
            if (req.method === "POST" && url.pathname === "/v1/kgm/memory/search") {
                const payload = await readJson(req);
                if (typeof payload === "object" && payload !== null) {
                    const typedPayload = payload;
                    const topK = Math.max(1, Math.min(typedPayload.topK ?? 5, 50));
                    const evidence = await params.memoryStore.search(typedPayload.userId, typedPayload.query, params.embedder, topK);
                    return sendJson(res, 200, { evidence });
                }
                return sendJson(res, 400, { error: "invalid_payload" });
            }
            if (req.method === "POST" && url.pathname === "/v1/kgm/execute") {
                const payload = await readJson(req);
                if (typeof payload === 'object' && payload !== null) {
                    const response = await params.scheduler.run(payload);
                    return sendJson(res, 200, response);
                }
                else {
                    return sendJson(res, 400, { error: "invalid_payload" });
                }
            }
            return sendJson(res, 404, { error: "not_found" });
        }
        catch (error) {
            if (res.headersSent) {
                return;
            }
            return sendJson(res, 500, { error: String(error) });
        }
    });
    // 启动服务器
    server.listen(port, () => {
        console.log(`KGM-Computing server running on http://localhost:${port}`);
        console.log(`Playground UI available at http://localhost:${port}`);
    });
    return server;
}
async function readJson(req) {
    if (req.body !== undefined) {
        return req.body;
    }
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) {
        return {};
    }
    return JSON.parse(raw);
}
function sendJson(res, status, body) {
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
function parseNumber(value) {
    if (!value)
        return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
// 如果直接运行此文件，则启动服务器
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log("Combined server needs to be initialized with proper dependencies.");
    console.log("Please use src/server/start.ts to start the full server.");
}
