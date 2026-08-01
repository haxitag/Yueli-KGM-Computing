import {
  cosineSimilarity,
  embedIntentPrototypes,
  type EncoderEmbedBackend,
} from "./encoderBackend.js";
import { HeuristicIntentClassifier } from "./intentClassifier.js";
import { INTENT_PROTOTYPE_TEXTS } from "./intentPrototypes.js";
import type {
  FrontStationIntentLabel,
  IntentClassification,
  IntentClassifier,
} from "./types.js";

const KCE_MAP: Partial<Record<FrontStationIntentLabel, string>> = {
  path_analysis: "path_analysis",
  summary: "summary",
  risk_analysis: "risk_analysis",
  knowledge_query: "knowledge_query",
};

function toKceIntent(intent: FrontStationIntentLabel): string {
  return KCE_MAP[intent] ?? "knowledge_query";
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

/**
 * MiniLM/ONNX 意图分类：真实 embedding 对原型打分 + 关键字硬闸（保持原链路稳定）。
 */
export class OnnxIntentClassifier implements IntentClassifier {
  readonly kind = "onnx" as const;
  private prototypes: Map<FrontStationIntentLabel, Float32Array> | undefined;
  private readonly heuristic = new HeuristicIntentClassifier();

  constructor(private readonly backend: EncoderEmbedBackend) {}

  private async ensurePrototypes(): Promise<Map<FrontStationIntentLabel, Float32Array>> {
    if (!this.prototypes) {
      this.prototypes = await embedIntentPrototypes(this.backend);
    }
    return this.prototypes;
  }

  async classify(text: string): Promise<IntentClassification> {
    const keyword = this.heuristic.classifySync(text);
    const prototypes = await this.ensurePrototypes();
    const q = await this.backend.embed(text);
    const raw: Record<string, number> = {};
    for (const label of Object.keys(INTENT_PROTOTYPE_TEXTS) as FrontStationIntentLabel[]) {
      const proto = prototypes.get(label);
      raw[label] = proto ? cosineSimilarity(q, proto) : 0;
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

    if (keyword.intent !== "knowledge_query") {
      const boosted = Math.max(scores[keyword.intent] ?? 0, 0.75, bestScore);
      return {
        intent: keyword.intent,
        confidence: boosted,
        scores: { ...scores, [keyword.intent]: boosted },
        backend: "onnx",
        kceIntent: toKceIntent(keyword.intent),
      };
    }

    return {
      intent: best,
      confidence: bestScore,
      scores,
      backend: "onnx",
      kceIntent: toKceIntent(best),
    };
  }
}

/** 主失败则回退，保证链路完备 */
export class CascadingIntentClassifier implements IntentClassifier {
  readonly kind: IntentClassification["backend"];

  constructor(
    private readonly primary: IntentClassifier,
    private readonly fallback: IntentClassifier,
  ) {
    this.kind = primary.kind;
  }

  async classify(text: string): Promise<IntentClassification> {
    try {
      return await this.primary.classify(text);
    } catch {
      return this.fallback.classify(text);
    }
  }
}
