import { mergeOpenAiPassthroughBody } from "../llm/maas/openAiChatBody.js";
import { relayUpstreamSseNormalized } from "./sseStreamNormalize.js";
export async function maybeProxyNativeOpenAiStream(params) {
    if (!canUseNativeOpenAiStreamPassthrough(params.payload)) {
        return false;
    }
    const upstream = resolveUpstream(params);
    const outbound = sanitizePassthroughPayload(params.payload);
    const url = joinPath(upstream.baseUrl, upstream.path);
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...buildAuthHeaders(upstream.apiKey),
            },
            body: JSON.stringify(outbound),
        });
    }
    catch {
        return false;
    }
    if (!response.ok || !response.body) {
        return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
        return false;
    }
    await params.send(response);
    return true;
}
/** 默认 send：归一化 reasoning delta 并支持空闲断开 */
export async function sendNormalizedUpstreamSse(res, upstream) {
    return relayUpstreamSseNormalized(res, upstream);
}
function sanitizePassthroughPayload(payload) {
    const merged = mergeOpenAiPassthroughBody(payload, payload);
    const copy = merged;
    const kgm = copy.kgm;
    if (kgm?.ollama && typeof kgm.ollama === "object") {
        const o = kgm.ollama;
        if (o.think === false) {
            copy.think = false;
        }
    }
    if (copy.think === undefined && payload.stream) {
        copy.think = false;
    }
    return copy;
}
function resolveUpstream(params) {
    const model = "model" in params.payload ? params.payload.model : undefined;
    if (model && params.modelManager) {
        const runtime = params.modelManager.findRuntimeForModel(model);
        if (runtime && runtime.runtime !== "native") {
            return {
                baseUrl: runtime.baseUrl,
                path: params.protocol === "responses" ? "/responses" : runtime.apiPath,
                apiKey: runtime.apiKey,
            };
        }
    }
    const llm = params.configStore.get().llm;
    return {
        baseUrl: llm.baseUrl,
        path: resolveProtocolPath(params.protocol),
        apiKey: llm.apiKey,
    };
}
function canUseNativeOpenAiStreamPassthrough(payload) {
    const kgm = payload.kgm;
    if (!payload.stream) {
        return false;
    }
    if (!kgm) {
        return true;
    }
    if (kgm.graph?.enabled || kgm.retrieval) {
        return false;
    }
    if (kgm.capabilities?.includeBuiltinTools) {
        return false;
    }
    if (kgm.capabilities?.executeToolCalls === true) {
        return false;
    }
    return isPassThroughSafeExtension(kgm);
}
function isPassThroughSafeExtension(kgm) {
    if (kgm.graph?.enabled || kgm.retrieval) {
        return false;
    }
    const caps = kgm.capabilities;
    if (!caps) {
        return true;
    }
    if (caps.includeBuiltinTools || caps.executeToolCalls === true) {
        return false;
    }
    return true;
}
function resolveProtocolPath(protocol) {
    if (protocol === "responses") {
        return process.env.KGM_LLM_RESPONSES_PATH ?? "/responses";
    }
    return process.env.KGM_LLM_CHAT_PATH ?? "/chat/completions";
}
function buildAuthHeaders(apiKey) {
    if (!apiKey) {
        return {};
    }
    return { authorization: `Bearer ${apiKey}` };
}
function joinPath(baseUrl, path) {
    return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
