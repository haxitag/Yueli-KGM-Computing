/**
 * 本地神经浅层核：特征哈希嵌入 + 原型/交互打分。
 * 无外依赖可执行；结构对齐 BERT/MiniLM 前后脚（嵌入→分类 / query-doc 交互），
 * 可用 HTTP worker 替换为真实 BERT 输出同维向量。
 */

const DIM = 64;

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 字符/词 n-gram 特征哈希到固定维单位向量 */
export function hashEmbed(text: string, dim = DIM): Float32Array {
  const vec = new Float32Array(dim);
  const normalized = text.toLowerCase().normalize("NFKC").trim();
  if (!normalized) {
    return vec;
  }
  const tokens = normalized.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const grams: string[] = [...tokens];
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.push(normalized.slice(i, i + 2));
  }
  for (let i = 0; i < normalized.length - 2; i += 1) {
    grams.push(normalized.slice(i, i + 3));
  }
  for (const g of grams) {
    const h = fnv1a(g);
    const idx = h % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[idx]! += sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    norm += vec[i]! * vec[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) {
    vec[i]! /= norm;
  }
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/** query-doc 交互：拼接 + 逐维乘积的摘要 → 标量分数（类浅层 CE） */
export function pairwiseInteractionScore(query: string, document: string): number {
  const q = hashEmbed(query);
  const d = hashEmbed(document);
  const cos = cosine(q, d);
  let hadamard = 0;
  for (let i = 0; i < q.length; i += 1) {
    hadamard += q[i]! * d[i]!;
  }
  // 长度归一的字符重叠
  const qSet = new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
  const dTokens = document.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
  let overlap = 0;
  for (const t of dTokens) {
    if (qSet.has(t)) overlap += 1;
  }
  const overlapRatio = dTokens.length ? overlap / dTokens.length : 0;
  return 0.55 * cos + 0.25 * hadamard + 0.2 * overlapRatio;
}

export { DIM as FRONTSTATION_EMBED_DIM };
