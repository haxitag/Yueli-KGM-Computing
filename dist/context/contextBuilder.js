import { createHash } from "node:crypto";
import { DEFAULT_CONSTRAINTS, DEFAULT_TOOL_POLICY } from "../core/config.js";
import { memorySearchOptionsFromKgm } from "../memory/retrievalOptions.js";
import { generateId } from "../utils/id.js";
export class ContextBuilder {
    memoryStore;
    embedder;
    topK;
    reportContextQuality;
    embeddingVersion;
    contextConfig;
    getContextConfig;
    artifactStore;
    sessionStore;
    graphStore;
    ycbClient;
    retrievalCache = new Map();
    retrievalCacheHits = 0;
    retrievalCacheMisses = 0;
    lastBuildAt;
    lastBuildSummary;
    constructor(params) {
        this.memoryStore = params.memoryStore;
        this.embedder = params.embedder;
        this.topK = params.topK ?? 5;
        this.reportContextQuality = params.reportContextQuality;
        this.embeddingVersion = params.embeddingVersion;
        this.contextConfig = params.contextConfig;
        this.getContextConfig = params.getContextConfig;
        this.artifactStore = params.artifactStore;
        this.sessionStore = params.sessionStore;
        this.graphStore = params.graphStore;
        this.ycbClient = params.ycbClient;
    }
    resolvedContext() {
        return this.getContextConfig?.() ?? this.contextConfig;
    }
    resolveGraphMaxTriples(graph) {
        if (typeof graph.maxTriples === "number" && Number.isFinite(graph.maxTriples) && graph.maxTriples > 0) {
            return Math.floor(graph.maxTriples);
        }
        const envRaw = process.env.KGM_GRAPH_MAX_TRIPLES?.trim();
        if (envRaw) {
            const parsed = Number(envRaw);
            if (Number.isFinite(parsed) && parsed > 0) {
                return Math.floor(parsed);
            }
        }
        const fromConfig = this.resolvedContext()?.graphMaxTriples;
        if (typeof fromConfig === "number" && Number.isFinite(fromConfig) && fromConfig > 0) {
            return Math.floor(fromConfig);
        }
        return 8;
    }
    async build(request) {
        const requestId = request.requestId ?? generateId();
        const sessionId = request.sessionId ?? request.userId;
        if (this.graphStore && request.kgm?.graph?.triples?.length) {
            await this.graphStore.addTriples({
                triples: request.kgm.graph.triples,
                source: "request.kgm.graph",
                namespace: request.userId,
            });
        }
        const graphPayloadPresent = Boolean(this.graphStore &&
            (request.kgm?.graph?.triples?.length ||
                request.kgm?.graph?.entities?.length ||
                request.kgm?.graph?.relations?.length ||
                request.kgm?.graph?.subgraph));
        const graphSkipped = Boolean(graphPayloadPresent && !request.kgm?.graph?.enabled);
        const graphSignal = this.graphStore && request.kgm?.graph?.enabled
            ? await buildKnowledgeGraphSignal(this.graphStore, request.kgm.graph, request.input, request.userId, this.resolveGraphMaxTriples(request.kgm.graph))
            : null;
        const signals = buildSignals(request.signals ?? [], graphSignal);
        const retrievalTopK = request.kgm?.retrieval?.topK ?? this.topK;
        const ycbEvidence = this.ycbClient ? await this.ycbClient.fetchEvidence(request) : [];
        const memOpts = memorySearchOptionsFromKgm(request.kgm?.retrieval);
        const memoryEvidence = await this.loadMemoryEvidence(request.userId, request.input, retrievalTopK, memOpts);
        let evidence = this.applyEvidenceBudget([...ycbEvidence, ...memoryEvidence]);
        const budgetTruncated = [...ycbEvidence, ...memoryEvidence].filter((item, idx) => evidence[idx]?.text !== item.text || Boolean(evidence[idx]?.artifact_ref)).length;
        const toolPolicy = this.applyToolPolicy(request.toolPolicy, Boolean(request.kgm?.graph?.enabled));
        const rawSessionRef = this.sessionStore
            ? this.sessionStore.getRef(sessionId, this.resolvedContext()?.sessionPreviewChars ?? 240)
            : undefined;
        const sessionRef = rawSessionRef && rawSessionRef.sizeBytes > 0 ? rawSessionRef : undefined;
        this.lastBuildAt = new Date().toISOString();
        this.lastBuildSummary = {
            evidenceCount: evidence.length,
            signalCount: signals.length,
            graphEnabled: Boolean(request.kgm?.graph?.enabled),
            graphSkipped,
            ycbEvidenceCount: ycbEvidence.length,
            budgetTruncated,
        };
        if (this.reportContextQuality) {
            const hitRate = evidence.length
                ? evidence.reduce((sum, item) => sum + (item.score ?? 0), 0) / evidence.length
                : 0;
            this.reportContextQuality({
                timestamp: new Date().toISOString(),
                user_id: request.userId,
                recall_topk: retrievalTopK,
                hit_rate: Number(hitRate.toFixed(4)),
                embedding_version: this.embeddingVersion,
            });
        }
        return {
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
    }
    makeMemoryCacheKey(userId, input, topK, memOpts) {
        return createHash("sha256")
            .update(JSON.stringify({ userId, input, topK, memOpts }))
            .digest("hex");
    }
    async loadMemoryEvidence(userId, input, topK, memOpts) {
        const ttl = this.resolvedContext()?.retrievalCacheTtlMs ?? 0;
        if (ttl <= 0) {
            this.retrievalCacheMisses += 1;
            return this.memoryStore.search(userId, input, this.embedder, topK, memOpts);
        }
        const key = this.makeMemoryCacheKey(userId, input, topK, memOpts);
        const hit = this.retrievalCache.get(key);
        const now = Date.now();
        if (hit && hit.expires > now) {
            this.retrievalCacheHits += 1;
            return hit.evidence;
        }
        this.retrievalCacheMisses += 1;
        const evidence = await this.memoryStore.search(userId, input, this.embedder, topK, memOpts);
        if (this.retrievalCache.size > 300) {
            const first = this.retrievalCache.keys().next().value;
            if (first) {
                this.retrievalCache.delete(first);
            }
        }
        this.retrievalCache.set(key, { expires: now + ttl, evidence });
        return evidence;
    }
    getObservabilityStats() {
        const ttl = this.resolvedContext()?.retrievalCacheTtlMs ?? 0;
        const total = this.retrievalCacheHits + this.retrievalCacheMisses;
        return {
            retrievalCache: {
                enabled: ttl > 0,
                ttlMs: ttl,
                entries: this.retrievalCache.size,
                hits: this.retrievalCacheHits,
                misses: this.retrievalCacheMisses,
                hitRate: total > 0 ? Number((this.retrievalCacheHits / total).toFixed(4)) : null,
            },
            evidenceBudget: {
                maxEvidenceChars: this.resolvedContext()?.maxEvidenceChars ?? 800,
                artifactPreviewChars: this.resolvedContext()?.artifactPreviewChars ?? 240,
            },
            lastBuildAt: this.lastBuildAt,
            lastBuildSummary: this.lastBuildSummary,
        };
    }
    clearRetrievalCache() {
        const n = this.retrievalCache.size;
        this.retrievalCache.clear();
        return n;
    }
    applyEvidenceBudget(evidence) {
        const maxChars = this.resolvedContext()?.maxEvidenceChars ?? 800;
        const previewChars = this.resolvedContext()?.artifactPreviewChars ?? 240;
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
    applyToolPolicy(toolPolicy, graphEnabled) {
        const merged = {
            ...DEFAULT_TOOL_POLICY,
            ...toolPolicy,
            allowed: toolPolicy?.allowed ?? DEFAULT_TOOL_POLICY.allowed,
        };
        const systemTools = [];
        if (this.resolvedContext()?.enableArtifactTool) {
            systemTools.push("read_artifact");
        }
        if (this.resolvedContext()?.enableSessionTool) {
            systemTools.push("read_session");
        }
        if (this.resolvedContext()?.enableToolCatalogTool) {
            systemTools.push("list_tools", "describe_tool");
            if (this.resolvedContext()?.includeSkillNames) {
                systemTools.push("list_skills", "describe_skill");
            }
        }
        if (graphEnabled) {
            systemTools.push("retrieve_subgraph");
        }
        systemTools.push("list_sandboxes", "start_sandbox", "stop_sandbox", "mcp_call");
        merged.allowed = Array.from(new Set([...merged.allowed, ...systemTools]));
        return merged;
    }
}
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
async function buildKnowledgeGraphSignal(graphStore, graph, query, namespace, maxTriples) {
    const entities = graph.entities ?? [];
    const relations = graph.relations ?? [];
    const subgraph = await graphStore.querySubgraph({
        entities,
        relations,
        query: graph.subgraph ?? query,
        limit: maxTriples,
        namespace,
    });
    if (!graph.subgraph && subgraph.triples.length === 0 && entities.length === 0 && relations.length === 0) {
        return null;
    }
    return {
        type: "knowledge_graph",
        source: "kgm.graph",
        title: "Knowledge graph context",
        value: renderGraphSummary(graph.subgraph, subgraph.triples, maxTriples),
        metadata: {
            entities: subgraph.entities,
            relations: subgraph.relations,
            triples: subgraph.triples,
            reasoningMode: graph.reasoningMode,
            maxTriples,
        },
    };
}
function renderGraphSummary(subgraph, triples, maxTriples) {
    const parts = [];
    if (subgraph) {
        parts.push(subgraph);
    }
    if (triples.length > 0) {
        parts.push(triples.slice(0, maxTriples).map((triple) => `${triple.subject} -${triple.predicate}-> ${triple.object}`).join("; "));
    }
    return parts.join("\n");
}
