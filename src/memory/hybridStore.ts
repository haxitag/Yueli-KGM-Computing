import type { Evidence } from "../core/types.js";
import type { Embedder } from "../embedding/canonical.js";
import { applyMemoryRerank } from "../rerank/applyRerank.js";
import { blendAndNormalize, bm25Scores } from "./lexicalRerank.js";
import type {
  MemoryRecordView,
  MemoryStore,
  MemoryStoreStats,
  MemorySearchOptions,
} from "./store.js";
import type { MetadataStore } from "./metadataStore.js";
import type { VectorStore } from "./vectorStore.js";

export class HybridMemoryStore implements MemoryStore {
  private vectorStore: VectorStore;
  private metadataStore: MetadataStore;

  constructor(params: { vectorStore: VectorStore; metadataStore: MetadataStore }) {
    this.vectorStore = params.vectorStore;
    this.metadataStore = params.metadataStore;
  }

  async add(chunk: {
    id: string;
    userId: string;
    text: string;
    embedding: number[];
    embeddingVersion: string;
    source: string;
    createdAt: string;
  }): Promise<void> {
    await this.vectorStore.upsert({
      ids: [chunk.id],
      embeddings: [chunk.embedding],
      metadatas: [{ userId: chunk.userId, source: chunk.source, embeddingVersion: chunk.embeddingVersion }],
    });

    await this.metadataStore.upsert({
      id: chunk.id,
      userId: chunk.userId,
      text: chunk.text,
      source: chunk.source,
      createdAt: chunk.createdAt,
    });
  }

  async search(
    userId: string,
    query: string,
    embedder: Embedder,
    topK: number,
    options?: MemorySearchOptions,
  ): Promise<Evidence[]> {
    const w = options?.lexicalWeight ?? 0;
    const overFetch = Math.max(1, Math.min(8, options?.overFetch ?? (w > 0 ? 3 : 1)));
    const fetchK = Math.max(topK, Math.min(200, Math.ceil(topK * overFetch)));
    const queryEmbedding = await embedder.embed(query);
    const result = await this.vectorStore.query({
      embedding: queryEmbedding,
      topK: fetchK,
      where: { userId },
    });

    if (result.ids.length === 0) {
      return [];
    }

    const metadata = await this.metadataStore.getMany(result.ids);
    const metadataMap = new Map(metadata.map((record) => [record.id, record]));
    const vecScores = result.scores;
    const rows = result.ids.map((id, idx) => {
      const record = metadataMap.get(id);
      return {
        id,
        text: record?.text ?? "",
        score: vecScores[idx] ?? 0,
        source: record?.source ?? "unknown",
      };
    });
    if (w <= 0) {
      if (!options?.rerank || options.rerank === "off") {
        return rows.slice(0, topK);
      }
      let out = rows;
      const cap = Math.min(out.length, Math.max(topK, Math.min(48, topK * 3)));
      out = out.slice(0, cap);
      out = await applyMemoryRerank(query, out, embedder, options);
      return out.slice(0, topK);
    }
    const blended = blendAndNormalize(
      vecScores,
      bm25Scores(
        query,
        rows.map((r) => r.text),
      ),
      w,
    );
    let withBlend = rows.map((r, i) => ({ ...r, score: blended[i] ?? r.score }));
    withBlend.sort((a, b) => b.score - a.score);
    if (!options?.rerank || options.rerank === "off") {
      return withBlend.slice(0, topK);
    }
    const cap2 = Math.min(withBlend.length, Math.max(topK, Math.min(48, topK * 3)));
    withBlend = withBlend.slice(0, cap2);
    withBlend = await applyMemoryRerank(query, withBlend, embedder, options);
    return withBlend.slice(0, topK);
  }

  async deleteByChunkId(chunkId: string): Promise<boolean> {
    const metaDeleted = await this.metadataStore.deleteById(chunkId);
    try {
      await this.vectorStore.deleteByIds([chunkId]);
    } catch {
      // 元数据已删时仍尽量删向量；向量失败不阻断「已删 SQL 行」的语义
    }
    return metaDeleted;
  }

  async getMemoryStats(): Promise<MemoryStoreStats> {
    if (typeof this.metadataStore.getStats === "function") {
      const stats = await this.metadataStore.getStats();
      return {
        backend: "hybrid",
        totalChunks: stats.totalChunks,
        userCount: stats.userCount,
        byUser: stats.byUser,
        inspectable: true,
      };
    }
    return {
      backend: "hybrid",
      totalChunks: 0,
      userCount: 0,
      byUser: [],
      inspectable: false,
    };
  }

  async listMemoryRecords(params?: {
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<MemoryRecordView[]> {
    if (typeof this.metadataStore.listRecent !== "function") {
      return [];
    }
    const rows = await this.metadataStore.listRecent(params);
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      text: r.text,
      source: r.source,
      createdAt: r.createdAt,
    }));
  }
}
