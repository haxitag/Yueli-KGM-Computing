import type { LlmIntent } from "../core/types.js";

export function parseIntent(rawText: string): LlmIntent {
  const text = stripCodeFence(rawText.trim());
  try {
    const parsed = JSON.parse(text) as LlmIntent;
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return { type: "final", content: rawText };
}

function stripCodeFence(text: string): string {
  if (text.startsWith("```")) {
    return text.replace(/^```[a-zA-Z]*\n/, "").replace(/```$/, "").trim();
  }
  return text;
}
