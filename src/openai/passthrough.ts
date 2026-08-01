/**
 * Native OpenAI SSE passthrough — delivery optimization only.
 * Must NOT replace model/provider selection (AutoRouting).
 *
 * Trust rules for passthrough:
 * - managed OpenAI-compat runtime for the requested model, OR
 * - requested model matches configured default llm (incl. aliases)
 * Otherwise return false → HTTP falls through to orchestration, which
 * selects the right engine then streams (streamComplete).
 */

import type { ConfigStore } from "../core/configStore.js";
import type { KgmExtensions } from "../core/types.js";
import type { ManagedModelManager } from "../models/modelManager.js";
import type { OpenAiChatCompletionRequest, OpenAiResponsesRequest } from "./compat.js";
import { mergeOpenAiPassthroughBody } from "../llm/maas/openAiChatBody.js";
import { relayUpstreamSseNormalized } from "./sseStreamNormalize.js";
import { protectedFetch } from "../observability/circuitBreaker.js";
import { buildAuthHeaders, inferLlmAuthStyle } from "../llm/client.js";
import { modelsMatchByAlias, resolveCloudModelAlias } from "../models/cloudModelCatalog.js";

export type TrustedStreamUpstream = {
  baseUrl: string;
  path: string;
  apiKey?: string;
  /** Canonical model id to send upstream when rewriting aliases. */
  canonicalModel?: string;
  source: "managed" | "default_llm";
};

export async function maybeProxyNativeOpenAiStream(params: {
  configStore: ConfigStore;
  modelManager?: ManagedModelManager;
  protocol: "chat" | "responses";
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest;
  send: (
    upstream: Response,
    meta?: { streamSource?: string; canonicalModel?: string },
  ) => Promise<void>;
}): Promise<boolean> {
  if (!canUseNativeOpenAiStreamPassthrough(params.payload)) {
    return false;
  }

  const trusted = resolveTrustedStreamUpstream(params);
  if (!trusted) {
    // Explicit cloud/other models: let AutoRouting pick provider, then stream.
    return false;
  }

  const outbound = sanitizePassthroughPayload(params.payload);
  if (trusted.canonicalModel && typeof outbound.model === "string") {
    outbound.model = trusted.canonicalModel;
  }

  const url = joinPath(trusted.baseUrl, trusted.path);
  let response: Response;
  try {
    response = await protectedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(trusted.apiKey, inferLlmAuthStyle(trusted.baseUrl)),
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

  try {
    // Observability: delivery stage only — selection already resolved to trusted upstream.
    await params.send(response, {
      streamSource: `passthrough:${trusted.source}`,
      canonicalModel: trusted.canonicalModel,
    });
    return true;
  } catch {
    return false;
  }
}

/** 默认 send：归一化 reasoning delta 并支持空闲断开；写入 stream 可观测头 */
export async function sendNormalizedUpstreamSse(
  res: import("node:http").ServerResponse,
  upstream: Response,
  meta?: { streamSource?: string; canonicalModel?: string },
): Promise<void> {
  if (!res.headersSent) {
    if (meta?.streamSource) {
      res.setHeader("x-kgm-stream-source", meta.streamSource);
    }
    if (meta?.canonicalModel) {
      res.setHeader("x-kgm-stream-model", meta.canonicalModel);
    }
  }
  return relayUpstreamSseNormalized(res, upstream);
}

function sanitizePassthroughPayload(
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest,
): Record<string, unknown> {
  const merged = mergeOpenAiPassthroughBody(
    payload as Record<string, unknown>,
    payload as Record<string, unknown>,
  );
  const copy = { ...merged } as OpenAiChatCompletionRequest & {
    think?: boolean;
    kgm?: unknown;
    kgm_provider?: unknown;
    provider?: unknown;
  };
  // Never forward KGM orchestration extensions to upstream vendors.
  delete copy.kgm;
  delete copy.kgm_provider;
  // OpenAI chat does not use top-level provider; media-only field if present.
  if ("provider" in copy && typeof (copy as { provider?: unknown }).provider === "string") {
    delete (copy as { provider?: unknown }).provider;
  }
  const kgm = (payload as { kgm?: KgmExtensions }).kgm;
  if (kgm?.ollama && typeof kgm.ollama === "object") {
    const o = kgm.ollama as { think?: boolean };
    if (o.think === false) {
      copy.think = false;
    }
  }
  if (copy.think === undefined && payload.stream) {
    copy.think = false;
  }
  return copy as Record<string, unknown>;
}

/**
 * Only return an upstream when we are confident it serves `payload.model`.
 * Blind fallback to config.llm for unrelated model ids is forbidden (breaks routing).
 */
export function resolveTrustedStreamUpstream(params: {
  configStore: ConfigStore;
  modelManager?: ManagedModelManager;
  protocol: "chat" | "responses";
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest;
}): TrustedStreamUpstream | null {
  const rawModel =
    "model" in params.payload && typeof params.payload.model === "string"
      ? params.payload.model.trim()
      : "";
  if (!rawModel || rawModel.toLowerCase() === "auto") {
    return null;
  }

  const canonical = resolveCloudModelAlias(rawModel);

  if (params.modelManager) {
    const runtime =
      params.modelManager.findRuntimeForModel(rawModel) ??
      params.modelManager.findRuntimeForModel(canonical);
    if (runtime && runtime.runtime !== "native") {
      return {
        baseUrl: runtime.baseUrl,
        path: params.protocol === "responses" ? "/responses" : runtime.apiPath,
        apiKey: runtime.apiKey,
        canonicalModel: runtime.modelName,
        source: "managed",
      };
    }
  }

  const llm = params.configStore.get().llm;
  if (modelsMatchByAlias(rawModel, llm.model) || modelsMatchByAlias(canonical, llm.model)) {
    return {
      baseUrl: llm.baseUrl,
      path: resolveProtocolPath(params.protocol),
      apiKey: llm.apiKey,
      canonicalModel: resolveCloudModelAlias(llm.model),
      source: "default_llm",
    };
  }

  return null;
}

function canUseNativeOpenAiStreamPassthrough(
  payload: OpenAiChatCompletionRequest | OpenAiResponsesRequest,
): boolean {
  const kgm = payload.kgm;
  if (!payload.stream) {
    return false;
  }
  // Selection stage (auto) must not be short-circuited by delivery stage (stream).
  const model =
    "model" in payload && typeof payload.model === "string" ? payload.model.trim() : "";
  if (!model || model.toLowerCase() === "auto") {
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

function joinPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
