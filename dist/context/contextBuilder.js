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
    artifactStore;
    sessionStore;
    graphStore;
    ycbClient;
    retrievalCache = new Map();
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
        this.ycbClient = params.ycbClient;
    }
    async build(request) {
        const requestId = request.requestId ?? generateId();
        const sessionId = request.sessionId ?? request.userId;
        if (this.graphStore && request.kgm?.graph?.triples?.length) {
            await this.graphStore.addTriples({
                triples: request.kgm.graph.triples,
                source: "request.kgm.graph",
            });
        }
        const graphSignal = this.graphStore && request.kgm?.graph?.enabled
            ? await buildKnowledgeGraphSignal(this.graphStore, request.kgm.graph, request.input)
            : null;
        const signals = buildSignals(request.signals ?? [], graphSignal);
        const retrievalTopK = request.kgm?.retrieval?.topK ?? this.topK;
        const ycbEvidence = this.ycbClient ? await this.ycbClient.fetchEvidence(request) : [];
        const memOpts = memorySearchOptionsFromKgm(request.kgm?.retrieval);
        const memoryEvidence = await this.loadMemoryEvidence(request.userId, request.input, retrievalTopK, memOpts);
        let evidence = this.applyEvidenceBudget([...ycbEvidence, ...memoryEvidence]);
        const toolPolicy = this.applyToolPolicy(request.toolPolicy, Boolean(request.kgm?.graph?.enabled));
        const rawSessionRef = this.sessionStore
            ? this.sessionStore.getRef(sessionId, this.contextConfig?.sessionPreviewChars ?? 240)
            : undefined;
        const sessionRef = rawSessionRef && rawSessionRef.sizeBytes > 0 ? rawSessionRef : undefined;
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
        const ttl = this.contextConfig?.retrievalCacheTtlMs ?? 0;
        if (ttl <= 0) {
            return this.memoryStore.search(userId, input, this.embedder, topK, memOpts);
        }
        const key = this.makeMemoryCacheKey(userId, input, topK, memOpts);
        const hit = this.retrievalCache.get(key);
        const now = Date.now();
        if (hit && hit.expires > now) {
            return hit.evidence;
        }
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
