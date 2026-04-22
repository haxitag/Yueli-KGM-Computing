import type { Evidence } from "../core/types.js";
import type { Embedder } from "../embedding/canonical.js";
import type { MemoryStore } from "./store.js";
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

  async search(userId: string, query: string, embedder: Embedder, topK: number): Promise<Evidence[]> {
    const queryEmbedding = await embedder.embed(query);
    const result = await this.vectorStore.query({
      embedding: queryEmbedding,
      topK,
      where: { userId },
    });

    if (result.ids.length === 0) {
      return [];
    }

    const metadata = await this.metadataStore.getMany(result.ids);
    const metadataMap = new Map(metadata.map((record) => [record.id, record]));

    return result.ids.map((id, idx) => {
      const record = metadataMap.get(id);
      return {
        id,
        text: record?.text ?? "",
        score: result.scores[idx] ?? 0,
        source: record?.source ?? "unknown",
      };
    });
  }
}
