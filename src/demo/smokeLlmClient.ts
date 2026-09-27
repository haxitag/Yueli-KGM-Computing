/**
 * 供 `openai_compat_smoke.ts` 使用的离线确定性 LLM：不访问外网，行为与 E2E harness 中
 * `DeterministicTestLlmClient` 对齐（触发 search_web 意图等）。
 */
import type { CompletionResult, CompletionStreamEvent, LlmClient } from "../llm/client.js";

export class SmokeCompatibilityLlmClient implements LlmClient {
  async complete(prompt: string): Promise<CompletionResult> {
    /** 工具已执行一轮后，会话块会出现 `N. tool(...)`；避免再次命中 market/trend 触发无限 tool round。 */
    if (/\d+\.\s+tool\(/.test(prompt)) {
      return {
        text: JSON.stringify({
          type: "final",
          content: "Smoke ok: tool results summarized.",
        }),
        raw: {},
      };
    }
    const toolMatch = prompt.match(/search_web|web_search|market.*trend|查找|搜索/);
    if (toolMatch) {
      return {
        text: JSON.stringify({
          type: "call",
          target: "search_web",
          arguments: { query: prompt },
        }),
        raw: {},
      };
    }
    return {
      text: JSON.stringify({
        type: "final",
        content: `Smoke ok: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`,
      }),
      raw: {},
    };
  }

  async *streamComplete(prompt: string): AsyncIterable<CompletionStreamEvent> {
    yield { type: "started", model: "smoke-test-model" };
    const response = await this.complete(prompt);
    for (let index = 0; index < response.text.length; index += 12) {
      yield {
        type: "token",
        text: response.text.slice(index, Math.min(index + 12, response.text.length)),
        index,
      };
    }
    yield { type: "finished", result: response };
  }
}
