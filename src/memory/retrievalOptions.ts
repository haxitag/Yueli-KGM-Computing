import type { KgmRetrievalOptions } from "../core/types.js";
import type { MemorySearchOptions } from "./store.js";

/**
 * 将请求体中的 `kgm.retrieval` 或 HTTP 查询参数，映射为 MemoryStore.search 的选项。
 * `strategy=hybrid` 且未显式 `lexicalWeight` 时启用 BM25 混合（默认权重 0.35）。
 */
export function memorySearchOptionsFromKgm(r: KgmRetrievalOptions | undefined): MemorySearchOptions | undefined {
  if (!r) {
    return undefined;
  }
  const strategy = r.strategy ?? "vector";
  const lexicalWeight = r.lexicalWeight ?? (strategy === "hybrid" ? 0.35 : 0);
  const rerank = r.rerank && r.rerank !== "off" ? r.rerank : "off";
  const out: MemorySearchOptions = {};
  if (lexicalWeight > 0) {
    out.lexicalWeight = lexicalWeight;
    out.overFetch = r.overFetch ?? 3;
  } else if (rerank !== "off" && r.overFetch == null) {
    out.overFetch = 3;
  } else if (r.overFetch != null) {
    out.overFetch = r.overFetch;
  }
  if (rerank !== "off") {
    out.rerank = r.rerank;
    out.rerankBlend = r.rerankBlend ?? 0.5;
  }
  if (Object.keys(out).length === 0) {
    return undefined;
  }
  return out;
}
