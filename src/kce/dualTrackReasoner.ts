import type { GraphStore, GraphRule } from "../graph/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { Embedder } from "../embedding/canonical.js";
import type { LlmClient } from "../llm/client.js";
import { fuseDualTrackConfidence, type DualTrackScoreResult, type DualTrackWeights } from "./confidenceFusion.js";

export type DualTrackReasonRequest = {
  query: string;
  namespace: string;
  entities?: string[];
  relations?: string[];
  rules?: GraphRule[];
  maxRuleRounds?: number;
  memoryTopK?: number;
  llmEnabled?: boolean;
  weights?: Partial<DualTrackWeights>;
};

export type DualTrackReasonResult = {
  answer: string;
  dual_track: DualTrackScoreResult;
  symbolic: {
    triples: number;
    inferred: number;
    entities: string[];
    relations: string[];
    score: number;
  };
  retrieval: {
    hits: number;
    top_score: number;
    evidence: Array<{ id?: string; text: string; score?: number }>;
    score: number;
  };
  llm: {
    used: boolean;
    score: number;
    summary?: string;
  };
  mode: "formal+statistical";
};

export type DualTrackReasonerDeps = {
  graphStore: GraphStore;
  memoryStore?: MemoryStore;
  embedder?: Embedder;
  llm?: LlmClient;
};

/**
 * Explicit formal (graph/rules) + statistical (retrieval/LLM) dual-track reasoner.
 */
export class DualTrackReasoner {
  constructor(private readonly deps: DualTrackReasonerDeps) {}

  async reason(request: DualTrackReasonRequest): Promise<DualTrackReasonResult> {
    const query = request.query.trim();
    const namespace = request.namespace.trim();

    const subgraph = await this.deps.graphStore.querySubgraph({
      entities: request.entities,
      relations: request.relations,
      query,
      limit: 32,
      namespace,
    });

    let inferred = 0;
    if (request.rules?.length && this.deps.graphStore.applyRules) {
      const added = await this.deps.graphStore.applyRules({
        rules: request.rules,
        maxRounds: Math.max(1, Math.min(10, request.maxRuleRounds ?? 3)),
        source: "kgm.dual_track.rules",
        namespace,
      });
      inferred = added.length;
    }

    const expandCenter = request.entities?.[0] ?? subgraph.entities[0];
    let expandTriples = subgraph.triples.length;
    if (expandCenter && this.deps.graphStore.reasonExpand) {
      const expanded = await this.deps.graphStore.reasonExpand({
        entity: expandCenter,
        maxDepth: 2,
        relations: request.relations,
        namespace,
      });
      expandTriples = Math.max(expandTriples, expanded?.triples.length ?? 0);
    }

    const symbolicScore = clampGraphScore(subgraph.triples.length + inferred, expandTriples);

    let retrievalHits: Array<{ id?: string; text: string; score?: number }> = [];
    let retrievalScore = 0;
    let topScore = 0;
    if (this.deps.memoryStore && this.deps.embedder && query) {
      const hits = await this.deps.memoryStore.search(
        namespace,
        query,
        this.deps.embedder,
        request.memoryTopK ?? 5,
      );
      retrievalHits = hits.map((h) => ({ id: h.id, text: h.text, score: h.score }));
      topScore = hits.reduce((max, h) => Math.max(max, h.score ?? 0), 0);
      retrievalScore = hits.length === 0 ? 0.15 : clamp01(0.35 + topScore * 0.65);
    } else {
      retrievalScore = subgraph.triples.length > 0 ? 0.25 : 0.1;
    }

    let llmUsed = false;
    let llmScore = 0.2;
    let llmSummary: string | undefined;
    const wantLlm = request.llmEnabled !== false && Boolean(this.deps.llm);
    if (wantLlm && this.deps.llm) {
      llmUsed = true;
      const evidenceBits = [
        ...subgraph.triples.slice(0, 8).map((t) => `${t.subject} -${t.predicate}-> ${t.object}`),
        ...retrievalHits.slice(0, 3).map((h) => h.text.slice(0, 160)),
      ].join("\n");
      const prompt =
        `You are the statistical track of a dual-track reasoner.\n` +
        `Query: ${query}\nEvidence:\n${evidenceBits || "(none)"}\n` +
        `Reply with a short factual answer grounded in evidence.`;
      const completion = await this.deps.llm.complete(prompt, { maxTokens: 256 });
      llmSummary = completion.text;
      llmScore = llmSummary.trim().length > 0 ? (evidenceBits ? 0.82 : 0.45) : 0.2;
    } else {
      llmScore = symbolicScore * 0.5 + retrievalScore * 0.5;
    }

    const dual = fuseDualTrackConfidence({
      symbolic: symbolicScore,
      retrieval: retrievalScore,
      llm: llmScore,
      weights: request.weights,
    });

    const answer =
      llmSummary?.trim() ||
      (subgraph.triples[0]
        ? `${subgraph.triples[0].subject} ${subgraph.triples[0].predicate} ${subgraph.triples[0].object}`
        : retrievalHits[0]?.text) ||
      "insufficient dual-track evidence";

    return {
      answer,
      dual_track: dual,
      symbolic: {
        triples: subgraph.triples.length,
        inferred,
        entities: subgraph.entities,
        relations: subgraph.relations,
        score: symbolicScore,
      },
      retrieval: {
        hits: retrievalHits.length,
        top_score: topScore,
        evidence: retrievalHits,
        score: retrievalScore,
      },
      llm: {
        used: llmUsed,
        score: llmScore,
        summary: llmSummary,
      },
      mode: "formal+statistical",
    };
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function clampGraphScore(matchCount: number, expandCount: number): number {
  if (matchCount <= 0 && expandCount <= 0) return 0.12;
  const base = 0.4 + Math.min(0.45, matchCount * 0.08) + Math.min(0.15, expandCount * 0.02);
  return clamp01(base);
}
