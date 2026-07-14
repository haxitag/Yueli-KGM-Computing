import type { ConfigStore } from "../core/configStore.js";
import type { KgmExtensions } from "../core/types.js";
import type { ManagedModelManager } from "../models/modelManager.js";
import type { OpenAiChatCompletionRequest, OpenAiResponsesRequest } from "./compat.js";
import { mergeOpenAiPassthroughBody } from "../llm/maas/openAiChatBody.js";
import { relayUpstreamSseNormalized } from "./sseStreamNormalize.js";
import { protectedFetch } from "../observability/circuitBreaker.js";

export async function maybeProxyNativeOpenAiStream(params: {
  configStore: ConfigStore;
  modelManager?: ManagedModelManager;
  protocol: "chat" | "responses";
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest;
  send: (upstream: Response) => Promise<void>;
}): Promise<boolean> {
  if (!canUseNativeOpenAiStreamPassthrough(params.payload)) {
    return false;
  }

  const upstream = resolveUpstream(params);
  const outbound = sanitizePassthroughPayload(params.payload);
  const url = joinPath(upstream.baseUrl, upstream.path);
  let response: Response;
  try {
    response = await protectedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(upstream.apiKey),
      },
      body: JSON.stringify(outbound),
    });
  } catch {
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
export async function sendNormalizedUpstreamSse(
  res: import("node:http").ServerResponse,
  upstream: Response,
): Promise<void> {
  return relayUpstreamSseNormalized(res, upstream);
}

function sanitizePassthroughPayload(
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest,
): Record<string, unknown> {
  const merged = mergeOpenAiPassthroughBody(
    payload as Record<string, unknown>,
    payload as Record<string, unknown>,
  );
  const copy = merged as OpenAiChatCompletionRequest & { think?: boolean };
  const kgm = copy.kgm;
  if (kgm?.ollama && typeof kgm.ollama === "object") {
    const o = kgm.ollama as { think?: boolean };
    if (o.think === false) {
      copy.think = false;
    }
  }
  if (copy.think === undefined && payload.stream) {
    copy.think = false;
  }
  return copy;
}

function resolveUpstream(params: {
  configStore: ConfigStore;
  modelManager?: ManagedModelManager;
  protocol: "chat" | "responses";
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest;
}): { baseUrl: string; path: string; apiKey?: string } {
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

function canUseNativeOpenAiStreamPassthrough(
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest,
): boolean {
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

function isPassThroughSafeExtension(kgm: KgmExtensions): boolean {
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

function resolveProtocolPath(protocol: "chat" | "responses"): string {
  if (protocol === "responses") {
    return process.env.KGM_LLM_RESPONSES_PATH ?? "/responses";
  }
  return process.env.KGM_LLM_CHAT_PATH ?? "/chat/completions";
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  return { authorization: `Bearer ${apiKey}` };
}

function joinPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
