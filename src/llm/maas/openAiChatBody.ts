import type { CompletionOptions } from "../client.js";
import type { MaaSChatMessage, MaaSOpenAiChatExtras } from "./types.js";
import { extractMaaSOpenAiExtras } from "./reasoning.js";

export type BuildOpenAiChatBodyParams = {
  model: string;
  prompt?: string;
  messages?: MaaSChatMessage[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  topP?: number;
  options?: CompletionOptions;
  extras?: MaaSOpenAiChatExtras;
  /** 原始请求体（拾取未建模字段） */
  rawRequest?: Record<string, unknown>;
};

const PASSTHROUGH_REQUEST_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "thinking",
  "enable_thinking",
  "reasoning_effort",
  "output_config",
  "user",
  "metadata",
  "seed",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "service_tier",
]);

/**
 * 构建 OpenAI Chat Completions 上游请求体，保留各 MaaS thinking/reasoning 扩展字段。
 */
export function buildOpenAiChatCompletionsBody(params: BuildOpenAiChatBodyParams): Record<string, unknown> {
  const options = params.options;
  const extras = {
    ...extractMaaSOpenAiExtras(params.rawRequest ?? {}),
    ...(params.extras ?? {}),
    ...(options?.maasExtras ?? {}),
  };

  const messages: MaaSChatMessage[] =
    params.messages ??
    options?.messages ??
    (params.prompt !== undefined ? [{ role: "user", content: params.prompt }] : []);

  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    stream: params.stream ?? false,
  };

  const maxTokens = params.maxTokens ?? options?.maxTokens;
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }
  const temperature = params.temperature ?? options?.temperature;
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  const stop = params.stop ?? options?.stop;
  if (stop !== undefined) {
    body.stop = stop;
  }
  const topP = params.topP ?? options?.topP;
  if (topP !== undefined) {
    body.top_p = topP;
  }

  if (options?.tools !== undefined) {
    body.tools = options.tools;
  } else if (extras.tools !== undefined) {
    body.tools = extras.tools;
  }
  if (options?.toolChoice !== undefined) {
    body.tool_choice = options.toolChoice;
  } else if (extras.tool_choice !== undefined) {
    body.tool_choice = extras.tool_choice;
  }
  if (options?.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = options.parallelToolCalls;
  } else if (extras.parallel_tool_calls !== undefined) {
    body.parallel_tool_calls = extras.parallel_tool_calls;
  }
  if (options?.responseFormat !== undefined) {
    body.response_format = options.responseFormat;
  } else if (extras.response_format !== undefined) {
    body.response_format = extras.response_format;
  }

  // Thinking / reasoning 模式
  if (options?.thinking !== undefined) {
    body.thinking = normalizeThinkingForUpstream(options.thinking);
  } else if (extras.thinking !== undefined) {
    body.thinking = extras.thinking;
  }
  if (options?.enableThinking !== undefined) {
    body.enable_thinking = options.enableThinking;
  } else if (extras.enable_thinking !== undefined) {
    body.enable_thinking = extras.enable_thinking;
  }
  if (options?.reasoningEffort !== undefined) {
    body.reasoning_effort = options.reasoningEffort;
  } else if (extras.reasoning_effort !== undefined) {
    body.reasoning_effort = extras.reasoning_effort;
  }
  if (options?.outputConfig !== undefined) {
    body.output_config = options.outputConfig;
  } else if (extras.output_config !== undefined) {
    body.output_config = extras.output_config;
  }

  // Ollama think 字段（OpenAI-compat 网关可能识别）
  if (options?.think === false) {
    body.think = false;
  } else if (options?.think === true) {
    body.think = true;
  }

  // Session fingerprint + full options.metadata merge for upstream affinity / tenant hints
  if (options?.sessionId && body.user === undefined) {
    body.user = options.sessionId;
  }
  const sessionFingerprint: Record<string, unknown> = {
    ...(options?.metadata && typeof options.metadata === "object" ? options.metadata : {}),
  };
  if (options?.sessionId) {
    sessionFingerprint.kgm_session_id = options.sessionId;
  }
  const nativeRuntimeId = options?.metadata?.native_runtime_id;
  if (typeof nativeRuntimeId === "string" && nativeRuntimeId.trim()) {
    sessionFingerprint.native_runtime_id = nativeRuntimeId.trim();
  }
  if (Object.keys(sessionFingerprint).length > 0) {
    const existing =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    body.metadata = { ...existing, ...sessionFingerprint };
  }

  if (extras.extraBody) {
    Object.assign(body, extras.extraBody);
  }
  if (options?.extraBody) {
    Object.assign(body, options.extraBody);
  }

  // 从原始请求合并其余标准字段（直通场景）
  if (params.rawRequest) {
    for (const [key, value] of Object.entries(params.rawRequest)) {
      if (PASSTHROUGH_REQUEST_KEYS.has(key) && body[key] === undefined && value !== undefined) {
        body[key] = value;
      }
    }
  }

  return body;
}

function normalizeThinkingForUpstream(thinking: CompletionOptions["thinking"]): unknown {
  if (thinking === undefined) return undefined;
  if (typeof thinking === "boolean") {
    return thinking ? { type: "enabled" } : { type: "disabled" };
  }
  return thinking;
}

/** 将 OpenAI Chat 请求 + 未建模字段合并为直通上游体 */
export function mergeOpenAiPassthroughBody(
  typed: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return buildOpenAiChatCompletionsBody({
    model: String(typed.model ?? raw.model ?? ""),
    messages: (typed.messages ?? raw.messages) as MaaSChatMessage[] | undefined,
    stream: Boolean(typed.stream ?? raw.stream),
    maxTokens: (typed.max_tokens ?? typed.max_completion_tokens ?? raw.max_tokens) as number | undefined,
    temperature: (typed.temperature ?? raw.temperature) as number | undefined,
    rawRequest: { ...raw, ...typed },
  });
}
