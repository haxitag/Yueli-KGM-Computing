import { LlmProviderApiError, stringifyLlmProviderErrorPayload } from "./providerApiError.js";
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
            throw new LlmProviderApiError("ollama", stringifyLlmProviderErrorPayload(data.error));
        }
        return {
            text: data.message?.content ?? data.response ?? "",
            raw: data
        };
    }
    async *streamComplete(prompt, options) {
        const payload = {
            model: options?.model ?? this.model,
            messages: [
                { role: "user", content: prompt },
            ],
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
            yield { type: "started", model: options?.model ?? this.model };
            const response = await fetch(joinUrl(this.baseUrl, "/chat"), {
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
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let tokenIndex = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    try {
                        const data = JSON.parse(trimmed);
                        if (data.error) {
                            throw new LlmProviderApiError("ollama", `Stream: ${stringifyLlmProviderErrorPayload(data.error)}`);
                        }
                        if (data.message?.content) {
                            yield {
                                type: "token",
                                text: data.message.content,
                                index: tokenIndex++,
                            };
                        }
                        if (data.done) {
                            yield {
                                type: "finished",
                                result: { text: "", raw: data },
                            };
                            return;
                        }
                    }
                    catch (e) {
                        if (e instanceof LlmProviderApiError) {
                            throw e;
                        }
                        // 忽略解析错误的部分
                    }
                }
            }
        }
        finally {
            if (timeoutId)
                clearTimeout(timeoutId);
        }
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
            throw new LlmProviderApiError("slang", data.error.message);
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
