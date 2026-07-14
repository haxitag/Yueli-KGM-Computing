import type { IncomingHttpHeaders } from "node:http";
import { extractAnthropicContentParts } from "./reasoning.js";
import { protectedFetch } from "../../observability/circuitBreaker.js";

export const ANTHROPIC_API_VERSION = "2023-06-01";

export type AnthropicNativeRequest = Record<string, unknown>;

export function buildAnthropicNativeHeaders(params: {
  apiKey: string;
  requestHeaders?: IncomingHttpHeaders;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": params.apiKey,
    "anthropic-version": ANTHROPIC_API_VERSION,
  };
  const incoming = params.requestHeaders ?? {};
  const beta = incoming["anthropic-beta"] ?? incoming["x-anthropic-beta"];
  if (typeof beta === "string" && beta.trim()) {
    headers["anthropic-beta"] = beta;
  } else if (Array.isArray(beta) && beta[0]) {
    headers["anthropic-beta"] = String(beta[0]);
  }
  return headers;
}

export async function postAnthropicMessages(params: {
  baseUrl: string;
  apiKey: string;
  body: AnthropicNativeRequest;
  requestHeaders?: IncomingHttpHeaders;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const url = `${params.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const controller = new AbortController();
  const timeoutId = params.timeoutMs
    ? setTimeout(() => controller.abort(), params.timeoutMs)
    : undefined;
  try {
    const response = await protectedFetch(
      url,
      {
        method: "POST",
        headers: buildAnthropicNativeHeaders({
          apiKey: params.apiKey,
          requestHeaders: params.requestHeaders,
        }),
        body: JSON.stringify(params.body),
        signal: controller.signal,
      },
      { enableBreakerTimeout: true },
    );
    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`anthropic_invalid_json:${response.status}:${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      const err = data.error as { message?: string; type?: string } | undefined;
      throw new Error(err?.message ?? `anthropic_http_${response.status}`);
    }
    return data;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 流式：将 Anthropic SSE 事件行转为 `data: {...}\n\n` 字符串迭代 */
export async function* streamAnthropicMessagesNative(params: {
  baseUrl: string;
  apiKey: string;
  body: AnthropicNativeRequest;
  requestHeaders?: IncomingHttpHeaders;
  timeoutMs?: number;
}): AsyncIterable<string> {
  const url = `${params.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const controller = new AbortController();
  const timeoutId = params.timeoutMs
    ? setTimeout(() => controller.abort(), params.timeoutMs)
    : undefined;
  let response: Response;
  try {
    response = await protectedFetch(
      url,
      {
        method: "POST",
        headers: buildAnthropicNativeHeaders({
          apiKey: params.apiKey,
          requestHeaders: params.requestHeaders,
        }),
        body: JSON.stringify({ ...params.body, stream: true }),
        signal: controller.signal,
      },
      { enableBreakerTimeout: false },
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (!response.ok || !response.body) {
    const errText = await response.text();
    throw new Error(`anthropic_stream_${response.status}:${errText.slice(0, 500)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice(5).trim();
        if (payload) yield payload;
      } else if (trimmed.startsWith("event:")) {
        continue;
      } else {
        try {
          JSON.parse(trimmed);
          yield trimmed;
        } catch {
          /* skip */
        }
      }
    }
  }
}

/** 非流式 Anthropic 响应 → 便于桥接的 OpenAI message 形 */
export function anthropicNativeToOpenAiMessage(data: Record<string, unknown>): {
  content: string;
  reasoning_content?: string;
  raw: Record<string, unknown>;
} {
  const blocks = data.content as Array<{ type?: string; text?: string; thinking?: string }> | undefined;
  const { text, thinking } = extractAnthropicContentParts(blocks);
  return {
    content: text,
    reasoning_content: thinking || undefined,
    raw: data,
  };
}
