import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigStore } from "../core/configStore.js";
import { HashEmbedder } from "../embedding/canonical.js";
import { createKgmServer, createRuntimeWithStorage } from "../index.js";
import { SmokeCompatibilityLlmClient } from "./smokeLlmClient.js";

async function main(): Promise<void> {
  /**
   * Smoke **默认离线**：避免 shell 里残留的无效 `KGM_LLM_BASE_URL` 导致 502。
   * 要对真实 LLM 跑通：设置 `KGM_SMOKE_LIVE_LLM=1`（并配置可用的 `KGM_LLM_*`）。
   */
  const offlineLlm = process.env.KGM_SMOKE_LIVE_LLM !== "1";
  if (offlineLlm) {
    /** 离线模式下 `search_web` 等内置工具仍会访问外网；与确定性 smoke LLM 对齐为桩响应。 */
    process.env.KGM_SMOKE_STUB_NETWORK_TOOLS = "1";
  }
  /**
   * 默认 Hash 嵌入，避免未配置 `KGM_EMBEDDING_API_KEY` 时在 graph/检索路径失败。
   * 真实 embedding：`KGM_SMOKE_LIVE_EMBEDDING=1` 且配置完整的 `KGM_EMBEDDING_*`。
   */
  const useHashEmbed = process.env.KGM_SMOKE_LIVE_EMBEDDING !== "1";

  /**
   * 离线模式下关闭 auto-routing 与在线 evaluation（judge/verifier），否则 `wrapResult` 仍会 fetch 上游 LLM。
   * 默认配置 `vector.backend === "chroma"` 会连本地 Chroma；未启动时 fetch 失败且错误含 “fetch”，易被误判为 LLM 上游不可用。
   */
  const configStore =
    offlineLlm
      ? new ConfigStore({
          initial: {
            vector: { backend: "memory" },
            autoRouting: {
              enabled: false,
              allowDynamicSelection: false,
              evaluation: { enabled: false },
            },
          },
          loadFromDisk: false,
          autoPersist: false,
        })
      : undefined;

  const runtime = await createRuntimeWithStorage({
    ...(configStore ? { configStore } : {}),
    ...(useHashEmbed ? { embedder: new HashEmbedder() } : {}),
    ...(offlineLlm ? { llmClient: new SmokeCompatibilityLlmClient() } : {}),
  });
  const smokeModel = process.env.KGM_LLM_MODEL ?? "gpt-4o-mini";
  const server = createKgmServer({
    scheduler: runtime.scheduler,
    contextBuilder: runtime.contextBuilder,
    llmClient: runtime.llmClient,
    schemaRegistry: runtime.schemaRegistry,
    toolRegistry: runtime.toolRegistry,
    memoryStore: runtime.memoryStore,
    graphStore: runtime.graphStore,
    embedder: runtime.embedder,
    sandboxManager: runtime.sandboxManager,
    configStore: runtime.configStore,
    skillRuntime: runtime.skillRuntime,
    artifactStore: runtime.artifactStore,
    sessionStore: runtime.sessionStore,
  });

  server.listen(0);
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address not available");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const finalResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: smokeModel,
    messages: [{ role: "user", content: "say hello" }],
    metadata: { session_id: "smoke-session" },
  });
  assert.equal(finalResponse.object, "chat.completion");
  assert.equal(finalResponse.choices?.[0]?.message?.role, "assistant");
  assert.equal(typeof finalResponse.choices?.[0]?.message?.content, "string");
  assert.equal(finalResponse.kgm?.ops?.slaOwner, "self");

  const toolResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: smokeModel,
    messages: [{ role: "user", content: "search market trends" }],
    kgm: {
      capabilities: {
        includeBuiltinTools: true,
        executeToolCalls: false,
      },
      graph: {
        enabled: true,
        entities: ["market", "trend"],
        triples: [{ subject: "market", predicate: "influences", object: "trend" }],
      },
    },
  });
  assert.equal(toolResponse.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(toolResponse.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, "search_web");

  const autoExecResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: smokeModel,
    messages: [{ role: "user", content: "search market trends" }],
    kgm: {
      capabilities: {
        includeBuiltinTools: true,
        executeToolCalls: true,
      },
    },
  });
  assert.equal(autoExecResponse.choices?.[0]?.finish_reason, "stop");
  assert.equal(autoExecResponse.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, "search_web");
  assert.equal(typeof autoExecResponse.choices?.[0]?.message?.content, "string");

  const responsesResult = await postJson(`${baseUrl}/v1/responses`, {
    model: smokeModel,
    input: "search market trends",
    kgm: {
      capabilities: {
        includeBuiltinTools: true,
        executeToolCalls: true,
      },
    },
  });
  assert.equal(responsesResult.object, "response");
  assert.equal(responsesResult.status, "completed");
  assert.equal(typeof responsesResult.output_text, "string");

  const anthropicMsg = await postJson(`${baseUrl}/v1/messages`, {
    model: smokeModel,
    max_tokens: 256,
    messages: [{ role: "user", content: "say hello" }],
  });
  assert.equal(anthropicMsg.type, "message");
  assert.equal(anthropicMsg.role, "assistant");
  assert.ok(Array.isArray(anthropicMsg.content));
  assert.equal(anthropicMsg.content[0]?.type, "text");
  assert.equal(typeof anthropicMsg.content[0]?.text, "string");

  const anthropicTools = await postJson(`${baseUrl}/v1/messages`, {
    model: smokeModel,
    max_tokens: 256,
    messages: [{ role: "user", content: "search market trends" }],
    kgm: {
      capabilities: {
        includeBuiltinTools: true,
        executeToolCalls: false,
      },
      graph: {
        enabled: true,
        entities: ["market", "trend"],
        triples: [{ subject: "market", predicate: "influences", object: "trend" }],
      },
    },
  });
  assert.equal(anthropicTools.stop_reason, "tool_use");
  const toolUseBlock = (anthropicTools.content as Array<{ type: string; name?: string }>).find((c) => c.type === "tool_use");
  assert.ok(toolUseBlock);
  assert.equal(toolUseBlock!.name, "search_web");

  const anthropicStream = await postStream(`${baseUrl}/v1/messages`, {
    model: smokeModel,
    max_tokens: 256,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(anthropicStream, /content_block_delta/);
  assert.ok(!anthropicStream.includes("[DONE]"));

  const chatStream = await postStream(`${baseUrl}/v1/chat/completions`, {
    model: smokeModel,
    stream: true,
    messages: [{ role: "user", content: "search market trends" }],
    kgm: {
      capabilities: {
        includeBuiltinTools: true,
        executeToolCalls: true,
      },
    },
  });
  assert.match(chatStream, /chat\.completion\.chunk/);
  assert.match(chatStream, /search_web/);
  assert.match(chatStream, /\[DONE\]/);

  const modelsList = await getJson(`${baseUrl}/v1/models`);
  assert.ok(Array.isArray(modelsList.data));
  const autoEntry = modelsList.data.find((m: { id: string }) => m.id === "auto");
  assert.ok(autoEntry?.kgm?.capabilities?.includes?.("proxy_aggregation") || autoEntry?.kgm?.modelType === "routing-entry");

  const mediaRes = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "smoke" }),
  });
  assert.equal(mediaRes.status, 501);
  const mediaBody = (await mediaRes.json()) as { error?: { code?: string } };
  assert.equal(mediaBody.error?.code, "image_generation_provider_not_configured");

  const videoRes = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "smoke video" }),
  });
  assert.equal(videoRes.status, 501);
  const videoBody = (await videoRes.json()) as { error?: { code?: string } };
  assert.equal(videoBody.error?.code, "video_generation_provider_not_configured");

  const editsRes = await fetch(`${baseUrl}/v1/images/edits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "smoke edit" }),
  });
  assert.equal(editsRes.status, 501);

  const rerankRes = await fetch(`${baseUrl}/v1/rerank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "q", documents: ["a"] }),
  });
  assert.equal(rerankRes.status, 501);

  let sandboxStatus: string | undefined;
  let managedRuntimeStatus: string | undefined;
  let managedModelCount: number | undefined;

  /** 沙箱 / 托管运行时依赖 Chromium（Playwright）；默认离线 smoke 跳过。完整链路：`npm run smoke:openai-compat:infra`（脚本已含 FULL_INFRA + BROWSER_USE_EMBEDDED）。 */
  if (process.env.KGM_SMOKE_FULL_INFRA === "1") {
    const sandboxList = await getJson(`${baseUrl}/v1/kgm/sandboxes`);
    assert.ok(Array.isArray(sandboxList.sandboxes));
    assert.ok(sandboxList.sandboxes.length >= 3);
    const createdSandbox = await postJson(`${baseUrl}/v1/kgm/sandboxes`, { kind: "browser" });
    await postJson(`${baseUrl}/v1/kgm/sandboxes/${createdSandbox.sandbox.id}/start`, {});
    /** Playwright 适配器异步拉起，`withPreview` 在子进程写入 pid 前会短暂显示 stopped */
    await waitUntilTrue(
      async () => {
        const cur = await getJson(`${baseUrl}/v1/kgm/sandboxes/${createdSandbox.sandbox.id}`);
        return cur.sandbox?.status === "running";
      },
      { timeoutMs: 45_000, intervalMs: 250 },
    );
    const sbFinal = await getJson(`${baseUrl}/v1/kgm/sandboxes/${createdSandbox.sandbox.id}`);
    assert.equal(sbFinal.sandbox.status, "running");
    sandboxStatus = sbFinal.sandbox.status as string;

    const createdRuntime = await postJson(`${baseUrl}/v1/kgm/models/runtimes`, {
      runtime: "openai-compatible",
      modelName: "managed-smoke-model",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiPath: "/chat/completions",
    });
    const startedRuntime = await postJson(`${baseUrl}/v1/kgm/models/runtimes/${createdRuntime.runtime.id}/start`, {});
    assert.equal(startedRuntime.runtime.status, "running");
    managedRuntimeStatus = startedRuntime.runtime.status as string;
    const models = await getJson(`${baseUrl}/v1/models`);
    assert.ok(models.data.some((item: { id: string }) => item.id === "managed-smoke-model"));
    const managedModels = await getJson(`${baseUrl}/v1/kgm/models`);
    assert.ok(managedModels.models.some((item: { modelName: string }) => item.modelName === "managed-smoke-model"));
    managedModelCount = managedModels.models.length as number;
    const runningModels = await getJson(`${baseUrl}/v1/kgm/models/running`);
    assert.ok(runningModels.models.some((item: { modelName: string }) => item.modelName === "managed-smoke-model"));
    const runtimeMetrics = await getJson(`${baseUrl}/v1/kgm/models/${createdRuntime.runtime.id}/metrics`);
    assert.equal(runtimeMetrics.metrics.runtimeId, createdRuntime.runtime.id);
    const prometheusMetrics = await getText(`${baseUrl}/metrics`);
    assert.match(prometheusMetrics, /kgm_runtime_requests_total/);
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        final_finish_reason: finalResponse.choices[0].finish_reason,
        tool_finish_reason: toolResponse.choices[0].finish_reason,
        tool_name: toolResponse.choices[0].message.tool_calls[0].function.name,
        auto_exec_finish_reason: autoExecResponse.choices[0].finish_reason,
        responses_status: responsesResult.status,
        sandbox_status: sandboxStatus ?? "skipped",
        managed_runtime_status: managedRuntimeStatus ?? "skipped",
        managed_models: managedModelCount ?? "skipped",
      },
      null,
      2,
    ),
  );

  // Marker for ./openai-compat-smoke.mjs — then SIGKILL to skip ONNX teardown abort.
  fs.writeFileSync(path.join(os.tmpdir(), "kgm-openai-compat-smoke.ok"), "ok\n");
  process.kill(process.pid, "SIGKILL");
}

async function waitUntilTrue(
  fn: () => Promise<boolean>,
  options: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, options.intervalMs));
  }
  throw new Error(`wait_until_timeout:${options.timeoutMs}ms`);
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`http ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`http ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function postStream(url: string, body: unknown): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`http ${response.status}: ${await response.text()}`);
  }
  return response.text();
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`http ${response.status}: ${await response.text()}`);
  }
  return response.text();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
