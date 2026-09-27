import type { Evidence } from "../core/types.js";
import type { Embedder } from "../embedding/canonical.js";
import type { MemorySearchOptions } from "../memory/store.js";
import { rerankByEmbeddingPair } from "./embeddingPairReranker.js";
import { rerankByHttp } from "./httpReranker.js";

export async function applyMemoryRerank(
  query: string,
  evidence: Evidence[],
  embedder: Embedder,
  options: MemorySearchOptions | undefined,
): Promise<Evidence[]> {
  const mode = options?.rerank ?? "off";
  if (mode === "off" || evidence.length === 0) {
    return evidence;
  }
  const blend = options?.rerankBlend ?? 0.5;
  if (mode === "embed") {
    return rerankByEmbeddingPair(query, evidence, embedder, blend);
  }
  if (mode === "http") {
    const reranked = await rerankByHttp(query, evidence);
    const b = Math.max(0, Math.min(1, blend));
    return evidence.map((e, i) => {
      const other = reranked.find((r) => r.id === e.id);
      return {
        ...e,
        score: (1 - b) * (e.score ?? 0) + b * (other?.score ?? 0),
      };
    }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  return evidence;
}
