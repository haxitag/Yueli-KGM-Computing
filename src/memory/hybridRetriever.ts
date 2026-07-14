import { CANONICAL_EMBEDDING } from "../core/config.js";
import type { Embedder } from "../embedding/canonical.js";
import type { Evidence, MemoryChunk } from "./store.js";
import { buildMemoryChunk } from "./store.js";
import { getFrontStation } from "../frontstation/factory.js";

/**
 * 混合检索结果
 */
export interface HybridRetrievalResult {
  sparse: BM25Result[];
  dense: VectorResult[];
  fused: RankedResult[];
  metadata: {
    query: string;
    retrievalTimeMs: number;
    sparseCount: number;
    denseCount: number;
    fusedCount: number;
  };
}

/**
 * BM25结果
 */
export interface BM25Result {
  id: string;
  score: number;
  text: string;
  source: string;
  terms: string[];
}

/**
 * 向量检索结果
 */
export interface VectorResult {
  id: string;
  score: number;
  text: string;
  source: string;
}

/**
 * 融合排序结果
 */
export interface RankedResult {
  id: string;
  score: number;
  text: string;
  source: string;
  sparseScore: number;
  denseScore: number;
  queryTerms?: string[];
}

/**
 * 重排序结果
 */
export interface RerankedResult {
  id: string;
  score: number;
  text: string;
  source: string;
  originalScore: number;
  rerankTimeMs: number;
}

/**
 * 记忆检索配置
 */
export interface MemoryRetrievalConfig {
  // 检索参数
  sparseTopK?: number;
  denseTopK?: number;
  fusedTopK?: number;
  bm25K1?: number;
  bm25B?: number;
  
  // 重排序参数
  enableReranking?: boolean;
  rerankTopK?: number;
  rerankModel?: string;
  
  // 查询扩展参数
  enableQueryExpansion?: boolean;
  expansionStrategies?: ("hyde" | "symmetric" | "keywords")[];
  expansionCount?: number;
  
  // 缓存参数
  enableCache?: boolean;
  cacheSize?: number;
  cacheTTL?: number;
  
  // 记忆压缩参数
  enableCompression?: boolean;
  compressionThreshold?: number;
}

/**
 * 智能记忆检索器
 * 
 * 核心功能:
 * 1. 混合检索(BM25 + Embedding)
 * 2. Cross-Encoder重排序
 * 3. 查询扩展(HyDE、对称改写、关键词)
 * 4. 记忆压缩与去重
 */
export class HybridMemoryRetriever {
  private memoryStore: Map<string, MemoryChunk[]>;
  private embedder: Embedder;
  private config: Required<MemoryRetrievalConfig>;
  
  // BM25索引
  private bm25Index: BM25Index;
  
  // 查询缓存
  private queryCache: LRUCache<string, HybridRetrievalResult>;
  
  // 性能统计
  private stats = {
    totalQueries: 0,
    totalRetrievalTime: 0,
    cacheHits: 0,
    avgSparseScore: 0,
    avgDenseScore: 0,
    avgRerankScore: 0,
  };

  constructor(
    memoryStore: Map<string, MemoryChunk[]>,
    embedder: Embedder,
    config?: MemoryRetrievalConfig,
  ) {
    this.memoryStore = memoryStore;
    this.embedder = embedder;
    
    // 默认配置
    this.config = {
      sparseTopK: 50,
      denseTopK: 50,
      fusedTopK: 10,
      bm25K1: 1.2,
      bm25B: 0.75,
      enableReranking: true,
      rerankTopK: 20,
      rerankModel: "cross-encoder-ms-marco-MiniLM-L-6-v2",
      enableQueryExpansion: true,
      expansionStrategies: ["hyde", "keywords"],
      expansionCount: 3,
      enableCache: true,
      cacheSize: 1000,
      cacheTTL: 3600000, // 1小时
      enableCompression: true,
      compressionThreshold: 0.9,
      ...config,
    };
    
    // 初始化BM25索引
    this.bm25Index = new BM25Index(this.memoryStore, {
      k1: this.config.bm25K1,
      b: this.config.bm25B,
    });
    
    // 初始化查询缓存
    this.queryCache = new LRUCache(this.config.cacheSize);
  }

  /**
   * 混合检索
   */
  async retrieve(
    userId: string,
    query: string,
    topK: number = 10,
  ): Promise<Evidence[]> {
    const startTime = Date.now();
    this.stats.totalQueries++;

    // 检查缓存
    if (this.config.enableCache) {
      const cached = this.queryCache.get(query);
      if (cached) {
        this.stats.cacheHits++;
        return this.convertToEvidence(cached.fused.slice(0, topK));
      }
    }

    // 1. 查询扩展
    const expandedQueries = await this.expandQuery(query);
    
    // 2. 并行执行稀疏检索和稠密检索
    const [sparseResults, denseResults] = await Promise.all([
      this.sparseRetrieve(userId, query, this.config.sparseTopK),
      this.denseRetrieve(userId, query, this.config.denseTopK),
    ]);

    // 3. 融合排序(RRF)
    const fusedResults = this.fuseResults(sparseResults, denseResults);
    
    // 4. 重排序(如果启用)
    let rankedResults = fusedResults;
    if (this.config.enableReranking) {
      rankedResults = await this.rerank(query, fusedResults, this.config.rerankTopK);
    }

    // 5. 记忆压缩与去重
    const compressedResults = this.config.enableCompression
      ? await this.compressMemories(rankedResults)
      : rankedResults;

    // 6. 构建结果
    const retrievalResult: HybridRetrievalResult = {
      sparse: sparseResults,
      dense: denseResults,
      fused: compressedResults.slice(0, this.config.fusedTopK),
      metadata: {
        query,
        retrievalTimeMs: Date.now() - startTime,
        sparseCount: sparseResults.length,
        denseCount: denseResults.length,
        fusedCount: compressedResults.length,
      },
    };

    // 7. 缓存结果
    if (this.config.enableCache) {
      this.queryCache.set(query, retrievalResult, this.config.cacheTTL);
    }

    // 8. 更新统计
    this.updateStats(retrievalResult);

    return this.convertToEvidence(compressedResults.slice(0, topK));
  }

  /**
   * 查询扩展
   */
  private async expandQuery(
    query: string,
  ): Promise<string[]> {
    if (!this.config.enableQueryExpansion || this.config.expansionStrategies.length === 0) {
      return [query];
    }

    const queries = [query];
    const expansionStrategies = this.config.expansionStrategies;

    for (const strategy of expansionStrategies.slice(0, this.config.expansionCount)) {
      let expandedQuery = query;

      switch (strategy) {
        case "hyde":
          // Hypothetical Document Embeddings
          expandedQuery = await this.expandWithHyde(query);
          break;
        case "symmetric":
          // 对称改写
          expandedQuery = await this.expandWithSymmetric(query);
          break;
        case "keywords":
          // 关键词提取
          expandedQuery = this.expandWithKeywords(query);
          break;
      }

      if (expandedQuery !== query) {
        queries.push(expandedQuery);
      }
    }

    return queries;
  }

  /**
   * HyDE扩展：无 LLM 时用前站意图原型词构造假设性文档（可关/换 HTTP）
   */
  private async expandWithHyde(query: string): Promise<string> {
    const classified = await getFrontStation().intent.classify(query);
    return [
      query,
      `假设相关文档主题：${classified.intent}`,
      `置信度 ${classified.confidence.toFixed(3)}`,
      ...Object.entries(classified.scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v.toFixed(3)}`),
    ].join("\n");
  }

  /**
   * 对称改写：本地浅层 — 保留关键 token 并附加意图标签
   */
  private async expandWithSymmetric(query: string): Promise<string> {
    const classified = await getFrontStation().intent.classify(query);
    const terms = this.tokenize(query);
    return `${terms.join(" ")} | intent:${classified.intent}`;
  }

  /**
   * 关键词扩展
   */
  private expandWithKeywords(query: string): string {
    const terms = this.tokenize(query);
    return terms.join(" ");
  }

  /**
   * 稀疏检索(BM25)
   */
  private async sparseRetrieve(
    userId: string,
    query: string,
    topK: number,
  ): Promise<BM25Result[]> {
    const terms = this.tokenize(query);
    const chunks = this.memoryStore.get(userId) ?? [];

    const scored = chunks.map((chunk) => {
      const score = this.bm25Index.score(chunk, terms);
      return {
        id: chunk.id,
        score,
        text: chunk.text,
        source: chunk.source,
        terms: terms.filter((term) => chunk.text.toLowerCase().includes(term)),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * 稠密检索(Embedding)
   */
  private async denseRetrieve(
    userId: string,
    query: string,
    topK: number,
  ): Promise<VectorResult[]> {
    const queryVector = await this.embedder.embed(query);
    const chunks = this.memoryStore.get(userId) ?? [];

    const scored = chunks.map((chunk) => {
      const score = cosineSimilarity(queryVector, chunk.embedding);
      return {
        id: chunk.id,
        score,
        text: chunk.text,
        source: chunk.source,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * 融合排序(RRF)
   */
  private fuseResults(
    sparse: BM25Result[],
    dense: VectorResult[],
  ): RankedResult[] {
    const scoreMap = new Map<string, RankedResult>();

    // RRF k值
    const k = 60;

    // 处理稀疏结果
    sparse.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      scoreMap.set(result.id, {
        id: result.id,
        score: rrfScore,
        text: result.text,
        source: result.source,
        sparseScore: result.score,
        denseScore: 0,
        queryTerms: result.terms,
      });
    });

    // 处理稠密结果
    dense.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.score += rrfScore;
        existing.denseScore = result.score;
      } else {
        scoreMap.set(result.id, {
          id: result.id,
          score: rrfScore,
          text: result.text,
          source: result.source,
          sparseScore: 0,
          denseScore: result.score,
        });
      }
    });

    return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * 重排序
   */
  private async rerank(
    query: string,
    results: RankedResult[],
    topK: number,
  ): Promise<RankedResult[]> {
    const ce = await getFrontStation().reranker.rerank(
      query,
      results.map((r) => ({ id: r.id, text: r.text })),
      topK,
    );
    const byId = new Map(results.map((r) => [r.id, r]));
    return ce.results.map((hit) => {
      const original = byId.get(hit.id);
      return {
        id: hit.id,
        score: hit.score,
        text: hit.text || original?.text || "",
        source: original?.source ?? "rerank",
        sparseScore: original?.sparseScore ?? 0,
        denseScore: original?.denseScore ?? 0,
        queryTerms: original?.queryTerms,
      };
    });
  }

  /**
   * 记忆压缩与去重
   */
  private async compressMemories(results: RankedResult[]): Promise<RankedResult[]> {
    if (results.length === 0) {
      return results;
    }

    const compressed: RankedResult[] = [];
    const used = new Set<string>();

    for (const result of results) {
      if (used.has(result.id)) {
        continue;
      }

      // 检查是否有相似的记忆
      let isDuplicate = false;
      for (const existing of compressed) {
        const similarity = this.computeTextSimilarity(result.text, existing.text);
        if (similarity > this.config.compressionThreshold) {
          // 合并到已有记忆
          existing.score = Math.max(existing.score, result.score);
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        compressed.push(result);
        used.add(result.id);
      }
    }

    return compressed;
  }

  /**
   * 计算文本相似度
   */
  private computeTextSimilarity(text1: string, text2: string): number {
    const tokens1 = new Set(this.tokenize(text1));
    const tokens2 = new Set(this.tokenize(text2));

    const intersection = new Set([...tokens1].filter((x) => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);

    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * 更新统计
   */
  private updateStats(result: HybridRetrievalResult): void {
    this.stats.totalRetrievalTime += result.metadata.retrievalTimeMs;

    if (result.fused.length > 0) {
      this.stats.avgSparseScore =
        this.stats.avgSparseScore +
        (result.sparse.reduce((sum, r) => sum + r.score, 0) / result.sparse.length) /
        this.stats.totalQueries;

      this.stats.avgDenseScore =
        this.stats.avgDenseScore +
        (result.dense.reduce((sum, r) => sum + r.score, 0) / result.dense.length) /
        this.stats.totalQueries;

      this.stats.avgRerankScore =
        this.stats.avgRerankScore +
        (result.fused.reduce((sum, r) => sum + r.score, 0) / result.fused.length) /
        this.stats.totalQueries;
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalQueries: this.stats.totalQueries,
      avgRetrievalTimeMs:
        this.stats.totalQueries > 0
          ? this.stats.totalRetrievalTime / this.stats.totalQueries
          : 0,
      cacheHitRate:
        this.stats.totalQueries > 0
          ? this.stats.cacheHits / this.stats.totalQueries
          : 0,
      avgSparseScore: this.stats.avgSparseScore,
      avgDenseScore: this.stats.avgDenseScore,
      avgRerankScore: this.stats.avgRerankScore,
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.queryCache.clear();
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = {
      totalQueries: 0,
      totalRetrievalTime: 0,
      cacheHits: 0,
      avgSparseScore: 0,
      avgDenseScore: 0,
      avgRerankScore: 0,
    };
  }

  /**
   * 转换为Evidence格式
   */
  private convertToEvidence(results: RankedResult[]): Evidence[] {
    return results.map((result) => ({
      id: result.id,
      text: result.text,
      score: result.score,
      source: result.source,
    }));
  }

  /**
   * 分词
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }
}

/**
 * BM25索引
 */
class BM25Index {
  private index: Map<string, Map<string, number>>;
  private docLengths: Map<string, number>;
  private avgDocLength: number;
  private k1: number;
  private b: number;

  constructor(
    memoryStore: Map<string, MemoryChunk[]>,
    options: { k1: number; b: number },
  ) {
    this.index = new Map();
    this.docLengths = new Map();
    this.k1 = options.k1;
    this.b = options.b;

    this.buildIndex(memoryStore);
  }

  private buildIndex(memoryStore: Map<string, MemoryChunk[]>): void {
    const allDocs: MemoryChunk[] = [];
    for (const chunks of memoryStore.values()) {
      allDocs.push(...chunks);
    }

    // 计算文档长度
    const totalLength = allDocs.reduce((sum, doc) => {
      const terms = this.tokenize(doc.text);
      const length = terms.length;
      this.docLengths.set(doc.id, length);
      return sum + length;
    }, 0);

    this.avgDocLength = totalLength / allDocs.length;

    // 构建倒排索引
    allDocs.forEach((doc) => {
      const terms = this.tokenize(doc.text);
      const termCounts = new Map<string, number>();

      terms.forEach((term) => {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      });

      termCounts.forEach((count, term) => {
        if (!this.index.has(term)) {
          this.index.set(term, new Map());
        }
        this.index.get(term)!.set(doc.id, count);
      });
    });
  }

  score(doc: MemoryChunk, queryTerms: string[]): number {
    const docLength = this.docLengths.get(doc.id) ?? 0;
    let score = 0;

    queryTerms.forEach((term) => {
      const termDocs = this.index.get(term);
      if (!termDocs || !termDocs.has(doc.id)) {
        return;
      }

      const df = termDocs.size;
      const tf = termDocs.get(doc.id)!;
      const idf = Math.log((this.docLengths.size - df + 0.5) / (df + 0.5) + 1);

      const numerator = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));

      score += idf * (numerator / denominator);
    });

    return score;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }
}

/**
 * LRU缓存
 */
class LRUCache<K, V> {
  private cache: Map<K, { value: V; expiresAt: number }>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  set(key: K, value: V, ttl: number = 3600000): void {
    // 清理过期项
    this.cleanup();

    // 检查是否超出限制
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // 重新插入以更新顺序
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  clear(): void {
    this.cache.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * 余弦相似度
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
