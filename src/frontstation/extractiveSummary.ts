/**
 * 前站原子算子：抽取式摘要（extractive），不调用生成式 LLM / decoder-only Native。
 * 实现：句子分割 + TF 词重叠图 + TextRank 风格选句。
 */
export type ExtractiveSummaryOptions = {
  maxSentences?: number;
  maxChars?: number;
  languageHint?: string;
};

export type ExtractiveSummaryResult = {
  summary: string;
  sentences: Array<{ text: string; score: number; index: number }>;
  backend: "extractive_textrank" | "http";
  latencyMs: number;
};

export interface Summarizer {
  readonly kind: ExtractiveSummaryResult["backend"];
  summarize(text: string, options?: ExtractiveSummaryOptions): Promise<ExtractiveSummaryResult>;
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/(?<=[。！？.!?；;])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  return parts.length > 0 ? parts : [normalized];
}

function tokenize(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1);
}

function sentenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let overlap = 0;
  for (const t of a) {
    if (setB.has(t)) overlap += 1;
  }
  return overlap / (Math.log(1 + a.length) + Math.log(1 + b.length));
}

/** TextRank 选句（阻尼迭代） */
export function extractiveSummarize(
  text: string,
  options: ExtractiveSummaryOptions = {},
): ExtractiveSummaryResult {
  const started = Date.now();
  const maxSentences = Math.max(1, options.maxSentences ?? 3);
  const maxChars = Math.max(40, options.maxChars ?? 480);
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) {
    const joined = sentences.join(options.languageHint?.startsWith("zh") ? "" : " ");
    return {
      summary: joined.slice(0, maxChars),
      sentences: sentences.map((s, i) => ({ text: s, score: 1 - i * 0.01, index: i })),
      backend: "extractive_textrank",
      latencyMs: Date.now() - started,
    };
  }

  const tokens = sentences.map(tokenize);
  const n = sentences.length;
  const scores = new Float64Array(n).fill(1 / n);
  const damping = 0.85;
  const iters = 20;

  for (let iter = 0; iter < iters; iter += 1) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const sim = sentenceSimilarity(tokens[i]!, tokens[j]!);
        if (sim <= 0) continue;
        let out = 0;
        for (let k = 0; k < n; k += 1) {
          if (k === j) continue;
          out += sentenceSimilarity(tokens[j]!, tokens[k]!);
        }
        sum += out > 0 ? (sim / out) * scores[j]! : 0;
      }
      next[i] = (1 - damping) / n + damping * sum;
    }
    scores.set(next);
  }

  const ranked = Array.from({ length: n }, (_, i) => ({
    text: sentences[i]!,
    score: scores[i]!,
    index: i,
  })).sort((a, b) => b.score - a.score);

  const selected = ranked
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index);

  let summary = selected.map((s) => s.text).join(options.languageHint?.startsWith("zh") ? "" : " ");
  if (summary.length > maxChars) {
    summary = `${summary.slice(0, maxChars - 1)}…`;
  }

  return {
    summary,
    sentences: ranked,
    backend: "extractive_textrank",
    latencyMs: Date.now() - started,
  };
}

export class LocalExtractiveSummarizer implements Summarizer {
  readonly kind = "extractive_textrank" as const;

  async summarize(text: string, options?: ExtractiveSummaryOptions): Promise<ExtractiveSummaryResult> {
    return Promise.resolve(extractiveSummarize(text, options));
  }
}

export class HttpExtractiveSummarizer implements Summarizer {
  readonly kind = "http" as const;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly fallback: Summarizer,
  ) {}

  async summarize(text: string, options?: ExtractiveSummaryOptions): Promise<ExtractiveSummaryResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          max_sentences: options?.maxSentences,
          max_chars: options?.maxChars,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`summary_http_${response.status}`);
      const data = (await response.json()) as {
        summary?: string;
        sentences?: Array<{ text: string; score: number; index: number }>;
      };
      if (!data.summary?.trim()) throw new Error("summary_http_empty");
      return {
        summary: data.summary.trim(),
        sentences: data.sentences ?? [],
        backend: "http",
        latencyMs: Date.now() - started,
      };
    } catch {
      return this.fallback.summarize(text, options);
    } finally {
      clearTimeout(timer);
    }
  }
}
