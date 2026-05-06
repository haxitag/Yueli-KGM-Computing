import assert from "node:assert/strict";
import { once } from "node:events";
import { createKgmServer, createRuntime, HashEmbedder, MockLlmClient } from "../index.js";
async function main() {
    const runtime = createRuntime({
        llmClient: new MockLlmClient(),
        embedder: new HashEmbedder(),
    });
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
        model: "mock-model",
        messages: [{ role: "user", content: "say hello" }],
        metadata: { session_id: "smoke-session" },
    });
    assert.equal(finalResponse.object, "chat.completion");
    assert.equal(finalResponse.choices?.[0]?.message?.role, "assistant");
    assert.equal(typeof finalResponse.choices?.[0]?.message?.content, "string");
    assert.equal(finalResponse.kgm?.ops?.slaOwner, "self");
    const toolResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: "mock-model",
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
        model: "mock-model",
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
        model: "mock-model",
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
        model: "mock-model",
        max_tokens: 256,
        messages: [{ role: "user", content: "say hello" }],
    });
    assert.equal(anthropicMsg.type, "message");
    assert.equal(anthropicMsg.role, "assistant");
    assert.ok(Array.isArray(anthropicMsg.content));
    assert.equal(anthropicMsg.content[0]?.type, "text");
    assert.equal(typeof anthropicMsg.content[0]?.text, "string");
    const anthropicTools = await postJson(`${baseUrl}/v1/messages`, {
        model: "mock-model",
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
    const toolUseBlock = anthropicTools.content.find((c) => c.type === "tool_use");
    assert.ok(toolUseBlock);
    assert.equal(toolUseBlock.name, "search_web");
    const anthropicStream = await postStream(`${baseUrl}/v1/messages`, {
        model: "mock-model",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
    });
    assert.match(anthropicStream, /content_block_delta/);
    assert.ok(!anthropicStream.includes("[DONE]"));
    const chatStream = await postStream(`${baseUrl}/v1/chat/completions`, {
        model: "mock-model",
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
    const sandboxList = await getJson(`${baseUrl}/v1/kgm/sandboxes`);
    assert.ok(Array.isArray(sandboxList.sandboxes));
    assert.ok(sandboxList.sandboxes.length >= 3);
    const createdSandbox = await postJson(`${baseUrl}/v1/kgm/sandboxes`, { kind: "browser" });
    const startedSandbox = await postJson(`${baseUrl}/v1/kgm/sandboxes/${createdSandbox.sandbox.id}/start`, {});
    assert.equal(startedSandbox.sandbox.status, "running");
    const createdRuntime = await postJson(`${baseUrl}/v1/kgm/models/runtimes`, {
        runtime: "openai-compatible",
        modelName: "managed-smoke-model",
        baseUrl: "http://127.0.0.1:9999/v1",
        apiPath: "/chat/completions",
    });
    const startedRuntime = await postJson(`${baseUrl}/v1/kgm/models/runtimes/${createdRuntime.runtime.id}/start`, {});
    assert.equal(startedRuntime.runtime.status, "running");
    const models = await getJson(`${baseUrl}/v1/models`);
    assert.ok(models.data.some((item) => item.id === "managed-smoke-model"));
    const managedModels = await getJson(`${baseUrl}/v1/kgm/models`);
    assert.ok(managedModels.models.some((item) => item.modelName === "managed-smoke-model"));
    const runningModels = await getJson(`${baseUrl}/v1/kgm/models/running`);
    assert.ok(runningModels.models.some((item) => item.modelName === "managed-smoke-model"));
    const runtimeMetrics = await getJson(`${baseUrl}/v1/kgm/models/${createdRuntime.runtime.id}/metrics`);
    assert.equal(runtimeMetrics.metrics.runtimeId, createdRuntime.runtime.id);
    const prometheusMetrics = await getText(`${baseUrl}/metrics`);
    assert.match(prometheusMetrics, /kgm_runtime_requests_total/);
    console.log(JSON.stringify({
        status: "ok",
        final_finish_reason: finalResponse.choices[0].finish_reason,
        tool_finish_reason: toolResponse.choices[0].finish_reason,
        tool_name: toolResponse.choices[0].message.tool_calls[0].function.name,
        auto_exec_finish_reason: autoExecResponse.choices[0].finish_reason,
        responses_status: responsesResult.status,
        sandbox_status: startedSandbox.sandbox.status,
        managed_runtime_status: startedRuntime.runtime.status,
        managed_models: managedModels.models.length,
    }, null, 2));
    server.close();
}
async function postJson(url, body) {
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
async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`http ${response.status}: ${await response.text()}`);
    }
    return response.json();
}
async function postStream(url, body) {
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
async function getText(url) {
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
