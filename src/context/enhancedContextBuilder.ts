import { DEFAULT_CONSTRAINTS, DEFAULT_TOOL_POLICY } from "../core/config.js";
import type { ContextPack, Evidence, KgmRequest, KgmGraphTriple, Signal } from "../core/types.js";
import type { Embedder } from "../embedding/canonical.js";
import type { GraphStore } from "../graph/store.js";
import { memorySearchOptionsFromKgm } from "../memory/retrievalOptions.js";
import type { MemoryStore } from "../memory/store.js";
import { generateId } from "../utils/id.js";
import type { ContextConfig } from "../core/configStore.js";
import type { ArtifactStore } from "./artifactStore.js";
import type { SessionStore } from "./sessionStore.js";
import type { YcbClient } from "../ycb/client.js";
import { LRUCache } from "../utils/cache.js";

export type ContextQualityEvent = {
  timestamp: string;
  user_id?: string;
  recall_topk: number;
  hit_rate: number;
  embedding_version?: string;
};

export type ContextQualityReporter = (event: ContextQualityEvent) => void;

/**
 * ContextPack缓存键
 * 只包含稳定部分,不包含动态部分(userInput, sessionHistory)
 */
interface ContextPackCacheKey {
  systemPrompt?: string;
  toolPolicy?: { allowed: string[]; maxRounds?: number };
  graphEnabled: boolean;
  embeddingVersion?: string;
}

/**
 * Context构建性能指标
 */
export interface ContextBuildMetrics {
  buildTimeMs: number;
  memoryRetrievalTimeMs?: number;
  graphQueryTimeMs?: number;
  sessionRetrievalTimeMs?: number;
  fromCache: boolean;
}

/**
 * 增强型ContextBuilder
 * 
 * 核心优化:
 * 1. 并行化记忆检索、图谱查询、多模态处理
 * 2. ContextPack级别的缓存
 * 3. 性能监控与优化建议
 */
export class EnhancedContextBuilder {
  private memoryStore: MemoryStore;
  private embedder: Embedder;
  private topK: number;
  private reportContextQuality?: ContextQualityReporter;
  private embeddingVersion?: string;
  private contextConfig?: ContextConfig;
  private artifactStore?: ArtifactStore;
  private sessionStore?: SessionStore;
  private graphStore?: GraphStore;
  private ycbClient?: YcbClient;

  // ContextPack缓存
  private contextCache: LRUCache<ContextPackCacheKey, Partial<ContextPack>>;
  private cacheHitCount = 0;
  private cacheMissCount = 0;

  // 性能指标
  private metrics: ContextBuildMetrics[] = [];
  private maxMetricsHistory = 1000;

  constructor(params: {
    memoryStore: MemoryStore;
    embedder: Embedder;
    topK?: number;
    reportContextQuality?: ContextQualityReporter;
    embeddingVersion?: string;
    contextConfig?: ContextConfig;
    artifactStore?: ArtifactStore;
    sessionStore?: SessionStore;
    graphStore?: GraphStore;
    ycbClient?: YcbClient;
    cacheSize?: number;  // ContextPack缓存大小
  }) {
    this.memoryStore = params.memoryStore;
    this.embedder = params.embedder;
    this.topK = params.topK ?? 5;
    this.reportContextQuality = params.reportContextQuality;
    this.embeddingVersion = params.embeddingVersion;
    this.contextConfig = params.contextConfig;
    this.artifactStore = params.artifactStore;
    this.sessionStore = params.sessionStore;
    this.graphStore = params.graphStore;
    this.ycbClient = params.ycbClient;

    // 初始化缓存 (默认100个)
    this.contextCache = new LRUCache<ContextPackCacheKey, Partial<ContextPack>>({
      maxSize: params.cacheSize ?? 100,
    });
  }

  /**
   * 构建ContextPack (并行化版本)
   */
  async build(request: KgmRequest): Promise<ContextPack> {
    const startTime = Date.now();
    const requestId = request.requestId ?? generateId();
    const sessionId = request.sessionId ?? request.userId;

    // 1. 生成缓存键
    const cacheKey = this.buildCacheKey(request);
    const cachedContext = this.contextCache.get(cacheKey);
    const ycbActive = Boolean(this.ycbClient?.shouldAttempt(request));
    const fromCache = Boolean(cachedContext) && !ycbActive;

    // 2. 并行执行独立的检索操作（YCB 动态上下文不进入缓存键，命中缓存时仍合并本轮 YCB）
    const [graphSignal, memoryEvidence, sessionRef, ycbEvidence] = await Promise.all([
      this.buildGraphSignal(request),
      fromCache ? Promise.resolve([] as Evidence[]) : this.retrieveEvidence(request),
      fromCache && cachedContext?.session_ref
        ? Promise.resolve(cachedContext.session_ref)
        : this.retrieveSessionRef(sessionId),
      this.ycbClient ? this.ycbClient.fetchEvidence(request) : Promise.resolve([] as Evidence[]),
    ]);

    let evidence: Evidence[];
    if (fromCache) {
      evidence = [...ycbEvidence, ...(cachedContext?.evidence ?? [])];
    } else {
      evidence = [...ycbEvidence, ...memoryEvidence];
    }
    evidence = this.applyEvidenceBudget(evidence);

    // 3. 添加图谱三元组 (如果有)
    if (this.graphStore && request.kgm?.graph?.triples?.length) {
      await this.graphStore.addTriples({
        triples: request.kgm.graph.triples,
        source: "request.kgm.graph",
        namespace: request.userId,
      });
    }

    // 4. 构建信号
    const signals = buildSignals(request.signals ?? [], graphSignal);

    // 5. 应用工具策略
    const toolPolicy = this.applyToolPolicy(request.toolPolicy, Boolean(graphSignal));

    // 6. 质量报告
    if (this.reportContextQuality) {
      this.reportQuality(evidence, request);
    }

    // 7. 构建最终ContextPack
    const contextPack: ContextPack = {
      requestId,
      userId: request.userId,
      sessionId,
      session_ref: sessionRef,
      input: request.input,
      signals: sanitizeSignals(signals),
      conversation: sanitizeConversation(request.conversation),
      evidence,
      constraints: { ...DEFAULT_CONSTRAINTS, ...request.constraints },
      toolPolicy,
      toolResults: [],
      kgm: request.kgm,
    };

    // 8. 更新缓存 (仅缓存稳定部分)
    if (!fromCache) {
      this.contextCache.set(cacheKey, {
        toolPolicy,
        evidence,  // 缓存证据以加速后续检索
        session_ref: sessionRef,
      });
    }

    // 9. 记录性能指标
    this.recordMetrics({
      buildTimeMs: Date.now() - startTime,
      fromCache,
    });

    return contextPack;
  }

  /**
   * 并行构建图谱信号
   */
  private async buildGraphSignal(request: KgmRequest): Promise<Signal | null> {
    if (!this.graphStore || !request.kgm?.graph?.enabled) {
      return null;
    }

    const startTime = Date.now();
    const signal = await buildKnowledgeGraphSignal(
      this.graphStore,
      request.kgm.graph,
      request.input,
      request.userId,
    );

    const duration = Date.now() - startTime;
    
    // 记录到指标
    this.metrics[this.metrics.length - 1] = {
      ...this.metrics[this.metrics.length - 1],
      graphQueryTimeMs: duration,
    };

    return signal;
  }

  /**
   * 并行检索记忆
   */
  private async retrieveEvidence(request: KgmRequest): Promise<Evidence[]> {
    const startTime = Date.now();
    const retrievalTopK = request.kgm?.retrieval?.topK ?? this.topK;
    
    const memOpts = memorySearchOptionsFromKgm(request.kgm?.retrieval);
    const evidence = await this.memoryStore.search(
      request.userId,
      request.input,
      this.embedder,
      retrievalTopK,
      memOpts,
    );

    const duration = Date.now() - startTime;
    
    // 记录到指标
    this.metrics[this.metrics.length - 1] = {
      ...this.metrics[this.metrics.length - 1],
      memoryRetrievalTimeMs: duration,
    };

    return evidence;
  }

  /**
   * 并行检索会话历史
   */
  private async retrieveSessionRef(sessionId: string) {
    const startTime = Date.now();
    
    const rawSessionRef = this.sessionStore
      ? this.sessionStore.getRef(sessionId, this.contextConfig?.sessionPreviewChars ?? 240)
      : undefined;
    const sessionRef = rawSessionRef && rawSessionRef.sizeBytes > 0 ? rawSessionRef : undefined;

    const duration = Date.now() - startTime;
    
    // 记录到指标
    this.metrics[this.metrics.length - 1] = {
      ...this.metrics[this.metrics.length - 1],
      sessionRetrievalTimeMs: duration,
    };

    return sessionRef;
  }

  /**
   * 构建缓存键
   */
  private buildCacheKey(request: KgmRequest): ContextPackCacheKey {
    return {
      graphEnabled: Boolean(this.graphStore && request.kgm?.graph?.enabled),
      embeddingVersion: this.embeddingVersion,
    };
  }

  /**
   * 报告上下文质量
   */
  private reportQuality(evidence: Evidence[], request: KgmRequest) {
    const retrievalTopK = request.kgm?.retrieval?.topK ?? this.topK;
    const hitRate = evidence.length
      ? evidence.reduce((sum, item) => sum + (item.score ?? 0), 0) / evidence.length
      : 0;

    this.reportContextQuality?.({
      timestamp: new Date().toISOString(),
      user_id: request.userId,
      recall_topk: retrievalTopK,
      hit_rate: Number(hitRate.toFixed(4)),
      embedding_version: this.embeddingVersion,
    });
  }

  /**
   * 记录性能指标
   */
  private recordMetrics(metrics: ContextBuildMetrics) {
    this.metrics.push(metrics);
    
    // 保持最大历史记录数
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics.shift();
    }

    // 更新缓存计数器
    if (metrics.fromCache) {
      this.cacheHitCount++;
    } else {
      this.cacheMissCount++;
    }
  }

  /**
   * 获取性能统计
   */
  getStats() {
    const cacheHitRate = this.cacheHitCount + this.cacheMissCount > 0
      ? this.cacheHitCount / (this.cacheHitCount + this.cacheMissCount)
      : 0;

    const avgBuildTime = this.metrics.length > 0
      ? this.metrics.reduce((sum, m) => sum + m.buildTimeMs, 0) / this.metrics.length
      : 0;

    const avgMemoryRetrievalTime = this.metrics
      .filter(m => m.memoryRetrievalTimeMs !== undefined)
      .reduce((sum, m, _, arr) => sum + (m.memoryRetrievalTimeMs ?? 0), 0) / 
      (this.metrics.filter(m => m.memoryRetrievalTimeMs !== undefined).length || 1);

    const avgGraphQueryTime = this.metrics
      .filter(m => m.graphQueryTimeMs !== undefined)
      .reduce((sum, m, _, arr) => sum + (m.graphQueryTimeMs ?? 0), 0) / 
      (this.metrics.filter(m => m.graphQueryTimeMs !== undefined).length || 1);

    const avgSessionRetrievalTime = this.metrics
      .filter(m => m.sessionRetrievalTimeMs !== undefined)
      .reduce((sum, m, _, arr) => sum + (m.sessionRetrievalTimeMs ?? 0), 0) / 
      (this.metrics.filter(m => m.sessionRetrievalTimeMs !== undefined).length || 1);

    const fromCacheCount = this.metrics.filter(m => m.fromCache).length;
    const notFromCacheCount = this.metrics.filter(m => !m.fromCache).length;

    return {
      cache: {
        hitCount: this.cacheHitCount,
        missCount: this.cacheMissCount,
        hitRate: cacheHitRate,
        size: this.contextCache.size,
        maxSize: this.contextCache.maxSize,
      },
      performance: {
        avgBuildTimeMs: avgBuildTime,
        avgMemoryRetrievalTimeMs: avgMemoryRetrievalTime,
        avgGraphQueryTimeMs: avgGraphQueryTime,
        avgSessionRetrievalTimeMs: avgSessionRetrievalTime,
        totalBuilds: this.metrics.length,
        fromCacheCount,
        notFromCacheCount,
      },
    };
  }

  /**
   * 获取优化建议
   */
  getOptimizationSuggestions(): string[] {
    const suggestions: string[] = [];
    const stats = this.getStats();

    // 缓存命中率分析
    if (stats.cache.hitRate < 0.3) {
      suggestions.push("缓存命中率较低(低于30%),建议增加缓存大小或检查缓存键设计");
    } else if (stats.cache.hitRate > 0.7) {
      suggestions.push("缓存命中率高(超过70%),当前配置良好");
    }

    // 记忆检索性能分析
    if (stats.performance.avgMemoryRetrievalTimeMs > 100) {
      suggestions.push(`平均记忆检索时间较长(${stats.performance.avgMemoryRetrievalTimeMs.toFixed(0)}ms),建议启用混合检索或优化向量索引`);
    }

    // 图谱查询性能分析
    if (stats.performance.avgGraphQueryTimeMs > 50) {
      suggestions.push(`平均图谱查询时间较长(${stats.performance.avgGraphQueryTimeMs.toFixed(0)}ms),建议优化图谱索引或减少查询范围`);
    }

    // 总体构建时间分析
    if (stats.performance.avgBuildTimeMs > 500) {
      suggestions.push(`总体Context构建时间较长(${stats.performance.avgBuildTimeMs.toFixed(0)}ms),建议检查各项并行操作的性能瓶颈`);
    }

    return suggestions;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.contextCache.clear();
    this.cacheHitCount = 0;
    this.cacheMissCount = 0;
  }

  /**
   * 清除性能指标
   */
  clearMetrics(): void {
    this.metrics = [];
  }

  /**
   * 应用证据预算
   */
  private applyEvidenceBudget(evidence: Evidence[]): Evidence[] {
    const maxChars = this.contextConfig?.maxEvidenceChars ?? 800;
    const previewChars = this.contextConfig?.artifactPreviewChars ?? 240;
    const artifactStore = this.artifactStore;
    
    if (!artifactStore) {
      return evidence.map((item) => ({
        ...item,
        text: item.text.length > maxChars ? item.text.slice(0, maxChars) : item.text,
      }));
    }
    
    return evidence.map((item) => {
      if (item.text.length <= maxChars) {
        return item;
      }
      const artifact = artifactStore.writeText("evidence", item.text, previewChars);
      return {
        ...item,
        text: item.text.slice(0, maxChars),
        artifact_ref: artifact,
      };
    });
  }

  /**
   * 应用工具策略
   */
  private applyToolPolicy(
    toolPolicy?: { allowed?: string[]; maxRounds?: number },
    graphEnabled?: boolean
  ) {
    const merged = {
      ...DEFAULT_TOOL_POLICY,
      ...toolPolicy,
      allowed: toolPolicy?.allowed ?? DEFAULT_TOOL_POLICY.allowed,
    };
    
    const systemTools: string[] = [];
    if (this.contextConfig?.enableArtifactTool) {
      systemTools.push("read_artifact");
    }
    if (this.contextConfig?.enableSessionTool) {
      systemTools.push("read_session");
    }
    if (this.contextConfig?.enableToolCatalogTool) {
      systemTools.push("list_tools", "describe_tool");
      if (this.contextConfig?.includeSkillNames) {
        systemTools.push("list_skills", "describe_skill");
      }
    }
    if (graphEnabled) {
      systemTools.push("retrieve_subgraph");
    }
    
    merged.allowed = Array.from(new Set([...merged.allowed, ...systemTools]));
    return merged;
  }
}

// ============ 辅助函数 ============

function sanitizeSignals(signals: Signal[]): Signal[] {
  return signals.map((signal) => ({
    type: signal.type,
    source: signal.source,
    title: signal.title,
    value: signal.value,
    timestamp: signal.timestamp,
    metadata: signal.metadata,
  }));
}

function sanitizeConversation(messages?: ContextPack["conversation"]): ContextPack["conversation"] {
  if (!messages || messages.length === 0) {
    return undefined;
  }
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    name: message.name,
    toolCallId: message.toolCallId,
  }));
}

function buildSignals(signals: Signal[], graphSignal?: Signal | null): Signal[] {
  if (!graphSignal) {
    return signals;
  }
  return [...signals, graphSignal];
}

async function buildKnowledgeGraphSignal(
  graphStore: GraphStore,
  graph: NonNullable<NonNullable<KgmRequest["kgm"]>["graph"]>,
  query: string,
  namespace: string,
): Promise<Signal | null> {
  const entities = graph.entities ?? [];
  const relations = graph.relations ?? [];
  const subgraph = await graphStore.querySubgraph({
    entities,
    relations,
    query: graph.subgraph ?? query,
    limit: 8,
    namespace,
  });

  if (!graph.subgraph && subgraph.triples.length === 0 && entities.length === 0 && relations.length === 0) {
    return null;
  }

  return {
    type: "knowledge_graph",
    source: "kgm.graph",
    title: "Knowledge graph context",
    value: renderGraphSummary(graph.subgraph, subgraph.triples),
    metadata: {
      entities: subgraph.entities,
      relations: subgraph.relations,
      triples: subgraph.triples,
      reasoningMode: graph.reasoningMode,
    },
  };
}

function renderGraphSummary(subgraph: string | undefined, triples: KgmGraphTriple[]): string {
  const parts: string[] = [];
  if (subgraph) {
    parts.push(subgraph);
  }
  if (triples.length > 0) {
    parts.push(triples.slice(0, 8).map((triple) => `${triple.subject} -${triple.predicate}-> ${triple.object}`).join("; "));
  }
  return parts.join("\n");
}
