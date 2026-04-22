import type { LlmClient, CompletionOptions, CompletionResult } from "./client.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";

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
      throw new Error(`Zhipu API error: ${data.error.message} (${data.error.type})`);
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
      "MM-Device-Id": "yuli-kgm-computing",
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
      throw new Error(`Minimax API error: ${data.error.message}`);
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
      throw new Error(`OpenRouter API error: ${data.error.message}`);
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
      throw new Error(`NVIDIA API error: ${data.error.message}`);
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
      throw new Error(`DeepSeek API error: ${data.error.message}`);
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
      throw new Error(`Ollama API error: ${data.error}`);
    }

    return { 
      text: data.message?.content ?? data.response ?? "", 
      raw: data 
    };
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
      throw new Error(`vLLM API error: ${data.error.message}`);
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
 * Slang推理引擎客户端
 */
export class SlangLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private timeoutMs?: number;

  constructor(params: {
    baseUrl: string; // Slang服务的完整URL
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
    // Slang通常使用与OpenAI兼容的API
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
      throw new Error(`Slang API error: ${data.error.message}`);
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
