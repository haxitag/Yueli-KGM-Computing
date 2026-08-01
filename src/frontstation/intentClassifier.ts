import { cosine, hashEmbed } from "./shallowKernel.js";
import type {
  FrontStationIntentLabel,
  IntentClassification,
  IntentClassifier,
} from "./types.js";

const INTENT_PROTOTYPES: Record<FrontStationIntentLabel, string[]> = {
  path_analysis: ["路径", "关系链", "path analysis", "how are they connected", "关联路径", "路径分析"],
  summary: ["总结", "概括", "摘要", "summary", "summarize", "tl;dr"],
  risk_analysis: ["风险", "risk", "合规", "漏洞", "threat"],
  code_generation: ["代码", "函数", "typescript", "python", "bug", "api", "编程"],
  structured_output: ["json", "schema", "表格", "结构化", "output format"],
  math_reasoning: ["计算", "方程", "积分", "math", "prove", "求解"],
  translation: ["翻译", "translate", "英文", "中文", "日文"],
  reasoning: ["为什么", "推理", "分析原因", "why", "reason about"],
  knowledge_query: ["是什么", "什么是", "介绍", "who is", "what is", "知识"],
  general: ["你好", "hello", "帮我", "please"],
};

const KCE_MAP: Partial<Record<FrontStationIntentLabel, string>> = {
  path_analysis: "path_analysis",
  summary: "summary",
  risk_analysis: "risk_analysis",
  knowledge_query: "knowledge_query",
};

function toKceIntent(intent: FrontStationIntentLabel): string {
  return KCE_MAP[intent] ?? "knowledge_query";
}

/** 与 KCE 历史 detectIntent + 路由关键字对齐的硬闸（非 ML） */
export function resolveKeywordIntent(text: string): FrontStationIntentLabel | null {
  const lower = text.toLowerCase();
  if (lower.includes("path") || text.includes("路径") || text.includes("关系链")) {
    return "path_analysis";
  }
  if (lower.includes("summary") || text.includes("总结") || text.includes("概括")) {
    return "summary";
  }
  if (lower.includes("risk") || text.includes("风险")) {
    return "risk_analysis";
  }
  if (/(typescript|javascript|python|代码|编程|函数)/.test(lower) || /代码/.test(text)) {
    return "code_generation";
  }
  if (/(json|schema|结构化)/.test(lower)) {
    return "structured_output";
  }
  if (/(math|积分|方程|计算)/.test(lower) || /求解/.test(text)) {
    return "math_reasoning";
  }
  if (/(translate|翻译)/.test(lower)) {
    return "translation";
  }
  if (/(why|为什么|推理)/.test(lower) || /为什么/.test(text)) {
    return "reasoning";
  }
  return null;
}

function softmaxScores(raw: Record<string, number>): Record<string, number> {
  const keys = Object.keys(raw);
  const max = Math.max(...keys.map((k) => raw[k]!));
  let sum = 0;
  const exps: Record<string, number> = {};
  for (const k of keys) {
    exps[k] = Math.exp(raw[k]! - max);
    sum += exps[k]!;
  }
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = sum > 0 ? exps[k]! / sum : 0;
  }
  return out;
}

function detectHeuristicIntentLabel(text: string): FrontStationIntentLabel {
  const lower = text.toLowerCase();
  if (lower.includes("path") || text.includes("路径") || text.includes("关系链")) {
    return "path_analysis";
  }
  if (lower.includes("summary") || text.includes("总结") || text.includes("概括")) {
    return "summary";
  }
  if (lower.includes("risk") || text.includes("风险")) {
    return "risk_analysis";
  }
  if (/(typescript|javascript|python|代码|编程|函数)/.test(lower) || /代码/.test(text)) {
    return "code_generation";
  }
  if (/(json|schema|结构化)/.test(lower)) {
    return "structured_output";
  }
  if (/(math|积分|方程|计算)/.test(lower) || /求解/.test(text)) {
    return "math_reasoning";
  }
  if (/(translate|翻译)/.test(lower)) {
    return "translation";
  }
  if (/(why|为什么|推理)/.test(lower) || /为什么/.test(text)) {
    return "reasoning";
  }
  return "knowledge_query";
}

export class LocalNeuralIntentClassifier implements IntentClassifier {
  readonly kind = "local_neural" as const;
  private prototypes: { label: FrontStationIntentLabel; vec: Float32Array }[];

  constructor() {
    this.prototypes = (Object.keys(INTENT_PROTOTYPES) as FrontStationIntentLabel[]).map((label) => ({
      label,
      vec: hashEmbed(INTENT_PROTOTYPES[label].join(" \n ")),
    }));
  }

  async classify(text: string): Promise<IntentClassification> {
    return Promise.resolve(this.classifySync(text));
  }

  classifySync(text: string): IntentClassification {
    const q = hashEmbed(text);
    const raw: Record<string, number> = {};
    for (const p of this.prototypes) {
      raw[p.label] = cosine(q, p.vec);
    }
    const scores = softmaxScores(raw);
    let best: FrontStationIntentLabel = "general";
    let bestScore = -1;
    for (const [label, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        best = label as FrontStationIntentLabel;
      }
    }

    // 高信号关键字硬闸：与历史 detectIntent / Heuristic 对齐，避免 hash 原型抢走「路径/总结/风险」等
    const keywordIntent = detectHeuristicIntentLabel(text);
    if (keywordIntent !== "knowledge_query") {
      const boosted = Math.max(scores[keywordIntent] ?? 0, 0.72, bestScore);
      return {
        intent: keywordIntent,
        confidence: boosted,
        scores: { ...scores, [keywordIntent]: boosted },
        backend: "local_neural",
        kceIntent: toKceIntent(keywordIntent),
      };
    }

    return {
      intent: best,
      confidence: bestScore,
      scores,
      backend: "local_neural",
      kceIntent: toKceIntent(best),
    };
  }
}

export class HeuristicIntentClassifier implements IntentClassifier {
  readonly kind = "heuristic" as const;

  async classify(text: string): Promise<IntentClassification> {
    return Promise.resolve(this.classifySync(text));
  }

  classifySync(text: string): IntentClassification {
    const intent = detectHeuristicIntentLabel(text);
    return {
      intent,
      confidence: 0.55,
      scores: { [intent]: 0.55 },
      backend: "heuristic",
      kceIntent: toKceIntent(intent),
    };
  }
}

export class HttpIntentClassifier implements IntentClassifier {
  readonly kind = "http" as const;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly fallback: IntentClassifier,
  ) {}

  async classify(text: string): Promise<IntentClassification> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`intent_http_${response.status}`);
      }
      const data = (await response.json()) as {
        intent?: string;
        confidence?: number;
        scores?: Record<string, number>;
      };
      const intent = (data.intent ?? "knowledge_query") as FrontStationIntentLabel;
      const confidence = typeof data.confidence === "number" ? data.confidence : 0.5;
      return {
        intent,
        confidence,
        scores: data.scores ?? { [intent]: confidence },
        backend: "http",
        kceIntent: toKceIntent(intent),
      };
    } catch {
      return this.fallback.classify(text);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** AutoRouting 任务类型映射 */
export function intentToRoutingTaskType(intent: FrontStationIntentLabel, fallback: string): string {
  switch (intent) {
    case "code_generation":
      return "code_generation";
    case "structured_output":
      return "structured_output";
    case "math_reasoning":
      return "math_reasoning";
    case "translation":
      return "translation";
    case "reasoning":
    case "risk_analysis":
    case "path_analysis":
      return "reasoning";
    case "summary":
    case "knowledge_query":
    case "general":
      return fallback === "general" ? "general" : fallback;
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}
