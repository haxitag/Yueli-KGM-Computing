import type { ConfigStore } from "../core/configStore.js";
import type { RoutingHints } from "../core/types.js";
import { OllamaLlmClient } from "./third-party.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
import { KgmStructuredError } from "../errors/structuredError.js";

/**
 * 进程内「上游 LLM」访问统一走 **HTTP + OpenAI Chat/Completions 形 JSON**：
 * - **`HttpLlmClient`**：`baseUrl` + `path` + `mode`（与 **`ConfigurableLlmClient`** / **`KGM_LLM_*`** 一致），见 **`docs/deployment-and-api.md`**（Provider config）、**`docs/yueli-kgm-engine-vs-ollama-vllm-sglang.md`**、**`docs/runtime-layer.md`**。
 * - **Anthropic `/v1/messages`**：在 **`src/anthropic/compat.ts`** 转为 OpenAI Chat 请求后再调用同一 **`LlmClient`**，不另设专用 HTTP 客户端类。
 * - **Ollama**：仍用 **`OllamaLlmClient`**（非 OpenAI 路径）。
 */

export type CompletionOptions = {
  model?: string;
  requestId?: string;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  seed?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  taskInput?: string;
  taskType?: string;
  taskName?: string;
  routing?: RoutingHints;
};

export type CompletionResult = {
  text: string;
  raw: unknown;
};

export type CompletionStreamEvent =
  | {
      type: "started";
      model?: string;
    }
  | {
      type: "token";
      text: string;
      index: number;
      tokenId?: number;
    }
  | {
      type: "finished";
      result: CompletionResult;
    };

export type LlmClient = {
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
  streamComplete?(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent>;
};

export async function* streamCompletion(
  client: LlmClient,
  prompt: string,
  options?: CompletionOptions,
): AsyncIterable<CompletionStreamEvent> {
  if (client.streamComplete) {
    yield* client.streamComplete(prompt, options);
    return;
  }

  yield {
    type: "started",
    model: options?.model,
  };
  const result = await client.complete(prompt, options);
  if (result.text) {
    yield {
      type: "token",
      text: result.text,
      index: 0,
    };
  }
  yield {
    type: "finished",
    result,
  };
}

export class HttpLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private path: string;
  private apiKey?: string;
  private mode: "completions" | "chat";
  private timeoutMs?: number;

  /**
   * @param params.path - 相对 `baseUrl` 的路径，如 `/v1/chat/completions`；与 **`KGM_LLM_PATH`** / **`ConfigStore.llm.path`** 对齐。
   * @param params.mode - `chat` 发 messages 体，`completions` 发 prompt 体。
   */
  constructor(params: {
    baseUrl: string;
    model: string;
    path?: string;
    apiKey?: string;
    mode?: "completions" | "chat";
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.path = params.path ?? "/completions";
    this.apiKey = params.apiKey;
    this.mode = params.mode ?? "completions";
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload =
      this.mode === "chat"
        ? {
            model: options?.model ?? this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
          }
        : {
            model: options?.model ?? this.model,
            prompt,
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
          };

    const data = (await postJson(joinUrl(this.baseUrl, this.path), payload, {
      headers: buildAuthHeaders(this.apiKey),
      timeoutMs: this.timeoutMs,
    })) as {
      choices?: Array<{ text?: string; message?: { content?: string; reasoning?: string; thinking?: string } }>;
      output_text?: string;
    };

    const choice = data.choices?.[0];
    const firstNonEmpty = (...cands: Array<unknown>) => {
      for (const c of cands) {
        if (typeof c === "string" && c.trim().length > 0) return c;
      }
      return "";
    };

    // 兼容 reasoning-only 模型：部分 OpenAI-compat 返回 content=""，而真正输出在 message.reasoning/thinking
    const text = firstNonEmpty(
      data.output_text,
      choice?.text,
      choice?.message?.content,
      choice?.message?.reasoning,
      choice?.message?.thinking,
    );
    return { text, raw: data };
  }

  async* streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    const url = joinUrl(this.baseUrl, this.path);
    const payload =
      this.mode === "chat"
        ? {
            model: options?.model ?? this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
            stream: true,
          }
        : {
            model: options?.model ?? this.model,
            prompt,
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
            stream: true,
          };

    const controller = new AbortController();
    const timeoutId = this.timeoutMs ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      yield { type: "started", model: options?.model ?? this.model };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(this.apiKey),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder("utf-8");
      let tokenIndex = 0;
      let buffer = "";
      const contentFields = ["content", "reasoning_content", "reasoning", "thinking", "thought", "text", "output_text"];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") {
              break;
            }
            try {
              const data = JSON.parse(dataStr);
              
              // 检查错误响应
              if (data.error) {
                const errorMessage = typeof data.error === "string" 
                  ? data.error 
                  : data.error.message || JSON.stringify(data.error);
                throw new Error(`Upstream error: ${errorMessage}`);
              }
              
              let content = "";
              
              // 尝试从多种可能的字段中提取内容
              if (data.choices?.[0]) {
                const choice = data.choices[0];
                if (choice.delta) {
                  content = choice.delta.content || choice.delta.reasoning_content || choice.delta.text || "";
                } else {
                  content = choice.text || "";
                }
              }
              // 也尝试直接从根级字段提取
              if (!content) {
                for (const field of contentFields) {
                  if (typeof data[field] === "string") {
                    content = data[field];
                    break;
                  }
                }
              }
              
              if (content) {
                yield {
                  type: "token",
                  text: content,
                  index: tokenIndex++,
                };
              }
            } catch (error) {
              // 只忽略 JSON 解析错误（不完整的块），其他错误需要抛出
              if (error instanceof SyntaxError) {
                // JSON 解析错误，可能是数据块不完整，继续等待更多数据
                continue;
              }
              // 重新抛出非 JSON 解析错误（如上游错误）
              throw error;
            }
          }
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

export class ConfigurableLlmClient implements LlmClient {
  private store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
  }

  private createClient(): LlmClient {
    const config = this.store.get().llm;
    if (config.provider === "openai" && !config.apiKey) {
      throw new KgmStructuredError({
        code: "LLM_API_KEY_MISSING",
        message: "LLM provider is openai but apiKey is missing",
        type: "kgm_configuration_error",
        param: "KGM_LLM_API_KEY",
        status: 500,
        stage: "inference.llm_provider",
        path: "llmProvider",
        routeAttempted: true,
        suggestedFix: "Set KGM_LLM_API_KEY, or point KGM_LLM_BASE_URL to an OpenAI-compatible local engine.",
        affectedFeatures: ["chat", "completions", "responses"],
      });
    }
    return config.provider === "ollama"
      ? new OllamaLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          timeoutMs: config.timeoutMs,
        })
      : new HttpLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          path: config.path,
          apiKey: config.apiKey,
          mode: config.mode,
          timeoutMs: config.timeoutMs,
        });
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const config = this.store.get().llm;
    const client = this.createClient();
    return client.complete(prompt, {
      maxTokens: options?.maxTokens ?? config.maxTokens,
      temperature: options?.temperature ?? config.temperature,
      stop: options?.stop,
      model: options?.model ?? config.model,
    });
  }

  async* streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    const config = this.store.get().llm;
    const client = this.createClient();
    if (client.streamComplete) {
      yield* client.streamComplete(prompt, {
        maxTokens: options?.maxTokens ?? config.maxTokens,
        temperature: options?.temperature ?? config.temperature,
        stop: options?.stop,
        model: options?.model ?? config.model,
      });
    } else {
      // Fallback to non-streaming if stream isn't supported
      yield { type: "started", model: options?.model ?? config.model };
      const result = await this.complete(prompt, options);
      if (result.text) {
        yield { type: "token", text: result.text, index: 0 };
      }
      yield { type: "finished", result };
    }
  }
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  return { authorization: `Bearer ${apiKey}` };
}
