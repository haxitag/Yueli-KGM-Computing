import { cosineSimilarity, type EncoderEmbedBackend } from "./encoderBackend.js";
import type {
  CrossEncoderDocument,
  CrossEncoderHit,
  CrossEncoderReranker,
  CrossEncoderResult,
} from "./types.js";

/**
 * MiniLM ONNX「类 Cross-Encoder」：query/doc 真实嵌入余弦（encoder 轨）。
 * 真 BERT CE 权重优先走 HTTP micro-worker（sentence-transformers CrossEncoder）。
 */
export class OnnxEmbedCrossEncoder implements CrossEncoderReranker {
  readonly kind = "onnx" as const;

  constructor(private readonly backend: EncoderEmbedBackend) {}

  async rerank(
    query: string,
    documents: CrossEncoderDocument[],
    topK = 10,
  ): Promise<CrossEncoderResult> {
    const started = Date.now();
    const q = await this.backend.embed(query);
    const scored: CrossEncoderHit[] = [];
    for (const doc of documents) {
      const d = await this.backend.embed(doc.text);
      scored.push({
        id: doc.id,
        text: doc.text,
        score: cosineSimilarity(q, d),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      results: scored.slice(0, Math.max(1, topK)),
      backend: "onnx",
      latencyMs: Date.now() - started,
    };
  }
}

export class CascadingCrossEncoder implements CrossEncoderReranker {
  readonly kind: CrossEncoderResult["backend"];

  constructor(
    private readonly primary: CrossEncoderReranker,
    private readonly fallback: CrossEncoderReranker,
  ) {
    this.kind = primary.kind;
  }

  async rerank(
    query: string,
    documents: CrossEncoderDocument[],
    topK?: number,
  ): Promise<CrossEncoderResult> {
    try {
      return await this.primary.rerank(query, documents, topK);
    } catch {
      return this.fallback.rerank(query, documents, topK);
    }
  }
}
