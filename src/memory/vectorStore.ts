import { getJson, postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";

export type VectorQueryResult = {
  ids: string[];
  scores: number[];
};

export type VectorStore = {
  upsert(params: { ids: string[]; embeddings: number[][]; metadatas?: Record<string, unknown>[] }): Promise<void>;
  query(params: { embedding: number[]; topK: number; where?: Record<string, unknown> }): Promise<VectorQueryResult>;
  /** 按 id 从向量集合中删除；ids 为空则 no-op */
  deleteByIds(ids: string[]): Promise<void>;
};

export class ChromaVectorStore implements VectorStore {
  private baseUrl: string;
  private apiPath: string;
  private collectionName: string;
  private collectionId?: string;
  private timeoutMs?: number;

  constructor(params: { baseUrl: string; apiPath?: string; collection: string; timeoutMs?: number }) {
    this.baseUrl = params.baseUrl;
    this.apiPath = params.apiPath ?? "/api/v1";
    this.collectionName = params.collection;
    this.timeoutMs = params.timeoutMs;
  }

  async upsert(params: { ids: string[]; embeddings: number[][]; metadatas?: Record<string, unknown>[] }): Promise<void> {
    const collectionId = await this.ensureCollection();
    const url = joinUrl(this.baseUrl, `${this.apiPath}/collections/${collectionId}/add`);
    await postJson(
      url,
      {
        ids: params.ids,
        embeddings: params.embeddings,
        metadatas: params.metadatas,
      },
      { timeoutMs: this.timeoutMs }
    );
  }

  async query(params: { embedding: number[]; topK: number; where?: Record<string, unknown> }): Promise<VectorQueryResult> {
    const collectionId = await this.ensureCollection();
    const url = joinUrl(this.baseUrl, `${this.apiPath}/collections/${collectionId}/query`);
    const data = (await postJson(
      url,
      {
        query_embeddings: [params.embedding],
        n_results: params.topK,
        where: params.where,
      },
      { timeoutMs: this.timeoutMs }
    )) as {
      ids?: string[][];
      distances?: number[][];
    };

    const ids = data.ids?.[0] ?? [];
    const distances = data.distances?.[0] ?? [];
    const scores = ids.map((_, idx) => {
      const distance = distances[idx] ?? 1;
      return Math.max(0, 1 - distance);
    });

    return { ids, scores };
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const collectionId = await this.ensureCollection();
    const url = joinUrl(this.baseUrl, `${this.apiPath}/collections/${collectionId}/delete`);
    await chromaPostMaybeEmpty(url, { ids }, this.timeoutMs);
  }

  private async ensureCollection(): Promise<string> {
    if (this.collectionId) {
      return this.collectionId;
    }

    const listUrl = joinUrl(this.baseUrl, `${this.apiPath}/collections`);
    const list = (await getJson(listUrl, { timeoutMs: this.timeoutMs })) as Array<{ id?: string; name?: string }>;
    const found = list.find((item) => item.name === this.collectionName || item.id === this.collectionName);
    if (found?.id) {
      this.collectionId = found.id;
      return this.collectionId;
    }
    if (found?.name) {
      this.collectionId = found.name;
      return this.collectionId;
    }

    const createUrl = joinUrl(this.baseUrl, `${this.apiPath}/collections`);
    const created = (await postJson(
      createUrl,
      { name: this.collectionName, metadata: { created_by: "kgm" } },
      { timeoutMs: this.timeoutMs }
    )) as { id?: string; name?: string };
    this.collectionId = created.id ?? created.name ?? this.collectionName;
    return this.collectionId;
  }
}

async function chromaPostMaybeEmpty(url: string, body: unknown, timeoutMs?: number): Promise<void> {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = timeoutMs ? setTimeout(() => controller?.abort(), timeoutMs) : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller?.signal,
  });
  if (timeout) {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`http ${response.status}: ${text}`);
  }
  const raw = await response.text();
  if (raw.trim()) {
    try {
      JSON.parse(raw) as unknown;
    } catch {
      // ignore non-json success bodies
    }
  }
}
