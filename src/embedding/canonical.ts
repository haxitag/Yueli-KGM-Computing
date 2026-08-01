import { CANONICAL_EMBEDDING } from "../core/config.js";
import type { ConfigStore } from "../core/configStore.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
import { KgmStructuredError } from "../errors/structuredError.js";

export type Embedder = {
  embed(text: string): Promise<number[]>;
};

export class HashEmbedder implements Embedder {
  private dim: number;
  private normalize: boolean;

  constructor(dim = CANONICAL_EMBEDDING.dim, normalize = CANONICAL_EMBEDDING.normalize) {
    this.dim = dim;
    this.normalize = normalize;
  }

  async embed(text: string): Promise<number[]> {
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

export class HttpEmbedder implements Embedder {
  private baseUrl: string;
  private modelName: string;
  private path: string;
  private apiKey?: string;
  private timeoutMs?: number;

  constructor(params: { baseUrl: string; modelName?: string; path?: string; apiKey?: string; timeoutMs?: number }) {
    this.baseUrl = params.baseUrl;
    this.modelName = params.modelName ?? CANONICAL_EMBEDDING.modelName;
    this.path = params.path ?? "/embeddings";
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs;
  }

  async embed(text: string): Promise<number[]> {
    const url = joinUrl(this.baseUrl, this.path);
    const data = (await postJson(
      url,
      { model: this.modelName, input: text },
      { headers: buildAuthHeaders(this.apiKey), timeoutMs: this.timeoutMs }
    )) as { embedding?: number[]; data?: Array<{ embedding: number[] }> };

    const embedding = data.embedding ?? data.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error("embedding response missing embedding field");
    }
    return embedding;
  }
}

export class OllamaEmbedder implements Embedder {
  private baseUrl: string;
  private modelName: string;
  private timeoutMs?: number;

  constructor(params: { baseUrl: string; modelName?: string; timeoutMs?: number }) {
    this.baseUrl = params.baseUrl;
    this.modelName = params.modelName ?? CANONICAL_EMBEDDING.modelName;
    this.timeoutMs = params.timeoutMs;
  }

  async embed(text: string): Promise<number[]> {
    const data = (await postJson(
      joinUrl(this.baseUrl, "/embed"),
      { model: this.modelName, input: text },
      { timeoutMs: this.timeoutMs }
    )) as { embeddings?: number[][]; embedding?: number[] };

    const embedding = data.embedding ?? data.embeddings?.[0];
    if (!embedding) {
      throw new Error("ollama embedding response missing embedding field");
    }
    return embedding;
  }
}

export class ConfigurableEmbedder implements Embedder {
  private store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
  }

  async embed(text: string): Promise<number[]> {
    const config = this.store.get().embedding;
    if (config.provider === "openai" && !config.apiKey) {
      throw new KgmStructuredError({
        code: "EMBEDDING_API_KEY_MISSING",
        message: "Embedding provider is openai but apiKey is missing",
        type: "kgm_configuration_error",
        param: "KGM_EMBEDDING_API_KEY",
        status: 500,
        stage: "context.memory_search",
        path: "llmProvider",
        routeAttempted: true,
        suggestedFix: "Set KGM_EMBEDDING_* environment variables, or disable memory retrieval via options.memory=false",
        affectedFeatures: ["memory_search", "rag", "context_builder"],
      });
    }
    const client =
      config.provider === "ollama"
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

function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function normalizeInPlace(vector: number[]): void {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = vector[i] / norm;
  }
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  return { authorization: `Bearer ${apiKey}` };
}
