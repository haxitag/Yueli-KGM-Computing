import { getJson, postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";

export type VectorQueryResult = {
  ids: string[];
  scores: number[];
};

export type VectorStore = {
  upsert(params: { ids: string[]; embeddings: number[][]; metadatas?: Record<string, unknown>[] }): Promise<void>;
  query(params: { embedding: number[]; topK: number; where?: Record<string, unknown> }): Promise<VectorQueryResult>;
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
