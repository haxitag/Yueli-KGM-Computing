import type { MaaSOpenAiChatExtras, MaaSThinkingParam } from "./types.js";

export const REASONING_MESSAGE_KEYS = [
  "reasoning_content",
  "reasoning",
  "thinking",
  "thought",
] as const;

export const REASONING_DELTA_KEYS = [...REASONING_MESSAGE_KEYS] as const;

function firstNonEmptyString(...values: Array<unknown>): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "";
}

/** 从 OpenAI-compat message / choice 提取正文与推理文本 */
export function extractOpenAiCompatMessageParts(message: Record<string, unknown> | undefined): {
  content: string;
  reasoning: string;
} {
  if (!message) {
    return { content: "", reasoning: "" };
  }
  const content = firstNonEmptyString(message.content, message.output_text);
  const reasoning = firstNonEmptyString(
    ...REASONING_MESSAGE_KEYS.map((k) => message[k]),
  );
  return { content, reasoning };
}

/** 从非流式 choice 提取最终展示文本（content 优先，否则 reasoning） */
export function extractOpenAiCompatChoiceText(choice: Record<string, unknown> | undefined): {
  text: string;
  reasoning: string;
} {
  const message = choice?.message as Record<string, unknown> | undefined;
  const parts = extractOpenAiCompatMessageParts(message);
  const text = firstNonEmptyString(parts.content, parts.reasoning, choice?.text as string | undefined);
  return { text, reasoning: parts.reasoning };
}

/** 从 SSE delta 对象提取 content / reasoning 通道 */
export function extractOpenAiCompatDeltaParts(delta: Record<string, unknown> | undefined): {
  content: string;
  reasoning: string;
} {
  if (!delta) return { content: "", reasoning: "" };
  const content = typeof delta.content === "string" ? delta.content : "";
  const reasoning = firstNonEmptyString(
    ...REASONING_DELTA_KEYS.map((k) => delta[k]),
  );
  return { content, reasoning };
}

/** 从任意请求体拾取 MaaS 扩展字段（JSON 解析后的超集） */
export function extractMaaSOpenAiExtras(body: Record<string, unknown>): MaaSOpenAiChatExtras {
  const extras: MaaSOpenAiChatExtras = {};
  if (body.thinking !== undefined) {
    extras.thinking = body.thinking as MaaSThinkingParam;
  }
  if (typeof body.enable_thinking === "boolean") {
    extras.enable_thinking = body.enable_thinking;
  }
  if (body.reasoning_effort !== undefined) {
    extras.reasoning_effort = String(body.reasoning_effort);
  }
  if (body.output_config !== undefined && typeof body.output_config === "object") {
    extras.output_config = body.output_config as MaaSOpenAiChatExtras["output_config"];
  }
  if (body.response_format !== undefined) {
    extras.response_format = body.response_format as Record<string, unknown>;
  }
  if (Array.isArray(body.tools)) {
    extras.tools = body.tools;
  }
  if (body.tool_choice !== undefined) {
    extras.tool_choice = body.tool_choice;
  }
  if (typeof body.parallel_tool_calls === "boolean") {
    extras.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.top_p === "number") {
    extras.top_p = body.top_p;
  }
  if (body.stop !== undefined) {
    extras.stop = body.stop as string | string[];
  }
  return extras;
}

/** 请求是否显式启用推理模式 */
export function isReasoningRequestEnabled(extras: MaaSOpenAiChatExtras): boolean {
  if (extras.enable_thinking === true) return true;
  if (extras.reasoning_effort !== undefined) return true;
  const t = extras.thinking;
  if (t === true) return true;
  if (t && typeof t === "object") {
    const type = String(t.type ?? "").toLowerCase();
    return type === "enabled" || type === "adaptive";
  }
  return false;
}

/** Anthropic Messages 请求是否应走原生代理（含 thinking / effort / cache） */
export function shouldProxyAnthropicMessagesNative(body: Record<string, unknown>): boolean {
  if (body.thinking !== undefined) return true;
  if (body.output_config !== undefined) return true;
  if (body.cache_control !== undefined) return true;
  const betas = body.anthropic_beta ?? body.betas;
  if (Array.isArray(betas) && betas.length > 0) return true;
  return false;
}

/** 从 Anthropic content 数组提取 text / thinking */
export function extractAnthropicContentParts(
  blocks: Array<{ type?: string; text?: string; thinking?: string }> | undefined,
): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  for (const b of blocks ?? []) {
    if (b.type === "text" && b.text) {
      text += b.text;
    }
    if (b.type === "thinking" && (b.thinking ?? b.text)) {
      thinking += b.thinking ?? b.text ?? "";
    }
  }
  return { text, thinking };
}
