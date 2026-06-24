import type { ConfigStore } from "../core/configStore.js";
import type { KgmExtensions } from "../core/types.js";
import type { MaaSOutputConfig, MaaSThinkingParam } from "../llm/maas/types.js";
import type { ContextBuilder } from "../context/contextBuilder.js";
import type { LlmClient } from "../llm/client.js";
import {
  createOpenAiChatCompletion,
  streamOpenAiChatCompletion,
  type OpenAiChatCompletionRequest,
  type OpenAiChatMessage,
  type OpenAiToolChoice,
  type OpenAiToolDefinition,
} from "../openai/compat.js";
import type { OpenAiResponseStore } from "../openai/responseStore.js";
import type { SkillRuntime } from "../skills/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";

export type AnthropicCompatDeps = {
  contextBuilder: ContextBuilder;
  llmClient: LlmClient;
  toolRegistry: ToolRegistry;
  configStore: ConfigStore;
  outputSchema: Record<string, unknown>;
  responseStore: OpenAiResponseStore;
  skillRuntime?: SkillRuntime;
};

/** Anthropic Messages API 内容块（与 OpenAI `tool_calls` / `tool` 角色互转） */
export type AnthropicTextBlock = { type: "text"; text: string };

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  /** 与 Anthropic API 一致，为 JSON 对象 */
  input: Record<string, unknown>;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  /** 字符串或结构化内容（将序列化为字符串交给 OpenAI `tool` 消息） */
  content: string | unknown;
};

export type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

export type AnthropicAssistantContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock;

export type AnthropicUserContentBlock = AnthropicTextBlock | AnthropicToolResultBlock;

export type AnthropicMessageContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

/** Anthropic Messages API `tools[]` 子集（映射到 OpenAI `tools`） */
export type AnthropicToolDefinition = {
  name: string;
  description?: string;
  /** JSON Schema 对象，对应 OpenAI `function.parameters` */
  input_schema?: Record<string, unknown>;
};

/**
 * Anthropic `tool_choice`（与 [Messages API](https://docs.anthropic.com/en/api/messages) 子集对齐）。
 * - `any` → OpenAI `required`（至少一次工具调用）。
 * - `none` / `{ type: "none" }` → OpenAI `none`。
 * - 对象形式可含 `disable_parallel_tool_use`：为 `true` 时映射为 OpenAI `parallel_tool_calls: false`（除非请求体另有 `parallel_tool_calls` 覆盖）。
 */
export type AnthropicToolChoice =
  | "auto"
  | "any"
  | "none"
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export type AnthropicMessagesRequest = {
  model: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicMessageContentBlock[];
  }>;
  system?: string | AnthropicMessageContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
  /** Anthropic adaptive / extended thinking（Opus 4.6+、Sonnet 4.6+、Fable 5） */
  thinking?: MaaSThinkingParam;
  /** 与 thinking.type=adaptive 配合的 effort 控制 */
  output_config?: MaaSOutputConfig;
  /** 与 Anthropic Messages API 一致，经 `anthropicMessagesToOpenAiChatRequest` 映射到 OpenAI `tools` */
  tools?: AnthropicToolDefinition[];
  /** 映射到 OpenAI `tool_choice`（含 `none`、对象上的 `disable_parallel_tool_use`） */
  tool_choice?: AnthropicToolChoice;
  /**
   * 透传 OpenAI `parallel_tool_calls`。
   * 若与 `tool_choice` 对象中的 `disable_parallel_tool_use` 同时出现，**以此字段为准**。
   */
  parallel_tool_calls?: boolean;
  /** 与 `/v1/chat/completions` 一致，用于工具调用等 KGM 扩展 */
  kgm?: KgmExtensions;
};

type OpenAiToolCallLike = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

function parseFunctionArgumentsJson(argumentsJson: string | undefined): Record<string, unknown> {
  const raw = argumentsJson ?? "{}";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* empty */
  }
  return {};
}

/**
 * OpenAI `tool_calls` → Anthropic `tool_use` 块（不含 text）。
 */
export function openAiToolCallsToAnthropicToolUseBlocks(toolCalls: OpenAiToolCallLike[]): AnthropicToolUseBlock[] {
  return toolCalls.map((call, index) => {
    const id = call.id?.trim() || `toolu_${index}_${Date.now().toString(36)}`;
    const name = call.function?.name ?? "";
    const input = parseFunctionArgumentsJson(call.function?.arguments);
    return { type: "tool_use", id, name, input };
  });
}

/**
 * OpenAI assistant `message`（`content` + 可选 `tool_calls`）→ Anthropic `content` 数组。
 */
export function openAiAssistantMessageToAnthropicContent(message: {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAiToolCallLike[];
}): Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock> {
  const blocks: Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock> = [];
  const reasoning = message.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    blocks.push({ type: "thinking", thinking: reasoning });
  }
  const text = message.content;
  if (text !== null && text !== undefined && String(text).length > 0) {
    blocks.push({ type: "text", text: String(text) });
  }
  if (message.tool_calls?.length) {
    blocks.push(...openAiToolCallsToAnthropicToolUseBlocks(message.tool_calls));
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

function mapOpenAiFinishReasonToAnthropicStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    case "stop":
    default:
      return "end_turn";
  }
}

export function openAiChatCompletionToAnthropicMessage(openai: Record<string, unknown>): Record<string, unknown> {
  const choices = openai.choices as Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCallLike[];
    };
  }> | undefined;
  const message = choices?.[0]?.message as {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAiToolCallLike[];
  } | undefined;
  const usage = openai.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const model = String(openai.model ?? "");
  const rawId = String(openai.id ?? "chatcmpl");
  const id = rawId.startsWith("chatcmpl-") ? `msg_${rawId.slice("chatcmpl-".length)}` : `msg_${rawId}`;
  const stopReason = mapOpenAiFinishReasonToAnthropicStopReason(choices?.[0]?.finish_reason);
  const content = message
    ? openAiAssistantMessageToAnthropicContent(message)
    : [{ type: "text" as const, text: "" }];
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

function expandAnthropicAssistantToOpenAi(blocks: AnthropicMessageContentBlock[]): OpenAiChatMessage[] {
  const textParts: string[] = [];
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof (block as AnthropicTextBlock).text === "string") {
      textParts.push((block as AnthropicTextBlock).text);
    }
    if (block.type === "tool_use") {
      const b = block as AnthropicToolUseBlock;
      toolUses.push({
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        input: b.input && typeof b.input === "object" ? b.input : {},
      });
    }
  }
  const textJoined = textParts.join("");
  const msg: OpenAiChatMessage = {
    role: "assistant",
    content: textJoined.length > 0 ? textJoined : null,
  };
  if (toolUses.length > 0) {
    msg.tool_calls = toolUses.map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
    }));
  }
  return [msg];
}

function expandAnthropicUserBlocksToOpenAi(blocks: AnthropicMessageContentBlock[]): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [];
  const textBuf: string[] = [];
  const flushText = (): void => {
    const t = textBuf.join("");
    textBuf.length = 0;
    if (t.length > 0) {
      out.push({ role: "user", content: t });
    }
  };
  for (const block of blocks) {
    if (block.type === "text" && typeof (block as AnthropicTextBlock).text === "string") {
      textBuf.push((block as AnthropicTextBlock).text);
    } else if (block.type === "tool_result") {
      flushText();
      const b = block as AnthropicToolResultBlock;
      const toolUseId = String(b.tool_use_id ?? "");
      const c =
        typeof b.content === "string" ? b.content : b.content !== undefined ? JSON.stringify(b.content) : "";
      out.push({ role: "tool", tool_call_id: toolUseId, content: c });
    }
  }
  flushText();
  return out;
}

export function anthropicToolsToOpenAiTools(
  tools: AnthropicToolDefinition[] | undefined,
): OpenAiToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

export type ParsedAnthropicToolChoice = {
  openAi: OpenAiToolChoice | undefined;
  /** 官方对象字段 `disable_parallel_tool_use`；仅对象形式且字段存在时有值 */
  disableParallelToolUse?: boolean;
};

export function parseAnthropicToolChoice(toolChoice: AnthropicToolChoice | undefined): ParsedAnthropicToolChoice {
  if (toolChoice === undefined) return { openAi: undefined };
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return { openAi: "auto" };
    if (toolChoice === "any") return { openAi: "required" };
    if (toolChoice === "none") return { openAi: "none" };
    return { openAi: undefined };
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const o = toolChoice as Record<string, unknown>;
    const disableRaw = o.disable_parallel_tool_use;
    const disableParallelToolUse = typeof disableRaw === "boolean" ? disableRaw : undefined;
    const t = o.type;
    if (t === "auto") return { openAi: "auto", disableParallelToolUse };
    if (t === "any") return { openAi: "required", disableParallelToolUse };
    if (t === "tool") {
      const name = String(o.name ?? "").trim();
      if (!name) return { openAi: undefined, disableParallelToolUse };
      return {
        openAi: { type: "function", function: { name } },
        disableParallelToolUse,
      };
    }
    if (t === "none") return { openAi: "none" };
  }
  return { openAi: undefined };
}

export function anthropicToolChoiceToOpenAi(toolChoice: AnthropicToolChoice | undefined): OpenAiToolChoice | undefined {
  return parseAnthropicToolChoice(toolChoice).openAi;
}

/** 由 `tool_choice.disable_parallel_tool_use` 推导 OpenAI `parallel_tool_calls`（未指定则 undefined） */
export function anthropicDisableParallelToOpenAiParallel(
  disableParallelToolUse: boolean | undefined,
): boolean | undefined {
  if (disableParallelToolUse === undefined) return undefined;
  return !disableParallelToolUse;
}

export function anthropicMessagesToOpenAiChatRequest(req: AnthropicMessagesRequest): OpenAiChatCompletionRequest {
  const messages: OpenAiChatMessage[] = [];
  if (req.system !== undefined && req.system !== "") {
    const systemContent =
      typeof req.system === "string" ? req.system : JSON.stringify(req.system);
    messages.push({ role: "system", content: systemContent });
  }
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      messages.push(...expandAnthropicAssistantToOpenAi(m.content));
    } else {
      messages.push(...expandAnthropicUserBlocksToOpenAi(m.content));
    }
  }
  const tools = anthropicToolsToOpenAiTools(req.tools);
  const parsedChoice = parseAnthropicToolChoice(req.tool_choice);
  const tool_choice = parsedChoice.openAi;
  const fromChoice = anthropicDisableParallelToOpenAiParallel(parsedChoice.disableParallelToolUse);
  const parallel_tool_calls =
    req.parallel_tool_calls !== undefined ? req.parallel_tool_calls : fromChoice;
  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens ?? 4096,
    temperature: req.temperature,
    stream: req.stream,
    metadata: req.metadata,
    kgm: req.kgm,
    ...(req.thinking !== undefined ? { thinking: req.thinking } : {}),
    ...(req.output_config !== undefined ? { output_config: req.output_config } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(tool_choice !== undefined ? { tool_choice } : {}),
    ...(parallel_tool_calls !== undefined ? { parallel_tool_calls } : {}),
  };
}

export async function createAnthropicMessagesResponse(
  params: AnthropicCompatDeps & { request: AnthropicMessagesRequest },
): Promise<Record<string, unknown>> {
  const request = anthropicMessagesToOpenAiChatRequest({ ...params.request, stream: false });
  const response = await createOpenAiChatCompletion({
    ...params,
    request,
  });
  return openAiChatCompletionToAnthropicMessage(response);
}

type ToolCallAcc = {
  id?: string;
  name?: string;
  arguments: string;
};

function mergeToolCallDeltas(
  acc: Record<number, ToolCallAcc>,
  deltas: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>,
): void {
  for (const d of deltas) {
    const idx = typeof d.index === "number" ? d.index : 0;
    if (!acc[idx]) {
      acc[idx] = { arguments: "" };
    }
    if (d.id) {
      acc[idx].id = d.id;
    }
    if (d.function?.name) {
      acc[idx].name = d.function.name;
    }
    if (d.function?.arguments) {
      acc[idx].arguments += d.function.arguments;
    }
  }
}

function toolAccToAnthropicToolUseBlocks(acc: Record<number, ToolCallAcc>): AnthropicToolUseBlock[] {
  const indices = Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b);
  return indices.map((i, j) => {
    const t = acc[i]!;
    const id = t.id?.trim() || `toolu_${j}_${Date.now().toString(36)}`;
    const name = t.name ?? "";
    const input = parseFunctionArgumentsJson(t.arguments);
    return { type: "tool_use" as const, id, name, input };
  });
}

function *yieldAnthropicToolUseStreamBlocks(
  tools: AnthropicToolUseBlock[],
  startIndex: number,
): Generator<string> {
  for (let i = 0; i < tools.length; i += 1) {
    const t = tools[i]!;
    const index = startIndex + i;
    yield JSON.stringify({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: t.id, name: t.name, input: {} },
    });
    const json = JSON.stringify(t.input);
    yield JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json },
    });
  }
}

/**
 * 将 OpenAI chat completion SSE 分片映射为 Anthropic 风格的 JSON 行（写入 `data:`，每条含 `type` 字段）。
 * 在流式结束时若存在 `tool_calls`，会按序输出 `tool_use` 内容块（与 OpenAI 分片顺序一致：先累积 tool，再输出 text 时先 flush tool）。
 */
export async function *streamAnthropicMessagesJsonLines(
  params: AnthropicCompatDeps & {
    request: AnthropicMessagesRequest;
    /**
     * Test hook: provide a prebuilt OpenAI chat.completion.chunk JSON stream.
     * When set, the compat layer will NOT call `streamOpenAiChatCompletion`.
     */
    openAiStream?: AsyncIterable<string>;
  },
): AsyncIterable<string> {
  const request = anthropicMessagesToOpenAiChatRequest({ ...params.request, stream: true });
  const stream = params.openAiStream ?? streamOpenAiChatCompletion({
    ...params,
    request,
  });
  const configModel = params.configStore.get().llm.model;
  const model = params.request.model ?? configModel;
  const msgId = `msg_stream_${Date.now().toString(36)}`;
  yield JSON.stringify({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
    },
  });

  const toolAcc: Record<number, ToolCallAcc> = {};
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let lastFinish: string | null | undefined;
  let nextBlockIndex = 0;
  let textBlockIndex = -1;
  let thinkingBlockIndex = -1;
  let startedText = false;
  let startedThinking = false;

  function* flushPendingTools(): Generator<string> {
    if (Object.keys(toolAcc).length === 0) {
      return;
    }
    const tools = toolAccToAnthropicToolUseBlocks(toolAcc);
    for (const k of Object.keys(toolAcc)) {
      delete toolAcc[Number(k)];
    }
    yield* yieldAnthropicToolUseStreamBlocks(tools, nextBlockIndex);
    nextBlockIndex += tools.length;
  }

  for await (const chunk of stream) {
    const parsed = JSON.parse(chunk) as {
      choices?: Array<{
        delta?: {
          content?: string;
          role?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (parsed.usage) {
      lastUsage = parsed.usage;
    }
    const delta = parsed.choices?.[0]?.delta;
    const fr = parsed.choices?.[0]?.finish_reason;
    if (fr !== undefined && fr !== null) {
      lastFinish = fr;
    }
    if (delta?.tool_calls?.length) {
      mergeToolCallDeltas(toolAcc, delta.tool_calls);
    }
    const deltaAny = delta as Record<string, unknown> | undefined;
    const reasoningText =
      (typeof deltaAny?.reasoning_content === "string" ? deltaAny.reasoning_content : undefined) ||
      (typeof deltaAny?.reasoning === "string" ? deltaAny.reasoning : undefined) ||
      (typeof deltaAny?.thinking === "string" ? deltaAny.thinking : undefined);
    if (reasoningText) {
      if (!startedThinking) {
        yield* flushPendingTools();
        yield JSON.stringify({
          type: "content_block_start",
          index: nextBlockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
        thinkingBlockIndex = nextBlockIndex;
        startedThinking = true;
        nextBlockIndex += 1;
      }
      yield JSON.stringify({
        type: "content_block_delta",
        index: thinkingBlockIndex,
        delta: { type: "thinking_delta", thinking: reasoningText },
      });
    }
    const content = delta?.content;
    if (content) {
      if (!startedText) {
        yield* flushPendingTools();
        yield JSON.stringify({
          type: "content_block_start",
          index: nextBlockIndex,
          content_block: { type: "text", text: "" },
        });
        textBlockIndex = nextBlockIndex;
        startedText = true;
        nextBlockIndex += 1;
      }
      yield JSON.stringify({
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: content },
      });
    }
  }

  if (!startedText && !startedThinking) {
    yield* flushPendingTools();
  } else if (Object.keys(toolAcc).length > 0) {
    yield* flushPendingTools();
  }

  yield JSON.stringify({
    type: "message_delta",
    delta: {
      stop_reason: mapOpenAiFinishReasonToAnthropicStopReason(lastFinish),
      usage: {
        input_tokens: lastUsage?.prompt_tokens ?? 0,
        output_tokens: lastUsage?.completion_tokens ?? 0,
      },
    },
  });
  yield JSON.stringify({ type: "message_stop" });
}
