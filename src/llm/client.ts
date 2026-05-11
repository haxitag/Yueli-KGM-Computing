import type { ConfigStore } from "../core/configStore.js";
import type { RoutingHints } from "../core/types.js";
import { OllamaLlmClient } from "./third-party.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
import { KgmStructuredError } from "../errors/structuredError.js";

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
}

export class ConfigurableLlmClient implements LlmClient {
  private store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
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
    const client =
      config.provider === "ollama"
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
    return client.complete(prompt, {
      maxTokens: options?.maxTokens ?? config.maxTokens,
      temperature: options?.temperature ?? config.temperature,
      stop: options?.stop,
      model: options?.model ?? config.model,
    });
  }
}

export class OpenAILlmClient implements LlmClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs?: number;

  constructor(params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
  }) {
    this.apiKey = params.apiKey;
    this.model = params.model ?? "gpt-4o-mini";
    this.baseUrl = params.baseUrl ?? "https://api.openai.com/v1";
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const url = `${this.baseUrl}/chat/completions`;
    
    const payload = {
      model: options?.model ?? this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      stop: options?.stop,
      top_p: options?.topP ?? 1,
      presence_penalty: 0,
      frequency_penalty: 0,
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timeoutId = this.timeoutMs ? setTimeout(() => controller?.abort(), this.timeoutMs) : undefined;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      
      return {
        text: content,
        raw: data,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async* streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    const url = `${this.baseUrl}/chat/completions`;
    
    const payload = {
      model: options?.model ?? this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      stop: options?.stop,
      top_p: options?.topP ?? 1,
      stream: true,
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timeoutId = this.timeoutMs ? setTimeout(() => controller?.abort(), this.timeoutMs) : undefined;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder("utf-8");
      let tokenIndex = 0;

      yield { type: "started", model: options?.model ?? this.model };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(line => line.trim() !== "");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") {
              return;
            }
            try {
              const data = JSON.parse(dataStr);
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                yield {
                  type: "token",
                  text: content,
                  index: tokenIndex++,
                };
              }
            } catch {
              // Ignore JSON parse errors for incomplete chunks
            }
          }
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  return { authorization: `Bearer ${apiKey}` };
}
