import { pairwiseInteractionScore } from "./shallowKernel.js";
import type {
  CrossEncoderDocument,
  CrossEncoderHit,
  CrossEncoderReranker,
  CrossEncoderResult,
} from "./types.js";

export class LocalCrossEncoderReranker implements CrossEncoderReranker {
  readonly kind = "local_cross_encoder" as const;

  async rerank(
    query: string,
    documents: CrossEncoderDocument[],
    topK = 10,
  ): Promise<CrossEncoderResult> {
    const started = Date.now();
    const scored: CrossEncoderHit[] = documents.map((doc) => ({
      id: doc.id,
      text: doc.text,
      score: pairwiseInteractionScore(query, doc.text),
    }));
    scored.sort((a, b) => b.score - a.score);
    return {
      results: scored.slice(0, Math.max(1, topK)),
      backend: "local_cross_encoder",
      latencyMs: Date.now() - started,
    };
  }
}

export class PassthroughReranker implements CrossEncoderReranker {
  readonly kind = "passthrough" as const;

  async rerank(
    _query: string,
    documents: CrossEncoderDocument[],
    topK = 10,
  ): Promise<CrossEncoderResult> {
    return {
      results: documents.slice(0, topK).map((d, i) => ({
        id: d.id,
        text: d.text,
        score: 1 - i * 0.01,
      })),
      backend: "passthrough",
      latencyMs: 0,
    };
  }
}

export class HttpCrossEncoderReranker implements CrossEncoderReranker {
  readonly kind = "http" as const;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly fallback: CrossEncoderReranker,
  ) {}

  async rerank(
    query: string,
    documents: CrossEncoderDocument[],
    topK = 10,
  ): Promise<CrossEncoderResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          documents: documents.map((d) => ({ id: d.id, text: d.text })),
          top_k: topK,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`rerank_http_${response.status}`);
      }
      const data = (await response.json()) as {
        results?: Array<{ id: string; score: number; text?: string }>;
      };
      const byId = new Map(documents.map((d) => [d.id, d.text]));
      const results = (data.results ?? [])
        .map((r) => ({
          id: r.id,
          score: r.score,
          text: r.text ?? byId.get(r.id) ?? "",
        }))
        .slice(0, topK);
      if (results.length === 0) {
        throw new Error("rerank_http_empty");
      }
      return {
        results,
        backend: "http",
        latencyMs: Date.now() - started,
      };
    } catch {
      return this.fallback.rerank(query, documents, topK);
    } finally {
      clearTimeout(timer);
    }
  }
}
