/**
 * 小规模候选集上的 Okapi BM25 + 与向量分归一化后的线性混合，用于「混合检索」轻量重排。
 * 不引入外部依赖；适合在 topK*overFetch 条候选上工作。
 */

export function tokenizeForLexical(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-zA-Z0-9_\u4e00-\u9fa5]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function avgDocumentLength(terms: string[][]): number {
  if (terms.length === 0) {
    return 0;
  }
  const sum = terms.reduce((acc, t) => acc + t.length, 0);
  return sum / terms.length;
}

/**
 * 返回与 `documents` 等长的 BM25 分数（非负）。
 */
export function bm25Scores(
  query: string,
  documents: string[],
  k1 = 1.5,
  b = 0.75,
): number[] {
  const qTerms = tokenizeForLexical(query);
  if (qTerms.length === 0 || documents.length === 0) {
    return documents.map(() => 0);
  }

  const docTerms = documents.map((d) => tokenizeForLexical(d));
  const N = docTerms.length;
  const df = new Map<string, number>();
  for (const terms of docTerms) {
    const unique = new Set(terms);
    for (const t of unique) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const avgdl = avgDocumentLength(docTerms) || 1;

  return docTerms.map((terms) => {
    const dl = terms.length;
    const tf = new Map<string, number>();
    for (const t of terms) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t) ?? 0;
      if (f === 0) {
        continue;
      }
      const dfi = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
      const num = f * (k1 + 1);
      const den = f + k1 * (1 - b + (b * dl) / avgdl);
      score += idf * (num / den);
    }
    return Math.max(0, score);
  });
}

/**
 * 将 [0,1] 的向量分与 BM25 分（任意非负）做加权混合，再对混合分归一化到 [0,1] 并输出新分数。
 */
export function blendAndNormalize(
  vectorScores: number[],
  bm25: number[],
  lexicalWeight: number,
): number[] {
  if (vectorScores.length !== bm25.length) {
    return vectorScores;
  }
  const w = Math.max(0, Math.min(1, lexicalWeight));
  if (w === 0) {
    return vectorScores;
  }
  const maxB = Math.max(1e-9, ...bm25);
  const normBm = bm25.map((s) => s / maxB);
  const mixed = vectorScores.map((v, i) => (1 - w) * v + w * (normBm[i] ?? 0));
  const maxM = Math.max(1e-9, ...mixed);
  return mixed.map((m) => m / maxM);
}
