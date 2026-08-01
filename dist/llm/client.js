import { buildOpenAiChatCompletionsBody } from "./maas/openAiChatBody.js";
import { extractOpenAiCompatChoiceText, extractOpenAiCompatDeltaParts } from "./maas/reasoning.js";
import { OllamaLlmClient } from "./third-party.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
import { KgmStructuredError } from "../errors/structuredError.js";
import { protectedFetch } from "../observability/circuitBreaker.js";
import { LlmProviderApiError } from "./providerApiError.js";
export async function* streamCompletion(client, prompt, options) {
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
export class HttpLlmClient {
    baseUrl;
    model;
    path;
    apiKey;
    mode;
    timeoutMs;
    authStyle;
    /**
     * @param params.path - 相对 `baseUrl` 的路径，如 `/v1/chat/completions`；与 **`KGM_LLM_PATH`** / **`ConfigStore.llm.path`** 对齐。
     * @param params.mode - `chat` 发 messages 体，`completions` 发 prompt 体。
     * @param params.authStyle - `bearer`（默认）| `api-key`（Xiaomi MiMo curl 形）| `both`
     */
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.model = params.model;
        this.path = params.path ?? "/completions";
        this.apiKey = params.apiKey;
        this.mode = params.mode ?? "completions";
        this.timeoutMs = params.timeoutMs;
        this.authStyle = params.authStyle ?? "bearer";
    }
    async complete(prompt, options) {
        const payload = this.mode === "chat"
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
        }));
        const choice = data.choices?.[0];
        const { text } = extractOpenAiCompatChoiceText(choice);
        const resolved = text ||
            (typeof data.output_text === "string" ? data.output_text : "");
        return { text: resolved, raw: data };
    }
    async *streamComplete(prompt, options) {
        const url = joinUrl(this.baseUrl, this.path);
        const payload = this.mode === "chat"
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
        const idleMs = idleEnv !== undefined && idleEnv.trim() !== ""
            ? Number(idleEnv)
            : connectTimeoutMs;
        let connectTimer;
        let idleTimer;
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
            if (!(idleMs > 0))
                return;
            if (idleTimer)
                clearTimeout(idleTimer);
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
                let json = errorText;
                try {
                    json = errorText ? JSON.parse(errorText) : {};
                }
                catch {
                    /* keep */
                }
                const msg = json && typeof json === "object" && json.error?.message
                    ? String(json.error.message)
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
            let lastUsage;
            let lastRaw;
            const contentFields = ["content", "reasoning_content", "reasoning", "thinking", "thought", "text", "output_text"];
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                resetIdleTimer();
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
                            lastRaw = data;
                            if (data.usage && typeof data.usage === "object") {
                                lastUsage = data.usage;
                            }
                            // 检查错误响应
                            if (data.error) {
                                const errorMessage = typeof data.error === "string"
                                    ? data.error
                                    : data.error.message || JSON.stringify(data.error);
                                throw new Error(`Upstream error: ${errorMessage}`);
                            }
                            if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
                                const choice = data.choices[0];
                                const delta = choice.delta;
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
                                if (typeof data[field] === "string" && data[field].length > 0) {
                                    const channel = field === "content" || field === "text" || field === "output_text"
                                        ? "content"
                                        : "reasoning";
                                    if (channel === "content") {
                                        fullText += data[field];
                                    }
                                    yield {
                                        type: "token",
                                        text: data[field],
                                        index: tokenIndex++,
                                        channel,
                                    };
                                    break;
                                }
                            }
                        }
                        catch (error) {
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
        }
        finally {
            clearConnectTimer();
            if (idleTimer)
                clearTimeout(idleTimer);
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
                authStyle: inferLlmAuthStyle(config.baseUrl),
            });
    }
    /** Test seam: replace underlying client without going through HTTP. */
    replaceClientForTests(factory) {
        this.createClient = factory;
    }
    async complete(prompt, options) {
        const config = this.store.get().llm;
        const client = this.createClient();
        return client.complete(prompt, {
            ...options,
            maxTokens: options?.maxTokens ?? config.maxTokens,
            temperature: options?.temperature ?? config.temperature,
            model: options?.model ?? config.model,
        });
    }
    async *streamComplete(prompt, options) {
        const config = this.store.get().llm;
        const client = this.createClient();
        const merged = {
            ...options,
            maxTokens: options?.maxTokens ?? config.maxTokens,
            temperature: options?.temperature ?? config.temperature,
            model: options?.model ?? config.model,
        };
        if (client.streamComplete) {
            yield* client.streamComplete(prompt, merged);
        }
        else {
            const result = await this.complete(prompt, options);
            yield { type: "started", model: merged.model };
            if (result.text) {
                yield { type: "token", text: result.text, index: 0 };
            }
            yield { type: "finished", result };
        }
    }
}
export function buildAuthHeaders(apiKey, style = "bearer") {
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
export function inferLlmAuthStyle(baseUrl, explicit) {
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
