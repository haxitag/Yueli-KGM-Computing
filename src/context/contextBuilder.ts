import { createHash } from "node:crypto";
import { DEFAULT_CONSTRAINTS, DEFAULT_TOOL_POLICY } from "../core/config.js";
import type { ContextPack, Evidence, KgmRequest, KgmGraphTriple, Signal } from "../core/types.js";
import type { Embedder } from "../embedding/canonical.js";
import type { GraphStore } from "../graph/store.js";
import { memorySearchOptionsFromKgm } from "../memory/retrievalOptions.js";
import type { MemoryStore, MemorySearchOptions } from "../memory/store.js";
import { generateId } from "../utils/id.js";
import type { ContextConfig } from "../core/configStore.js";
import type { ArtifactStore } from "./artifactStore.js";
import type { SessionStore } from "./sessionStore.js";
import type { YcbClient } from "../ycb/client.js";

export type ContextQualityEvent = {
  timestamp: string;
  user_id?: string;
  recall_topk: number;
  hit_rate: number;
  embedding_version?: string;
};

export type ContextQualityReporter = (event: ContextQualityEvent) => void;

export class ContextBuilder {
  private memoryStore: MemoryStore;
  private embedder: Embedder;
  private topK: number;
  private reportContextQuality?: ContextQualityReporter;
  private embeddingVersion?: string;
  private contextConfig?: ContextConfig;
  private getContextConfig?: () => ContextConfig | undefined;
  private artifactStore?: ArtifactStore;
  private sessionStore?: SessionStore;
  private graphStore?: GraphStore;
  private ycbClient?: YcbClient;
  private retrievalCache = new Map<string, { expires: number; evidence: Evidence[] }>();
  private retrievalCacheHits = 0;
  private retrievalCacheMisses = 0;
  private lastBuildAt?: string;
  private lastBuildSummary?: {
    evidenceCount: number;
    signalCount: number;
    graphEnabled: boolean;
    graphSkipped?: boolean;
    ycbEvidenceCount: number;
    budgetTruncated: number;
  };

  constructor(params: {
    memoryStore: MemoryStore;
    embedder: Embedder;
    topK?: number;
    reportContextQuality?: ContextQualityReporter;
    embeddingVersion?: string;
    contextConfig?: ContextConfig;
    /** Live getter so Playground config patches apply without restart */
    getContextConfig?: () => ContextConfig | undefined;
    artifactStore?: ArtifactStore;
    sessionStore?: SessionStore;
    graphStore?: GraphStore;
    ycbClient?: YcbClient;
  }) {
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

  private resolvedContext(): ContextConfig | undefined {
    return this.getContextConfig?.() ?? this.contextConfig;
  }

  private resolveGraphMaxTriples(graph: NonNullable<NonNullable<KgmRequest["kgm"]>["graph"]>): number {
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

  async build(request: KgmRequest): Promise<ContextPack> {
    const requestId = request.requestId ?? generateId();
    const sessionId = request.sessionId ?? request.userId;
    if (this.graphStore && request.kgm?.graph?.triples?.length) {
      await this.graphStore.addTriples({
        triples: request.kgm.graph.triples,
        source: "request.kgm.graph",
        namespace: request.userId,
      });
    }
    const graphPayloadPresent = Boolean(
      this.graphStore &&
        (request.kgm?.graph?.triples?.length ||
          request.kgm?.graph?.entities?.length ||
          request.kgm?.graph?.relations?.length ||
          request.kgm?.graph?.subgraph),
    );
    const graphSkipped = Boolean(graphPayloadPresent && !request.kgm?.graph?.enabled);
    const graphSignal =
      this.graphStore && request.kgm?.graph?.enabled
        ? await buildKnowledgeGraphSignal(
            this.graphStore,
            request.kgm.graph,
            request.input,
            request.userId,
            this.resolveGraphMaxTriples(request.kgm.graph),
          )
        : null;
    const signals = buildSignals(request.signals ?? [], graphSignal);
    const retrievalTopK = request.kgm?.retrieval?.topK ?? this.topK;
    const ycbEvidence = this.ycbClient ? await this.ycbClient.fetchEvidence(request) : [];
    const memOpts = memorySearchOptionsFromKgm(request.kgm?.retrieval);
    const memoryEvidence = await this.loadMemoryEvidence(
      request.userId,
      request.input,
      retrievalTopK,
      memOpts,
    );
    let evidence = this.applyEvidenceBudget([...ycbEvidence, ...memoryEvidence]);
    const budgetTruncated = [...ycbEvidence, ...memoryEvidence].filter(
      (item, idx) => evidence[idx]?.text !== item.text || Boolean(evidence[idx]?.artifact_ref),
    ).length;
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

  private makeMemoryCacheKey(
    userId: string,
    input: string,
    topK: number,
    memOpts: MemorySearchOptions | undefined,
  ): string {
    return createHash("sha256")
      .update(JSON.stringify({ userId, input, topK, memOpts }))
      .digest("hex");
  }

  private async loadMemoryEvidence(
    userId: string,
    input: string,
    topK: number,
    memOpts: MemorySearchOptions | undefined,
  ): Promise<Evidence[]> {
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

  getObservabilityStats(): {
    retrievalCache: {
      enabled: boolean;
      ttlMs: number;
      entries: number;
      hits: number;
      misses: number;
      hitRate: number | null;
    };
    evidenceBudget: {
      maxEvidenceChars: number;
      artifactPreviewChars: number;
    };
    lastBuildAt?: string;
    lastBuildSummary?: {
      evidenceCount: number;
      signalCount: number;
      graphEnabled: boolean;
      graphSkipped?: boolean;
      ycbEvidenceCount: number;
      budgetTruncated: number;
    };
  } {
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

  clearRetrievalCache(): number {
    const n = this.retrievalCache.size;
    this.retrievalCache.clear();
    return n;
  }

  private applyEvidenceBudget(evidence: Evidence[]): Evidence[] {
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

  private applyToolPolicy(toolPolicy?: { allowed?: string[]; maxRounds?: number }, graphEnabled?: boolean) {
    const merged = {
      ...DEFAULT_TOOL_POLICY,
      ...toolPolicy,
      allowed: toolPolicy?.allowed ?? DEFAULT_TOOL_POLICY.allowed,
    };
    const systemTools: string[] = [];
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
    merged.allowed = Array.from(new Set([...merged.allowed, ...systemTools]));
    return merged;
  }
}

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
  maxTriples: number,
): Promise<Signal | null> {
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

function renderGraphSummary(subgraph: string | undefined, triples: KgmGraphTriple[], maxTriples: number): string {
  const parts: string[] = [];
  if (subgraph) {
    parts.push(subgraph);
  }
  if (triples.length > 0) {
    parts.push(triples.slice(0, maxTriples).map((triple) => `${triple.subject} -${triple.predicate}-> ${triple.object}`).join("; "));
  }
  return parts.join("\n");
}
