import type { LlmIntent } from "../core/types.js";
import { parseIntent } from "./parser.js";

export type NativeToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) {
    return raw;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

/** Extract OpenAI-style message.tool_calls from a chat.completions raw body. */
export function extractNativeToolCalls(raw: unknown): NativeToolCall[] {
  if (!isRecord(raw)) {
    return [];
  }
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  const choice = choices[0];
  if (!isRecord(choice)) {
    return [];
  }
  const message = isRecord(choice.message) ? choice.message : undefined;
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const out: NativeToolCall[] = [];
  for (const item of toolCalls) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    out.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name,
      arguments: parseArguments(fn?.arguments),
    });
  }
  return out;
}

export function nativeToolCallToIntent(
  call: NativeToolCall,
  skillNames?: string[],
): LlmIntent {
  if (call.name === "invoke_skill" && typeof call.arguments.skill === "string") {
    return {
      type: "invoke_skill",
      skill: call.arguments.skill,
      input: isRecord(call.arguments.input) ? call.arguments.input : { ...call.arguments, skill: undefined },
    };
  }
  if (skillNames?.includes(call.name)) {
    return {
      type: "invoke_skill",
      skill: call.name,
      input: call.arguments,
    };
  }
  return {
    type: "call",
    target: call.name,
    arguments: call.arguments,
  };
}

/**
 * Prefer native OpenAI tool_calls; fall back to text JSON parseIntent.
 * When multiple tool_calls are present, returns the first (loop continues next round).
 */
export function resolveCompletionIntent(
  completion: { text: string; raw: unknown },
  options?: { skillNames?: string[] },
): { intent: LlmIntent; source: "native_tool_calls" | "text_json" } {
  const native = extractNativeToolCalls(completion.raw);
  if (native.length > 0) {
    return {
      intent: nativeToolCallToIntent(native[0]!, options?.skillNames),
      source: "native_tool_calls",
    };
  }
  return {
    intent: parseIntent(completion.text),
    source: "text_json",
  };
}

export function toOpenAiFunctionTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema?.type ? tool.inputSchema : {
        type: "object",
        properties: tool.inputSchema ?? {},
      },
    },
  }));
}
