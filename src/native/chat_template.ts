/**
 * Chat template rendering aligned with common HF `tokenizer_config.json` `chat_template` behavior
 * for **no-tools** Qwen2 / Qwen2.5-style templates (subset of Jinja).
 *
 * Full `transformers` Jinja (filters, tools, vision) is not implemented; use golden tests for
 * the supported subset and extend deliberately.
 *
 * 受限 **Jinja 子集**见 `jinja_lite.ts`（`renderJinjaLite` / `applyChatTemplateJinjaLite`）。
 */

import { renderJinjaLite, type JinjaLiteContext } from "./jinja_lite.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: unknown;
};

export const QWEN_CHAT_IM_START = "<|im_start|>";
/** 与 Qwen2 / Qwen2.5 `added_tokens_decoder` 中 `151645` 一致（`<|redacted_im_end|>`） */
export const QWEN_CHAT_IM_END = "<|im_end|>";

/**
 * Qwen2.5 `chat_template` **无 tools** 分支的等价实现（与 Hub 上「仅对话、无 tool_calls」路径一致）。
 * 参考：`Qwen/Qwen2.5-*` 的 `tokenizer_config.json` 中 `chat_template` 在 `tools` 为空时的逻辑。
 */
export function applyQwen25StyleChatTemplateNoTools(params: {
  messages: ChatMessage[];
  addGenerationPrompt?: boolean;
}): string {
  const messages = params.messages;
  const addGenerationPrompt = params.addGenerationPrompt === true;
  let out = "";

  if (messages.length === 0) {
    return addGenerationPrompt ? `${QWEN_CHAT_IM_START}assistant\n` : "";
  }

  if (messages[0]!.role === "system") {
    out += `${QWEN_CHAT_IM_START}system\n${messages[0]!.content ?? ""}${QWEN_CHAT_IM_END}\n`;
  } else {
    out += `${QWEN_CHAT_IM_START}system\nYou are a helpful assistant.${QWEN_CHAT_IM_END}\n`;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const isFirst = index === 0;
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    const plainUserSystemOrAssistant =
      message.role === "user" ||
      (message.role === "system" && !isFirst) ||
      (message.role === "assistant" && !hasToolCalls);

    if (plainUserSystemOrAssistant) {
      out += `${QWEN_CHAT_IM_START}${message.role}\n${message.content ?? ""}${QWEN_CHAT_IM_END}\n`;
    }
  }

  if (addGenerationPrompt) {
    out += `${QWEN_CHAT_IM_START}assistant\n`;
  }

  return out;
}

/**
 * 与合成 smoke 中 `chat_template: "{{ messages }}"` 兼容：将消息内容简单拼接，便于回归。
 */
export function applyLiteralMessagesPlaceholder(messages: ChatMessage[], separator = "\n"): string {
  return messages.map((m) => `${m.role}: ${m.content ?? ""}`).join(separator);
}

/**
 * 使用 `jinja_lite` 渲染 Hub 风格模板；`ctx` 需包含模板引用的变量（如 `messages`、`add_generation_prompt`）。
 */
export function applyChatTemplateJinjaLite(template: string, ctx: JinjaLiteContext): string {
  return renderJinjaLite(template, ctx);
}
