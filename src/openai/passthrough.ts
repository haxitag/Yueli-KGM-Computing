import type { ConfigStore } from "../core/configStore.js";
import type { KgmExtensions } from "../core/types.js";
import type { ManagedModelManager } from "../models/modelManager.js";
import type { OpenAiChatCompletionRequest, OpenAiResponsesRequest } from "./compat.js";

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
  const url = joinPath(upstream.baseUrl, upstream.path);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(upstream.apiKey),
      },
      body: JSON.stringify(params.payload),
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
  if (kgm.capabilities?.includeBuiltinTools || kgm.capabilities?.executeToolCalls) {
    return false;
  }

  return isPassThroughSafeExtension(kgm);
}

function isPassThroughSafeExtension(kgm: KgmExtensions): boolean {
  return !kgm.graph && !kgm.retrieval && !kgm.capabilities;
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
