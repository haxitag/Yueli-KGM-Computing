import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
/**
 * 智谱AI GLM模型客户端
 */
export class ZhipuLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://open.bigmodel.cn/api/paas/v4";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
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
        const data = (await postJson(joinUrl(this.baseUrl, "/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
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
export class MinimaxLlmClient {
    baseUrl;
    model;
    apiKey;
    groupId;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://api.minimaxi.com/v1";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.groupId = params.groupId;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
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
        const data = (await postJson(joinUrl(this.baseUrl, "/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
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
export class OpenRouterLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://openrouter.ai/api/v1";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = {
            model: this.model,
            messages: [
                { role: "user", content: prompt }
            ],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
        };
        if (options?.stop) {
            payload["stop"] = options.stop;
        }
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://your-app-url.com", // 可选，用于统计
            "X-Title": "KGM-Computing", // 可选，用于统计
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
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
export class NvidiaLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = {
            model: this.model,
            messages: [
                { role: "user", content: prompt }
            ],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
        };
        if (options?.stop) {
            payload["stop"] = options.stop;
        }
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
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
export class DeepSeekLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://api.deepseek.com/v1";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = {
            model: this.model,
            messages: [
                { role: "user", content: prompt }
            ],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
        };
        if (options?.stop) {
            payload["stop"] = options.stop;
        }
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
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
export class OllamaLlmClient {
    baseUrl;
    model;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.model = params.model;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
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
        const data = (await postJson(joinUrl(this.baseUrl, "/chat"), payload, { timeoutMs: this.timeoutMs }));
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
export class VllmLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = {
            model: this.model,
            prompt,
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
        };
        const headers = {
            "Content-Type": "application/json",
        };
        if (this.apiKey) {
            headers.Authorization = `Bearer ${this.apiKey}`;
        }
        if (options?.stop) {
            payload["stop"] = options.stop;
        }
        // vLLM支持completions endpoint
        const data = (await postJson(joinUrl(this.baseUrl, "/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
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
export class SlangLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        // Slang通常使用与OpenAI兼容的API
        const payload = {
            model: this.model,
            prompt,
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
        };
        const headers = {
            "Content-Type": "application/json",
        };
        if (this.apiKey) {
            headers.Authorization = `Bearer ${this.apiKey}`;
        }
        if (options?.stop) {
            payload["stop"] = options.stop;
        }
        const endpoint = this.determineEndpoint();
        const data = (await postJson(joinUrl(this.baseUrl, endpoint), payload, { headers, timeoutMs: this.timeoutMs }));
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
    determineEndpoint() {
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
export class XiaomiLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://api.xiaomi.ai/v1";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
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
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
        if (data.error) {
            throw new Error(`Xiaomi API error: ${data.error.message}`);
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
export class GeminiLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    useOpenAIFormat;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://generativelanguage.googleapis.com";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
        this.useOpenAIFormat = params.useOpenAIFormat ?? false;
    }
    async complete(prompt, options) {
        if (this.useOpenAIFormat) {
            return this.completeWithOpenAIFormat(prompt, options);
        }
        return this.completeWithNativeFormat(prompt, options);
    }
    /**
     * 使用 OpenAI 兼容格式调用 Gemini API
     * 端点: /v1beta/openai/chat/completions
     */
    async completeWithOpenAIFormat(prompt, options) {
        const payload = {
            model: options?.model ?? this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            top_p: options?.topP,
            stop: options?.stop,
            stream: false,
        };
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/v1beta/openai/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
        if (data.error) {
            throw new Error(`Gemini API error: ${data.error.message}`);
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
    async completeWithNativeFormat(prompt, options) {
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
        const headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
        };
        const data = (await postJson(joinUrl(this.baseUrl, `/v1beta/${fullModelName}:generateContent`), payload, { headers, timeoutMs: this.timeoutMs }));
        // 检查安全拦截
        if (data.promptFeedback?.blockReason) {
            throw new Error(`Gemini content blocked: ${data.promptFeedback.blockReason}`);
        }
        if (data.error) {
            throw new Error(`Gemini API error: ${data.error.message}`);
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
export class AnthropicLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://api.anthropic.com";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = {
            model: options?.model ?? this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            top_p: options?.topP,
            stop_sequences: options?.stop,
        };
        const headers = {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/v1/messages"), payload, { headers, timeoutMs: this.timeoutMs }));
        if (data.error) {
            throw new Error(`Anthropic API error: ${data.error.message}`);
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
export class AliyunLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://dashscope.aliyuncs.com";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
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
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/api/v1/services/aigc/text-generation/generation"), payload, { headers, timeoutMs: this.timeoutMs }));
        if (data.error) {
            throw new Error(`Aliyun API error: ${data.error.message}`);
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
export class ModelScopeLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://api-inference.modelscope.cn";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = {
            model: options?.model ?? this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            top_p: options?.topP,
            stop: options?.stop,
        };
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/v1/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
        if (data.error) {
            throw new Error(`ModelScope API error: ${data.error.message}`);
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
export class MoonshotLlmClient {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl ?? "https://api.moonshot.cn";
        this.model = params.model;
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = {
            model: options?.model ?? this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            top_p: options?.topP,
            stop: options?.stop,
        };
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/v1/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs }));
        if (data.error) {
            throw new Error(`Moonshot API error: ${data.error.message}`);
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
    async longContextComplete(messages, options) {
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
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "X-Context-Window": contextWindow.toString(),
        };
        const data = (await postJson(joinUrl(this.baseUrl, "/v1/chat/completions"), payload, { headers, timeoutMs: this.timeoutMs ?? 120000 } // 超长上下文需要更长的超时
        ));
        if (data.error) {
            throw new Error(`Moonshot API error: ${data.error.message}`);
        }
        const content = data.choices?.[0]?.message?.content ?? "";
        return {
            text: content,
            raw: data,
        };
    }
}
