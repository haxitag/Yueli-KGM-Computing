import type { Embedder } from "../embedding/canonical.js";
import type { Evidence } from "../core/types.js";
import { cosineSimilarity } from "./cosine.js";

/**
 * 使用同一 Embedder 对「query / passage」成对编码后的余弦，作为二阶段重排分。
 * 非真实训练过的 Cross-Encoder，但在不新增依赖时是最接近的「可插拔重排器」基线。
 */
export async function rerankByEmbeddingPair(
  query: string,
  evidence: Evidence[],
  embedder: Embedder,
  blend: number,
): Promise<Evidence[]> {
  if (evidence.length === 0) {
    return evidence;
  }
  const b = Math.max(0, Math.min(1, blend));
  const qv = await embedder.embed(`query: ${query.slice(0, 4000)}`);
  const pairScores: number[] = [];
  for (const e of evidence) {
    const pv = await embedder.embed(`passage: ${e.text.slice(0, 8000)}`);
    pairScores.push(cosineSimilarity(qv, pv));
  }
  const maxP = Math.max(1e-9, ...pairScores);
  const norm = pairScores.map((s) => s / maxP);
  const merged = evidence.map((e, i) => ({
    ...e,
    score: (1 - b) * (e.score ?? 0) + b * (norm[i] ?? 0),
  }));
  merged.sort((a, b2) => (b2.score ?? 0) - (a.score ?? 0));
  return merged;
}
