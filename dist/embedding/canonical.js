import { CANONICAL_EMBEDDING } from "../core/config.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
export class HashEmbedder {
    dim;
    normalize;
    constructor(dim = CANONICAL_EMBEDDING.dim, normalize = CANONICAL_EMBEDDING.normalize) {
        this.dim = dim;
        this.normalize = normalize;
    }
    async embed(text) {
        const vector = new Array(this.dim).fill(0);
        const tokens = text.split(/\s+/).filter(Boolean);
        for (const token of tokens) {
            const hash = fnv1a(token);
            const idx = Math.abs(hash % this.dim);
            vector[idx] += 1;
        }
        if (this.normalize) {
            normalizeInPlace(vector);
        }
        return vector;
    }
}
export class HttpEmbedder {
    baseUrl;
    modelName;
    path;
    apiKey;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.modelName = params.modelName ?? CANONICAL_EMBEDDING.modelName;
        this.path = params.path ?? "/embeddings";
        this.apiKey = params.apiKey;
        this.timeoutMs = params.timeoutMs;
    }
    async embed(text) {
        const url = joinUrl(this.baseUrl, this.path);
        const data = (await postJson(url, { model: this.modelName, input: text }, { headers: buildAuthHeaders(this.apiKey), timeoutMs: this.timeoutMs }));
        const embedding = data.embedding ?? data.data?.[0]?.embedding;
        if (!embedding) {
            throw new Error("embedding response missing embedding field");
        }
        return embedding;
    }
}
export class OllamaEmbedder {
    baseUrl;
    modelName;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.modelName = params.modelName ?? CANONICAL_EMBEDDING.modelName;
        this.timeoutMs = params.timeoutMs;
    }
    async embed(text) {
        const data = (await postJson(joinUrl(this.baseUrl, "/embed"), { model: this.modelName, input: text }, { timeoutMs: this.timeoutMs }));
        const embedding = data.embedding ?? data.embeddings?.[0];
        if (!embedding) {
            throw new Error("ollama embedding response missing embedding field");
        }
        return embedding;
    }
}
export class ConfigurableEmbedder {
    store;
    constructor(store) {
        this.store = store;
    }
    async embed(text) {
        const config = this.store.get().embedding;
        if (config.provider === "openai" && !config.apiKey) {
            throw new Error("embedding apiKey is required for openai provider");
        }
        const client = config.provider === "ollama"
            ? new OllamaEmbedder({
                baseUrl: config.baseUrl,
                modelName: config.model,
                timeoutMs: config.timeoutMs,
            })
            : new HttpEmbedder({
                baseUrl: config.baseUrl,
                modelName: config.model,
                path: config.path,
                apiKey: config.apiKey,
                timeoutMs: config.timeoutMs,
            });
        return client.embed(text);
    }
}
function fnv1a(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
}
function normalizeInPlace(vector) {
    let sum = 0;
    for (const value of vector) {
        sum += value * value;
    }
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < vector.length; i += 1) {
        vector[i] = vector[i] / norm;
    }
}
function buildAuthHeaders(apiKey) {
    if (!apiKey) {
        return {};
    }
    return { authorization: `Bearer ${apiKey}` };
}
