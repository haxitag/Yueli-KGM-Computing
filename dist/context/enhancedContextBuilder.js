import { DEFAULT_CONSTRAINTS, DEFAULT_TOOL_POLICY } from "../core/config.js";
import { generateId } from "../utils/id.js";
import { LRUCache } from "../utils/cache.js";
/**
 * 增强型ContextBuilder
 *
 * 核心优化:
 * 1. 并行化记忆检索、图谱查询、多模态处理
 * 2. ContextPack级别的缓存
 * 3. 性能监控与优化建议
 */
export class EnhancedContextBuilder {
    memoryStore;
    embedder;
    topK;
    reportContextQuality;
    embeddingVersion;
    contextConfig;
    artifactStore;
    sessionStore;
    graphStore;
    // ContextPack缓存
    contextCache;
    cacheHitCount = 0;
    cacheMissCount = 0;
    // 性能指标
    metrics = [];
    maxMetricsHistory = 1000;
    constructor(params) {
        this.memoryStore = params.memoryStore;
        this.embedder = params.embedder;
        this.topK = params.topK ?? 5;
        this.reportContextQuality = params.reportContextQuality;
        this.embeddingVersion = params.embeddingVersion;
        this.contextConfig = params.contextConfig;
        this.artifactStore = params.artifactStore;
        this.sessionStore = params.sessionStore;
        this.graphStore = params.graphStore;
        // 初始化缓存 (默认100个)
        this.contextCache = new LRUCache({
            maxSize: params.cacheSize ?? 100,
        });
    }
    /**
     * 构建ContextPack (并行化版本)
     */
    async build(request) {
        const startTime = Date.now();
        const requestId = request.requestId ?? generateId();
        const sessionId = request.sessionId ?? request.userId;
        // 1. 生成缓存键
        const cacheKey = this.buildCacheKey(request);
        const cachedContext = this.contextCache.get(cacheKey);
        const fromCache = !!cachedContext;
        // 2. 并行执行独立的检索操作
        const [graphSignal, evidence, sessionRef] = await Promise.all([
            // 图谱查询 (如果启用)
            this.buildGraphSignal(request),
            // 记忆检索 (如果不在缓存中)
            fromCache ? Promise.resolve(cachedContext.evidence ?? []) : this.retrieveEvidence(request),
            // 会话历史检索
            fromCache && cachedContext.session_ref
                ? Promise.resolve(cachedContext.session_ref)
                : this.retrieveSessionRef(sessionId),
        ]);
        // 3. 添加图谱三元组 (如果有)
        if (this.graphStore && request.kgm?.graph?.triples?.length) {
            await this.graphStore.addTriples({
                triples: request.kgm.graph.triples,
                source: "request.kgm.graph",
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
        const contextPack = {
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
                evidence, // 缓存证据以加速后续检索
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
    async buildGraphSignal(request) {
        if (!this.graphStore || !request.kgm?.graph?.enabled) {
            return null;
        }
        const startTime = Date.now();
        const signal = await buildKnowledgeGraphSignal(this.graphStore, request.kgm.graph, request.input);
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
    async retrieveEvidence(request) {
        const startTime = Date.now();
        const retrievalTopK = request.kgm?.retrieval?.topK ?? this.topK;
        let evidence = await this.memoryStore.search(request.userId, request.input, this.embedder, retrievalTopK);
        evidence = this.applyEvidenceBudget(evidence);
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
    async retrieveSessionRef(sessionId) {
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
    buildCacheKey(request) {
        return {
            graphEnabled: Boolean(this.graphStore && request.kgm?.graph?.enabled),
            embeddingVersion: this.embeddingVersion,
        };
    }
    /**
     * 报告上下文质量
     */
    reportQuality(evidence, request) {
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
    recordMetrics(metrics) {
        this.metrics.push(metrics);
        // 保持最大历史记录数
        if (this.metrics.length > this.maxMetricsHistory) {
            this.metrics.shift();
        }
        // 更新缓存计数器
        if (metrics.fromCache) {
            this.cacheHitCount++;
        }
        else {
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
    getOptimizationSuggestions() {
        const suggestions = [];
        const stats = this.getStats();
        // 缓存命中率分析
        if (stats.cache.hitRate < 0.3) {
            suggestions.push("缓存命中率较低(低于30%),建议增加缓存大小或检查缓存键设计");
        }
        else if (stats.cache.hitRate > 0.7) {
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
    clearCache() {
        this.contextCache.clear();
        this.cacheHitCount = 0;
        this.cacheMissCount = 0;
    }
    /**
     * 清除性能指标
     */
    clearMetrics() {
        this.metrics = [];
    }
    /**
     * 应用证据预算
     */
    applyEvidenceBudget(evidence) {
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
    applyToolPolicy(toolPolicy, graphEnabled) {
        const merged = {
            ...DEFAULT_TOOL_POLICY,
            ...toolPolicy,
            allowed: toolPolicy?.allowed ?? DEFAULT_TOOL_POLICY.allowed,
        };
        const systemTools = [];
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
function sanitizeSignals(signals) {
    return signals.map((signal) => ({
        type: signal.type,
        source: signal.source,
        title: signal.title,
        value: signal.value,
        timestamp: signal.timestamp,
        metadata: signal.metadata,
    }));
}
function sanitizeConversation(messages) {
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
function buildSignals(signals, graphSignal) {
    if (!graphSignal) {
        return signals;
    }
    return [...signals, graphSignal];
}
async function buildKnowledgeGraphSignal(graphStore, graph, query) {
    const entities = graph.entities ?? [];
    const relations = graph.relations ?? [];
    const subgraph = await graphStore.querySubgraph({
        entities,
        relations,
        query: graph.subgraph ?? query,
        limit: 8,
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
function renderGraphSummary(subgraph, triples) {
    const parts = [];
    if (subgraph) {
        parts.push(subgraph);
    }
    if (triples.length > 0) {
        parts.push(triples.slice(0, 8).map((triple) => `${triple.subject} -${triple.predicate}-> ${triple.object}`).join("; "));
    }
    return parts.join("\n");
}
