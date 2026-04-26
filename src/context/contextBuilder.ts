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
  private artifactStore?: ArtifactStore;
  private sessionStore?: SessionStore;
  private graphStore?: GraphStore;
  private ycbClient?: YcbClient;
  private retrievalCache = new Map<string, { expires: number; evidence: Evidence[] }>();

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
    /** 可选：外置 YCB 上下文，与本地检索合并进 evidence（平面二 → Runtime 汇合） */
    ycbClient?: YcbClient;
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
  }

  async build(request: KgmRequest): Promise<ContextPack> {
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
    const memoryEvidence = await this.loadMemoryEvidence(
      request.userId,
      request.input,
      retrievalTopK,
      memOpts,
    );
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

  private applyToolPolicy(toolPolicy?: { allowed?: string[]; maxRounds?: number }, graphEnabled?: boolean) {
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
): Promise<Signal | null> {
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
