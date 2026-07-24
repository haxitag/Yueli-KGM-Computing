import { CANONICAL_EMBEDDING } from "../core/config.js";
import type { Evidence } from "../core/types.js";
import type { Embedder } from "../embedding/canonical.js";
import { applyMemoryRerank } from "../rerank/applyRerank.js";
import { blendAndNormalize, bm25Scores } from "./lexicalRerank.js";

export type MemoryChunk = {
  id: string;
  userId: string;
  text: string;
  embedding: number[];
  embeddingVersion: string;
  source: string;
  createdAt: string;
  lastAccessedAt: string;
};

export type MemorySearchOptions = {
  /**
   * 先召回 `ceil(topK * overFetch)` 条，再做 BM25 混合；1 表示不放大。
   * hybrid 时默认 3。
   */
  overFetch?: number;
  /** 0~1，BM25 与向量分的混合权重；0 为纯向量。 */
  lexicalWeight?: number;
  rerank?: "off" | "embed" | "http";
  /** 重排分与上阶段分混合，默认 0.5 */
  rerankBlend?: number;
};

export type MemoryStore = {
  add(chunk: MemoryChunk): Promise<void>;
  search(
    userId: string,
    query: string,
    embedder: Embedder,
    topK: number,
    options?: MemorySearchOptions,
  ): Promise<Evidence[]>;
  /**
   * 按记忆块 id 删除（任意 userId 下首个匹配）。向量后端等未实现时返回 false。
   */
  deleteByChunkId(chunkId: string): Promise<boolean>;
};

/** 可观测：列表与统计（InMemory / Hybrid 已实现；其它后端按需扩展） */
export type MemoryRecordView = {
  id: string;
  userId: string;
  text: string;
  source: string;
  createdAt: string;
  lastAccessedAt?: string;
};

export type MemoryStoreStats = {
  backend: string;
  totalChunks: number;
  userCount: number;
  byUser: Array<{ userId: string; chunks: number }>;
  maxChunksPerUser?: number;
  maxTotalChunks?: number;
  evictionPolicy?: string;
  inspectable: boolean;
};

export type InspectableMemoryStore = MemoryStore & {
  getMemoryStats(): Promise<MemoryStoreStats>;
  listMemoryRecords(params?: {
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<MemoryRecordView[]>;
};

export function isInspectableMemoryStore(store: MemoryStore): store is InspectableMemoryStore {
  const candidate = store as Partial<InspectableMemoryStore>;
  return (
    typeof candidate.getMemoryStats === "function" &&
    typeof candidate.listMemoryRecords === "function"
  );
}

export type MemoryStoreConfig = {
  maxChunksPerUser?: number;
  maxTotalChunks?: number;
  evictionPolicy?: "lru" | "fifo";
};

export class InMemoryStore implements MemoryStore {
  private store = new Map<string, MemoryChunk[]>();
  private maxChunksPerUser: number;
  private maxTotalChunks: number;
  private evictionPolicy: "lru" | "fifo";

  constructor(config?: MemoryStoreConfig) {
    const parseEnvInt = (name: string, defaultValue: number): number => {
      const value = process.env[name];
      if (value) {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed) && parsed > 0) {
          return parsed;
        }
      }
      return defaultValue;
    };

    this.maxChunksPerUser = config?.maxChunksPerUser ?? parseEnvInt("KGM_MEMORY_MAX_CHUNKS_PER_USER", 1000);
    this.maxTotalChunks = config?.maxTotalChunks ?? parseEnvInt("KGM_MEMORY_MAX_TOTAL_CHUNKS", 10000);
    
    const policy = config?.evictionPolicy ?? process.env.KGM_MEMORY_EVICTION_POLICY;
    this.evictionPolicy = (policy === "fifo" || policy === "lru") ? policy : "lru";
  }

  private getTotalChunks(): number {
    let total = 0;
    this.store.forEach((list) => {
      total += list.length;
    });
    return total;
  }

  private evictOldest(list: MemoryChunk[]): MemoryChunk[] {
    if (this.evictionPolicy === "lru") {
      return [...list].sort((a, b) => new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime());
    }
    return [...list].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  private enforceLimits(): void {
    // 首先检查每个用户的限制
    this.store.forEach((list, userId) => {
      if (list.length > this.maxChunksPerUser) {
        const sorted = this.evictOldest(list);
        const trimmed = sorted.slice(-this.maxChunksPerUser);
        this.store.set(userId, trimmed);
      }
    });

    // 然后检查总体限制
    let total = this.getTotalChunks();
    if (total > this.maxTotalChunks) {
      // 创建所有块的列表并按策略排序
      const allChunks: { userId: string; chunk: MemoryChunk }[] = [];
      this.store.forEach((list, userId) => {
        list.forEach((chunk) => {
          allChunks.push({ userId, chunk });
        });
      });

      const sorted = allChunks.sort((a, b) => {
        if (this.evictionPolicy === "lru") {
          return new Date(a.chunk.lastAccessedAt).getTime() - new Date(b.chunk.lastAccessedAt).getTime();
        }
        return new Date(a.chunk.createdAt).getTime() - new Date(b.chunk.createdAt).getTime();
      });

      // 删除最旧的块直到总量达标
      const toRemove = sorted.slice(0, total - this.maxTotalChunks);
      const removeSet = new Set(toRemove.map((item) => `${item.userId}:${item.chunk.id}`));

      this.store.forEach((list, userId) => {
        const filtered = list.filter((chunk) => !removeSet.has(`${userId}:${chunk.id}`));
        this.store.set(userId, filtered);
      });
    }
  }

  async add(chunk: MemoryChunk): Promise<void> {
    const now = new Date().toISOString();
    const chunkWithAccessTime = { ...chunk, lastAccessedAt: now };
    
    const list = this.store.get(chunk.userId) ?? [];
    list.push(chunkWithAccessTime);
    this.store.set(chunk.userId, list);
    
    this.enforceLimits();
  }

  async search(
    userId: string,
    query: string,
    embedder: Embedder,
    topK: number,
    options?: MemorySearchOptions,
  ): Promise<Evidence[]> {
    let list = this.store.get(userId) ?? [];
    if (list.length === 0) {
      return [];
    }

    const w = options?.lexicalWeight ?? 0;
    const overFetch = Math.max(1, Math.min(8, options?.overFetch ?? (w > 0 ? 3 : 1)));
    const fetchN = Math.min(list.length, Math.max(topK, Math.ceil(topK * overFetch)));

    const queryVector = await embedder.embed(query);
    const scored = list.map((item) => ({
      item,
      score: cosineSimilarity(queryVector, item.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    const take = scored.slice(0, fetchN);
    
    // 更新访问时间
    const now = new Date().toISOString();
    take.forEach(({ item }) => {
      item.lastAccessedAt = now;
    });

    const texts = take.map((e) => e.item.text);
    const vec = take.map((e) => e.score);
    const blended =
      w > 0
        ? blendAndNormalize(vec, bm25Scores(query, texts), w)
        : vec;

    let out = take
      .map((row, i) => ({
        id: row.item.id,
        text: row.item.text,
        score: blended[i] ?? row.score,
        source: row.item.source,
      }))
      .sort((a, b) => b.score - a.score);
    if (!options?.rerank || options.rerank === "off") {
      return out.slice(0, topK);
    }
    const cap = Math.min(out.length, Math.max(topK, Math.min(48, topK * 3)));
    out = out.slice(0, cap);
    out = await applyMemoryRerank(query, out, embedder, options);
    return out.slice(0, topK);
  }

  async deleteByChunkId(chunkId: string): Promise<boolean> {
    let removed = false;
    this.store.forEach((list, userId) => {
      const next = list.filter((c) => c.id !== chunkId);
      if (next.length !== list.length) {
        removed = true;
        this.store.set(userId, next);
      }
    });
    return removed;
  }

  async getMemoryStats(): Promise<MemoryStoreStats> {
    const byUser: Array<{ userId: string; chunks: number }> = [];
    this.store.forEach((list, userId) => {
      byUser.push({ userId, chunks: list.length });
    });
    byUser.sort((a, b) => b.chunks - a.chunks);
    return {
      backend: "in_memory",
      totalChunks: this.getTotalChunks(),
      userCount: this.store.size,
      byUser,
      maxChunksPerUser: this.maxChunksPerUser,
      maxTotalChunks: this.maxTotalChunks,
      evictionPolicy: this.evictionPolicy,
      inspectable: true,
    };
  }

  async listMemoryRecords(params?: {
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<MemoryRecordView[]> {
    const limit = Math.max(1, Math.min(200, params?.limit ?? 50));
    const offset = Math.max(0, params?.offset ?? 0);
    const rows: MemoryRecordView[] = [];
    this.store.forEach((list, userId) => {
      if (params?.userId && userId !== params.userId) {
        return;
      }
      for (const chunk of list) {
        rows.push({
          id: chunk.id,
          userId: chunk.userId,
          text: chunk.text,
          source: chunk.source,
          createdAt: chunk.createdAt,
          lastAccessedAt: chunk.lastAccessedAt,
        });
      }
    });
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return rows.slice(offset, offset + limit);
  }
}

export function buildMemoryChunk(params: {
  id: string;
  userId: string;
  text: string;
  embedding: number[];
  source: string;
  embeddingVersion?: string;
}): MemoryChunk {
  const now = new Date().toISOString();
  return {
    id: params.id,
    userId: params.userId,
    text: params.text,
    embedding: params.embedding,
    embeddingVersion: params.embeddingVersion ?? CANONICAL_EMBEDDING.version,
    source: params.source,
    createdAt: now,
    lastAccessedAt: now,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
