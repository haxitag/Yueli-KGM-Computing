import type { ConfigStore } from "../core/configStore.js";
import type { RoutingHints } from "../core/types.js";
import type { MaaSChatMessage, MaaSOpenAiChatExtras, MaaSOutputConfig, MaaSThinkingParam } from "./maas/types.js";
import { buildOpenAiChatCompletionsBody } from "./maas/openAiChatBody.js";
import { extractOpenAiCompatChoiceText, extractOpenAiCompatDeltaParts } from "./maas/reasoning.js";
import { OllamaLlmClient } from "./third-party.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
import { KgmStructuredError } from "../errors/structuredError.js";
import { protectedFetch } from "../observability/circuitBreaker.js";
import { LlmProviderApiError } from "./providerApiError.js";

/**
 * 进程内「上游 LLM」访问统一走 **HTTP + OpenAI Chat/Completions 形 JSON**：
 * - **`HttpLlmClient`**：`baseUrl` + `path` + `mode`（与 **`ConfigurableLlmClient`** / **`KGM_LLM_*`** 一致），见 **`docs/deployment-and-api.md`**（Provider config）、**`docs/yueli-kgm-engine-vs-ollama-vllm-sglang.md`**、**`docs/runtime-layer.md`**。
 * - **Anthropic `/v1/messages`**：在 **`src/anthropic/compat.ts`** 转为 OpenAI Chat 请求后再调用同一 **`LlmClient`**，不另设专用 HTTP 客户端类。
 * - **Ollama**：仍用 **`OllamaLlmClient`**（非 OpenAI 路径）。
 */

/** Upstream auth header style. Xiaomi MiMo docs use `api-key`; OpenAI SDK uses Bearer. */
export type LlmAuthStyle = "bearer" | "api-key" | "both";

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
  /** Ollama /v1/chat：默认 false，与 Copilot KGMAdapter 对齐 */
  think?: boolean;
  /** 多轮 messages（优先于 prompt 单条 user） */
  messages?: MaaSChatMessage[];
  tools?: unknown[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  responseFormat?: Record<string, unknown>;
  /** GLM / OpenAI / 部分 MaaS thinking 参数 */
  thinking?: MaaSThinkingParam;
  enableThinking?: boolean;
  reasoningEffort?: string;
  outputConfig?: MaaSOutputConfig;
  maasExtras?: MaaSOpenAiChatExtras;
  extraBody?: Record<string, unknown>;
};

export type StreamTokenChannel = "content" | "reasoning";

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
      /** 默认 content；reasoning 映射到 SSE delta.reasoning_content */
      channel?: StreamTokenChannel;
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

  const result = await client.complete(prompt, options);
  yield {
    type: "started",
    model: options?.model,
  };
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
  private authStyle: LlmAuthStyle;

  /**
   * @param params.path - 相对 `baseUrl` 的路径，如 `/v1/chat/completions`；与 **`KGM_LLM_PATH`** / **`ConfigStore.llm.path`** 对齐。
   * @param params.mode - `chat` 发 messages 体，`completions` 发 prompt 体。
   * @param params.authStyle - `bearer`（默认）| `api-key`（Xiaomi MiMo curl 形）| `both`
   */
  constructor(params: {
    baseUrl: string;
    model: string;
    path?: string;
    apiKey?: string;
    mode?: "completions" | "chat";
    timeoutMs?: number;
    authStyle?: LlmAuthStyle;
  }) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.path = params.path ?? "/completions";
    this.apiKey = params.apiKey;
    this.mode = params.mode ?? "completions";
    this.timeoutMs = params.timeoutMs;
    this.authStyle = params.authStyle ?? "bearer";
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload =
      this.mode === "chat"
        ? buildOpenAiChatCompletionsBody({
            model: options?.model ?? this.model,
            prompt,
            messages: options?.messages,
            stream: false,
            maxTokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
            topP: options?.topP,
            options,
          })
        : {
            model: options?.model ?? this.model,
            prompt,
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
          };

    const data = (await postJson(joinUrl(this.baseUrl, this.path), payload, {
      headers: buildAuthHeaders(this.apiKey, this.authStyle),
      timeoutMs: this.timeoutMs,
    })) as {
      choices?: Array<Record<string, unknown>>;
      output_text?: string;
    };

    const choice = data.choices?.[0];
    const { text } = extractOpenAiCompatChoiceText(choice);
    const resolved =
      text ||
      (typeof data.output_text === "string" ? data.output_text : "");
    return { text: resolved, raw: data };
  }

  async* streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    const url = joinUrl(this.baseUrl, this.path);
    const payload =
      this.mode === "chat"
        ? buildOpenAiChatCompletionsBody({
            model: options?.model ?? this.model,
            prompt,
            messages: options?.messages,
            stream: true,
            maxTokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
            topP: options?.topP,
            options,
          })
        : {
            model: options?.model ?? this.model,
            prompt,
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
            stream: true,
          };

    const controller = new AbortController();
    const connectTimeoutMs = this.timeoutMs ?? 0;
    const idleEnv = process.env.KGM_STREAM_IDLE_MS;
    const idleMs =
      idleEnv !== undefined && idleEnv.trim() !== ""
        ? Number(idleEnv)
        : connectTimeoutMs;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    if (connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);
    }
    const clearConnectTimer = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };
    const resetIdleTimer = () => {
      if (!(idleMs > 0)) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleMs);
    };

    try {
      // 先建连再发 started，确保上游不可达时 headers 前失败 → JSON 502
      const response = await protectedFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(this.apiKey, this.authStyle),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearConnectTimer();
      if (!response.ok) {
        const errorText = await response.text();
        let json: unknown = errorText;
        try {
          json = errorText ? JSON.parse(errorText) : {};
        } catch {
          /* keep */
        }
        const msg =
          json && typeof json === "object" && (json as { error?: { message?: string } }).error?.message
            ? String((json as { error: { message: string } }).error.message)
            : errorText.slice(0, 500) || `Upstream failed with HTTP ${response.status}`;
        throw new LlmProviderApiError("http-llm", msg, { httpStatus: response.status });
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      yield { type: "started", model: options?.model ?? this.model };
      resetIdleTimer();

      const decoder = new TextDecoder("utf-8");
      let tokenIndex = 0;
      let buffer = "";
      let fullText = "";
      let lastUsage: Record<string, unknown> | undefined;
      let lastRaw: Record<string, unknown> | undefined;
      const contentFields = ["content", "reasoning_content", "reasoning", "thinking", "thought", "text", "output_text"];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdleTimer();

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
              const data = JSON.parse(dataStr) as Record<string, unknown>;
              lastRaw = data;
              if (data.usage && typeof data.usage === "object") {
                lastUsage = data.usage as Record<string, unknown>;
              }
              
              // 检查错误响应
              if (data.error) {
                const errorMessage = typeof data.error === "string" 
                  ? data.error 
                  : (data.error as { message?: string }).message || JSON.stringify(data.error);
                throw new Error(`Upstream error: ${errorMessage}`);
              }
              
              if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
                const choice = data.choices[0] as Record<string, unknown>;
                const delta = choice.delta as Record<string, unknown> | undefined;
                if (delta) {
                  const { content, reasoning } = extractOpenAiCompatDeltaParts(delta);
                  if (content) {
                    fullText += content;
                    yield {
                      type: "token",
                      text: content,
                      index: tokenIndex++,
                      channel: "content",
                    };
                  }
                  if (reasoning) {
                    yield {
                      type: "token",
                      text: reasoning,
                      index: tokenIndex++,
                      channel: "reasoning",
                    };
                  }
                  continue;
                }
                const plain = choice.text;
                if (typeof plain === "string" && plain.length > 0) {
                  fullText += plain;
                  yield { type: "token", text: plain, index: tokenIndex++, channel: "content" };
                }
                continue;
              }
              for (const field of contentFields) {
                if (typeof data[field] === "string" && (data[field] as string).length > 0) {
                  const channel: StreamTokenChannel =
                    field === "content" || field === "text" || field === "output_text"
                      ? "content"
                      : "reasoning";
                  if (channel === "content") {
                    fullText += data[field] as string;
                  }
                  yield {
                    type: "token",
                    text: data[field] as string,
                    index: tokenIndex++,
                    channel,
                  };
                  break;
                }
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

      yield {
        type: "finished",
        result: {
          text: fullText,
          raw: {
            ...(lastRaw ?? {}),
            ...(lastUsage ? { usage: lastUsage } : {}),
            choices: [{ message: { role: "assistant", content: fullText } }],
          },
        },
      };
    } finally {
      clearConnectTimer();
      if (idleTimer) clearTimeout(idleTimer);
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
          authStyle: inferLlmAuthStyle(config.baseUrl),
        });
  }

  /** Test seam: replace underlying client without going through HTTP. */
  replaceClientForTests(factory: () => LlmClient): void {
    (this as unknown as { createClient: () => LlmClient }).createClient = factory;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const config = this.store.get().llm;
    const client = this.createClient();
    return client.complete(prompt, {
      ...options,
      maxTokens: options?.maxTokens ?? config.maxTokens,
      temperature: options?.temperature ?? config.temperature,
      model: options?.model ?? config.model,
    });
  }

  async* streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    const config = this.store.get().llm;
    const client = this.createClient();
    const merged: CompletionOptions = {
      ...options,
      maxTokens: options?.maxTokens ?? config.maxTokens,
      temperature: options?.temperature ?? config.temperature,
      model: options?.model ?? config.model,
    };
    if (client.streamComplete) {
      yield* client.streamComplete(prompt, merged);
    } else {
      const result = await this.complete(prompt, options);
      yield { type: "started", model: merged.model };
      if (result.text) {
        yield { type: "token", text: result.text, index: 0 };
      }
      yield { type: "finished", result };
    }
  }
}

export function buildAuthHeaders(
  apiKey?: string,
  style: LlmAuthStyle = "bearer",
): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  if (style === "api-key") {
    return { "api-key": apiKey };
  }
  if (style === "both") {
    return {
      authorization: `Bearer ${apiKey}`,
      "api-key": apiKey,
    };
  }
  return { authorization: `Bearer ${apiKey}` };
}

/** Infer auth style from base URL / env (MiMo OpenAPI / Token Plan). */
export function inferLlmAuthStyle(baseUrl?: string, explicit?: unknown): LlmAuthStyle {
  if (explicit === "bearer" || explicit === "api-key" || explicit === "both") {
    return explicit;
  }
  const env = process.env.KGM_LLM_AUTH_STYLE?.trim().toLowerCase();
  if (env === "bearer" || env === "api-key" || env === "both") {
    return env;
  }
  const url = (baseUrl || "").toLowerCase();
  if (url.includes("xiaomimimo.com") || url.includes("api.xiaomi.ai")) {
    return "both";
  }
  return "bearer";
}
