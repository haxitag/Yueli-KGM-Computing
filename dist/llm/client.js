import { OllamaLlmClient } from "./third-party.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
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
        const text = data.output_text ?? choice?.text ?? choice?.message?.content ?? "";
        return { text, raw: data };
    }
}
export class ConfigurableLlmClient {
    store;
    constructor(store) {
        this.store = store;
    }
    async complete(prompt, options) {
        const config = this.store.get().llm;
        if (config.provider === "openai" && !config.apiKey) {
            throw new Error("llm apiKey is required for openai provider");
        }
        const client = config.provider === "ollama"
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
export class MockLlmClient {
    async complete(prompt) {
        const input = extractUserInput(prompt).toLowerCase();
        let text = "";
        const hasToolResults = !prompt.includes("\"toolResults\": []");
        if (hasToolResults) {
            text = JSON.stringify({ type: "final", content: "ok_after_tool" });
        }
        else if (input.includes("weather") || input.includes("forecast") || input.includes("tianqi")) {
            text = JSON.stringify({ type: "call", target: "get_weather", arguments: { location: "auto" } });
        }
        else if (input.includes("search") || input.includes("lookup")) {
            text = JSON.stringify({ type: "call", target: "search_web", arguments: { query: input, top_k: 3 } });
        }
        else {
            text = JSON.stringify({ type: "final", content: "ok" });
        }
        return { text, raw: { mock: true } };
    }
}
function extractUserInput(prompt) {
    const marker = "\n  \"input\":";
    const idx = prompt.indexOf(marker);
    if (idx === -1) {
        return "";
    }
    const slice = prompt.slice(idx + marker.length);
    const match = slice.match(/\s*\"([^\"]+)\"/);
    return match?.[1] ?? "";
}
function buildAuthHeaders(apiKey) {
    if (!apiKey) {
        return {};
    }
    return { authorization: `Bearer ${apiKey}` };
}
