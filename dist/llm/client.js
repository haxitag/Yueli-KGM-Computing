import { OllamaLlmClient } from "./third-party.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
import { KgmStructuredError } from "../errors/structuredError.js";
export async function* streamCompletion(client, prompt, options) {
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
export class HttpLlmClient {
    baseUrl;
    model;
    path;
    apiKey;
    mode;
    timeoutMs;
    /**
     * @param params.path - 相对 `baseUrl` 的路径，如 `/v1/chat/completions`；与 **`KGM_LLM_PATH`** / **`ConfigStore.llm.path`** 对齐。
     * @param params.mode - `chat` 发 messages 体，`completions` 发 prompt 体。
     */
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.model = params.model;
        this.path = params.path ?? "/completions";
        this.apiKey = params.apiKey;
        this.mode = params.mode ?? "completions";
        this.timeoutMs = params.timeoutMs;
    }
    async complete(prompt, options) {
        const payload = this.mode === "chat"
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
        }));
        const choice = data.choices?.[0];
        const firstNonEmpty = (...cands) => {
            for (const c of cands) {
                if (typeof c === "string" && c.trim().length > 0)
                    return c;
            }
            return "";
        };
        // 兼容 reasoning-only 模型：部分 OpenAI-compat 返回 content=""，而真正输出在 message.reasoning/thinking
        const text = firstNonEmpty(data.output_text, choice?.text, choice?.message?.content, choice?.message?.reasoning, choice?.message?.thinking);
        return { text, raw: data };
    }
    async *streamComplete(prompt, options) {
        const url = joinUrl(this.baseUrl, this.path);
        const payload = this.mode === "chat"
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
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    if (trimmed.startsWith("data: ")) {
                        const dataStr = trimmed.slice(6);
                        if (dataStr === "[DONE]") {
                            break;
                        }
                        try {
                            const data = JSON.parse(dataStr);
                            let content = "";
                            // 尝试从多种可能的字段中提取内容
                            if (data.choices?.[0]) {
                                const choice = data.choices[0];
                                if (choice.delta) {
                                    content = choice.delta.content || choice.delta.reasoning_content || choice.delta.text || "";
                                }
                                else {
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
                        }
                        catch {
                            // Ignore JSON parse errors for incomplete chunks
                        }
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
export class ConfigurableLlmClient {
    store;
    constructor(store) {
        this.store = store;
    }
    createClient() {
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
    async complete(prompt, options) {
        const config = this.store.get().llm;
        const client = this.createClient();
        return client.complete(prompt, {
            maxTokens: options?.maxTokens ?? config.maxTokens,
            temperature: options?.temperature ?? config.temperature,
            stop: options?.stop,
            model: options?.model ?? config.model,
        });
    }
    async *streamComplete(prompt, options) {
        const config = this.store.get().llm;
        const client = this.createClient();
        if (client.streamComplete) {
            yield* client.streamComplete(prompt, {
                maxTokens: options?.maxTokens ?? config.maxTokens,
                temperature: options?.temperature ?? config.temperature,
                stop: options?.stop,
                model: options?.model ?? config.model,
            });
        }
        else {
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
function buildAuthHeaders(apiKey) {
    if (!apiKey) {
        return {};
    }
    return { authorization: `Bearer ${apiKey}` };
}
