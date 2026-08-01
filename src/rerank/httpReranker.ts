import { postJson } from "../utils/http.js";
import type { Evidence } from "../core/types.js";

/**
 * 将候选交给外部「Cross-Encoder / rerank」HTTP 服务（Cohere、Jina、自托管等）。
 * 环境变量：KGM_RERANK_HTTP_URL（必须），KGM_RERANK_HTTP_KEY（可选），KGM_RERANK_HTTP_TIMEOUT_MS
 *
 * 请求体：{ "query": string, "candidates": [{ "id", "text" }] }
 * 响应：{ "scores": number[] } 与 candidates 等长，或 { "candidates": [{ "id", "score" }] }
 */
export async function rerankByHttp(
  query: string,
  evidence: Evidence[],
  options?: { baseUrl?: string; apiKey?: string; timeoutMs?: number },
): Promise<Evidence[]> {
  if (evidence.length === 0) {
    return evidence;
  }
  const base =
    options?.baseUrl?.trim() ||
    (process.env.KGM_RERANK_HTTP_URL ?? "").trim();
  if (!base) {
    throw new Error("KGM_RERANK_HTTP_URL is not set");
  }
  const url = base.includes("://") ? base : `http://${base}`;
  const timeoutMs =
    options?.timeoutMs ?? Number.parseInt(process.env.KGM_RERANK_HTTP_TIMEOUT_MS ?? "30000", 10);
  const apiKey = options?.apiKey ?? process.env.KGM_RERANK_HTTP_KEY;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const body = {
    query,
    candidates: evidence.map((e) => ({ id: e.id, text: e.text })),
  };
  const data = (await postJson(url, body, { headers, timeoutMs })) as
    | { scores?: number[]; candidates?: Array<{ id: string; score: number }> }
    | Record<string, unknown>;

  if (Array.isArray((data as { scores?: number[] }).scores)) {
    const scores = (data as { scores: number[] }).scores;
    if (scores.length !== evidence.length) {
      throw new Error("rerank: scores length mismatch");
    }
    const maxS = Math.max(1e-9, ...scores);
    return evidence
      .map((e, i) => ({ ...e, score: (scores[i] ?? 0) / maxS }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  const withIds = (data as { candidates?: Array<{ id: string; score: number }> }).candidates;
  if (withIds) {
    const m = new Map(withIds.map((c) => [c.id, c.score]));
    return evidence
      .map((e) => ({ ...e, score: m.get(e.id) ?? e.score ?? 0 }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  throw new Error("rerank: unexpected response (need scores or candidates[])");
}
