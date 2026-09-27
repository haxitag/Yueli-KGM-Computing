import type { LlmClient, CompletionOptions, CompletionResult, CompletionStreamEvent } from "./client.js";
import { LlmProviderApiError, stringifyLlmProviderErrorPayload } from "./providerApiError.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
import { protectedFetch } from "../observability/circuitBreaker.js";

/**
 * 智谱AI GLM模型客户端
 */
export class ZhipuLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://open.bigmodel.cn/api/paas/v4";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      stream: false,
    };

    if (options?.stop) {
      // 智谱AI可能不直接支持stop参数，需要在应用层处理
      console.warn("Zhipu AI may not support stop sequences directly");
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      error?: { message: string; type: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("zhipu", data.error.message, { upstreamCode: data.error.type });
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    
    return { 
      text: content, 
      raw: data 
    };
  }
}

/**
 * Minimax模型客户端
 */
export class MinimaxLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private groupId: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    groupId: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://api.minimaxi.com/v1";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.groupId = params.groupId;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: this.model,
      messages: [
        { role: "user", content: prompt }
      ],
      tokens_to_generate: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    };

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "MM-Device-Id": "yueli-kgm-computing",
      "MM-User-Agent": "KGM-Computing/1.0",
      "MM-Group-ID": this.groupId,
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ messages?: Array<{ content?: string }> }>;
      reply?: string;
      error?: { message: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("minimax", data.error.message);
    }

    // Minimax API响应格式可能有所不同
    const content = data.reply ?? data.choices?.[0]?.messages?.[0]?.content ?? "";

    return { 
      text: content, 
      raw: data 
    };
  }
}

/**
 * OpenRouter模型聚合商客户端
 */
export class OpenRouterLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://openrouter.ai/api/v1";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: this.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    };

    if (options?.stop) {
      (payload as any)["stop"] = options.stop;
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://your-app-url.com", // 可选，用于统计
      "X-Title": "KGM-Computing", // 可选，用于统计
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("openrouter", data.error.message);
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return { 
      text: content, 
      raw: data 
    };
  }
}

/**
 * NVIDIA模型客户端
 */
export class NvidiaLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl: string; // NVIDIA API的完整URL，例如 https://integrate.api.nvidia.com/v1
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: this.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    };

    if (options?.stop) {
      (payload as any)["stop"] = options.stop;
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("nvidia", data.error.message);
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return { 
      text: content, 
      raw: data 
    };
  }
}

/**
 * DeepSeek模型客户端
 */
export class DeepSeekLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://api.deepseek.com/v1";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: this.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    };

    if (options?.stop) {
      (payload as any)["stop"] = options.stop;
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("deepseek", data.error.message);
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return { 
      text: content, 
      raw: data 
    };
  }
}

/**
 * Ollama推理引擎客户端
 */
export class OllamaLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl: string; // Ollama服务的完整URL，例如 http://localhost:11434/api
    model: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      messages: [
        { role: "user", content: prompt },
      ],
      think: false,
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.8,
        num_predict: options?.maxTokens ?? 1024,
        stop: options?.stop,
        top_k: options?.topK,
        top_p: options?.topP,
        repeat_penalty: options?.repetitionPenalty,
        seed: options?.seed,
      },
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/chat"),
      payload,
      { timeoutMs: this.timeoutMs }
    )) as {
      message?: { content?: string };
      response?: string;
      error?: string;
    };

    if (data.error) {
      throw new LlmProviderApiError("ollama", stringifyLlmProviderErrorPayload(data.error));
    }

    return { 
      text: data.message?.content ?? data.response ?? "", 
      raw: data 
    };
  }

  async *streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    const think = options?.think === true;
    const payload = {
      model: options?.model ?? this.model,
      messages: [
        { role: "user", content: prompt },
      ],
      think,
      stream: true,
      options: {
        temperature: options?.temperature ?? 0.8,
        num_predict: options?.maxTokens ?? 1024,
        stop: options?.stop,
        top_k: options?.topK,
        top_p: options?.topP,
        repeat_penalty: options?.repetitionPenalty,
        seed: options?.seed,
      },
    };

    const controller = new AbortController();
    const timeoutId = this.timeoutMs ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const response = await protectedFetch(joinUrl(this.baseUrl, "/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const detail = errorText.length > 8000 ? `${errorText.slice(0, 8000)}…` : errorText;
        throw new LlmProviderApiError("ollama", detail || response.statusText, { httpStatus: response.status });
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new LlmProviderApiError("ollama", "No response body");
      }

      yield { type: "started", model: options?.model ?? this.model };

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let tokenIndex = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const data = JSON.parse(trimmed) as {
              message?: { content?: string; thinking?: string; reasoning?: string };
              done?: boolean;
              error?: string;
            };

            if (data.error) {
              throw new LlmProviderApiError("ollama", `Stream: ${stringifyLlmProviderErrorPayload(data.error)}`);
            }

            const msg = data.message;
            if (msg?.content) {
              yield {
                type: "token",
                text: msg.content,
                index: tokenIndex++,
                channel: "content",
              };
            }
            const reasoning =
              (typeof msg?.thinking === "string" && msg.thinking) ||
              (typeof msg?.reasoning === "string" && msg.reasoning) ||
              "";
            if (reasoning) {
              yield {
                type: "token",
                text: reasoning,
                index: tokenIndex++,
                channel: "reasoning",
              };
            }
            if (data.done) {
              yield {
                type: "finished",
                result: { text: "", raw: data },
              };
              return;
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              continue;
            }
            throw error;
          }
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

/**
 * vLLM推理引擎客户端
 */
export class VllmLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl: string; // vLLM服务的完整URL，例如 http://localhost:8000/v1
    model: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: this.model,
      prompt,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    if (options?.stop) {
      (payload as any)["stop"] = options.stop;
    }

    // vLLM支持completions endpoint
    const data = (await postJson(
      joinUrl(this.baseUrl, "/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ text?: string; message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("vllm", data.error.message);
    }

    const choice = data.choices?.[0];
    const text = choice?.text ?? choice?.message?.content ?? "";

    return { 
      text, 
      raw: data 
    };
  }
}

/**
 * SGLang 推理引擎客户端（OpenAI 兼容端点）
 */
export class SglangLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    // SGLang 通常使用与 OpenAI 兼容的 API
    const payload = {
      model: this.model,
      prompt,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    if (options?.stop) {
      (payload as any)["stop"] = options.stop;
    }

    const endpoint = this.determineEndpoint();
    const data = (await postJson(
      joinUrl(this.baseUrl, endpoint),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ text?: string; message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("sglang", data.error.message);
    }

    const choice = data.choices?.[0];
    const text = choice?.text ?? choice?.message?.content ?? "";

    return { 
      text, 
      raw: data 
    };
  }

  /**
   * 根据模型名称或URL确定使用哪个端点
   */
  private determineEndpoint(): string {
    // 如果模型名称暗示是聊天模型，使用/chat/completions
    if (this.model.includes("chat") || this.model.includes("instruct")) {
      return "/chat/completions";
    }
    // 否则使用/completions
    return "/completions";
  }
}

/**
 * 小米(Xiaomi) MiMo模型客户端
 * OpenAI兼容API格式
 */
export class XiaomiLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://api.xiaomimimo.com/v1";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      messages: [
        { role: "user", content: prompt }
      ],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP,
      stop: options?.stop,
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "api-key": this.apiKey,
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string; code?: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("xiaomi", data.error.message, {
        upstreamCode: typeof data.error.code === "string" ? data.error.code : undefined,
      });
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return {
      text: content,
      raw: data,
    };
  }
}

/**
 * Google Gemini API 客户端
 * 支持原生 Generative Language API 和 OpenAI 兼容格式
 */
export class GeminiLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;
  private useOpenAIFormat: boolean;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
    useOpenAIFormat?: boolean;
  }) {
    this.baseUrl = params.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
    this.useOpenAIFormat = params.useOpenAIFormat ?? false;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    if (this.useOpenAIFormat) {
      return this.completeWithOpenAIFormat(prompt, options);
    }
    return this.completeWithNativeFormat(prompt, options);
  }

  /**
   * 使用 OpenAI 兼容格式调用 Gemini API
   * 端点: /v1beta/openai/chat/completions
   */
  private async completeWithOpenAIFormat(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP,
      stop: options?.stop,
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/v1beta/openai/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string; code?: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("gemini", data.error.message, {
        upstreamCode: typeof data.error.code === "string" ? data.error.code : undefined,
      });
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return {
      text: content,
      raw: data,
    };
  }

  /**
   * 使用 Google 原生 Generative Language API 格式
   * 端点: /v1beta/models/{model}:generateContent
   */
  private async completeWithNativeFormat(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const modelName = options?.model ?? this.model;

    // 确保模型名称前缀正确
    const fullModelName = modelName.startsWith("models/") ? modelName : `models/${modelName}`;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 1024,
        topP: options?.topP,
        stopSequences: options?.stop,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": this.apiKey,
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, `/v1beta/${fullModelName}:generateContent`),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
          role?: string;
        };
        finishReason?: string;
      }>;
      error?: { message: string; code?: string };
      promptFeedback?: {
        blockReason?: string;
        safetyRatings?: Array<{ category: string; probability: string }>;
      };
    };

    // 检查安全拦截
    if (data.promptFeedback?.blockReason) {
      throw new LlmProviderApiError("gemini", `Content blocked: ${data.promptFeedback.blockReason}`, {
        upstreamCode: data.promptFeedback.blockReason,
      });
    }

    if (data.error) {
      throw new LlmProviderApiError("gemini", data.error.message, {
        upstreamCode: typeof data.error.code === "string" ? data.error.code : undefined,
      });
    }

    // 提取文本内容
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content = parts.map((p) => p.text ?? "").join("");

    return {
      text: content,
      raw: data,
    };
  }
}

/**
 * Anthropic Claude API 客户端
 */
export class AnthropicLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://api.anthropic.com";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP,
      stop_sequences: options?.stop,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/v1/messages"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      content?: Array<{ type: string; text?: string }>;
      error?: { message: string; type?: string };
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    if (data.error) {
      throw new LlmProviderApiError("anthropic", data.error.message, {
        upstreamCode: typeof data.error.type === "string" ? data.error.type : undefined,
      });
    }

    // 提取文本内容
    const content = data.content?.find((c) => c.type === "text")?.text ?? "";

    return {
      text: content,
      raw: data,
    };
  }
}

/**
 * 阿里云百炼 API 客户端
 */
export class AliyunLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://dashscope.aliyuncs.com";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      input: {
        messages: [{ role: "user", content: prompt }],
      },
      parameters: {
        max_tokens: options?.maxTokens ?? 1024,
        temperature: options?.temperature ?? 0.7,
        top_p: options?.topP,
        stop: options?.stop,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/api/v1/services/aigc/text-generation/generation"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      output?: { text?: string };
      error?: { message: string; code?: string };
      usage?: { input_tokens: number; output_tokens: number };
    };

    if (data.error) {
      throw new LlmProviderApiError("aliyun", data.error.message, {
        upstreamCode: typeof data.error.code === "string" ? data.error.code : undefined,
      });
    }

    return {
      text: data.output?.text ?? "",
      raw: data,
    };
  }
}

/**
 * ModelScope API 客户端
 */
export class ModelScopeLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://api-inference.modelscope.cn";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP,
      stop: options?.stop,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/v1/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string; code?: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("modelscope", data.error.message, {
        upstreamCode: typeof data.error.code === "string" ? data.error.code : undefined,
      });
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return {
      text: content,
      raw: data,
    };
  }
}

/**
 * Moonshot AI (Kimi) LLM Client
 * 支持 Kimi 2.6 等模型，超长上下文 (2M tokens)
 */
export class MoonshotLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl?: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl ?? "https://api.moonshot.cn";
    this.model = params.model;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload = {
      model: options?.model ?? this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP,
      stop: options?.stop,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/v1/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs }
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string; code?: string };
    };

    if (data.error) {
      throw new LlmProviderApiError("moonshot", data.error.message, {
        upstreamCode: typeof data.error.code === "string" ? data.error.code : undefined,
      });
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return {
      text: content,
      raw: data,
    };
  }

  /**
   * Kimi 2.6 特有功能：超长上下文处理
   * 支持高达 2M tokens 的上下文窗口
   */
  async longContextComplete(
    messages: Array<{ role: string; content: string }>,
    options?: CompletionOptions & { contextWindow?: number }
  ): Promise<CompletionResult> {
    const contextWindow = options?.contextWindow ?? 2000000; // 默认 2M

    const payload = {
      model: options?.model ?? this.model,
      messages,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP,
      stop: options?.stop,
      // Kimi 2.6 特有参数
      context_window: contextWindow,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "X-Context-Window": contextWindow.toString(),
    };

    const data = (await postJson(
      joinUrl(this.baseUrl, "/v1/chat/completions"),
      payload,
      { headers, timeoutMs: this.timeoutMs ?? 120000 } // 超长上下文需要更长的超时
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string; code?: string };
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    if (data.error) {
      throw new LlmProviderApiError("moonshot", data.error.message, {
        upstreamCode: typeof data.error.code === "string" ? data.error.code : undefined,
      });
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return {
      text: content,
      raw: data,
    };
  }
}

export { LlmProviderApiError, stringifyLlmProviderErrorPayload } from "./providerApiError.js";