import {
  HeuristicIntentClassifier,
  HttpIntentClassifier,
  LocalNeuralIntentClassifier,
} from "./intentClassifier.js";
import {
  HttpCrossEncoderReranker,
  LocalCrossEncoderReranker,
  PassthroughReranker,
} from "./crossEncoder.js";
import { tryCreateOnnxEmbedBackend } from "./encoderBackend.js";
import {
  HttpExtractiveSummarizer,
  LocalExtractiveSummarizer,
  type Summarizer,
} from "./extractiveSummary.js";
import { CascadingCrossEncoder, OnnxEmbedCrossEncoder } from "./onnxCrossEncoder.js";
import { CascadingIntentClassifier, OnnxIntentClassifier } from "./onnxIntent.js";
import {
  resolveFrontStationConfig,
  type CrossEncoderReranker,
  type FrontStationConfig,
  type IntentClassification,
  type IntentClassifier,
} from "./types.js";

export type FrontStationBundle = {
  config: FrontStationConfig;
  intent: IntentClassifier;
  reranker: CrossEncoderReranker;
  summarizer: Summarizer;
  /** encoder 轨标识，避免与 decoder-only Native GPU 混淆 */
  track: "encoder_frontstation";
};

let cached: FrontStationBundle | undefined;

class LazyOnnxIntentClassifier implements IntentClassifier {
  readonly kind = "onnx" as const;
  private resolved: IntentClassifier | undefined;

  constructor(
    private readonly fallback: IntentClassifier,
    private readonly config: FrontStationConfig,
  ) {}

  private async resolve(): Promise<IntentClassifier> {
    if (this.resolved) return this.resolved;
    const backend = await tryCreateOnnxEmbedBackend({
      modelId: this.config.onnxModelId,
      device: this.config.onnxDevice,
      dtype: this.config.onnxDtype,
    });
    this.resolved = backend
      ? new CascadingIntentClassifier(new OnnxIntentClassifier(backend), this.fallback)
      : this.fallback;
    return this.resolved;
  }

  async classify(text: string): Promise<IntentClassification> {
    const clf = await this.resolve();
    return clf.classify(text);
  }
}

class LazyOnnxReranker implements CrossEncoderReranker {
  readonly kind = "onnx" as const;
  private resolved: CrossEncoderReranker | undefined;

  constructor(
    private readonly fallback: CrossEncoderReranker,
    private readonly config: FrontStationConfig,
  ) {}

  private async resolve(): Promise<CrossEncoderReranker> {
    if (this.resolved) return this.resolved;
    const backend = await tryCreateOnnxEmbedBackend({
      modelId: this.config.onnxModelId,
      device: this.config.onnxDevice,
      dtype: this.config.onnxDtype,
    });
    this.resolved = backend
      ? new CascadingCrossEncoder(new OnnxEmbedCrossEncoder(backend), this.fallback)
      : this.fallback;
    return this.resolved;
  }

  async rerank(
    query: string,
    documents: Parameters<CrossEncoderReranker["rerank"]>[1],
    topK?: number,
  ) {
    const reranker = await this.resolve();
    return reranker.rerank(query, documents, topK);
  }
}

function buildIntent(config: FrontStationConfig): IntentClassifier {
  const localIntent = new LocalNeuralIntentClassifier();
  const heuristic = new HeuristicIntentClassifier();

  if (config.intentMode === "heuristic") {
    return heuristic;
  }

  let base: IntentClassifier = localIntent;
  if (config.intentMode === "http" || (config.intentMode === "auto" && config.intentHttpUrl)) {
    if (config.intentHttpUrl) {
      base = new HttpIntentClassifier(config.intentHttpUrl, config.timeoutMs, localIntent);
    }
  }

  const wantOnnx =
    config.intentMode === "onnx" ||
    (config.intentMode === "auto" && config.preferOnnx);

  if (wantOnnx) {
    return new LazyOnnxIntentClassifier(base, config);
  }
  return base;
}

function buildReranker(config: FrontStationConfig): CrossEncoderReranker {
  const localCe = new LocalCrossEncoderReranker();
  if (config.rerankMode === "off") {
    return new PassthroughReranker();
  }

  let base: CrossEncoderReranker = localCe;
  if (config.rerankMode === "http" || (config.rerankMode === "auto" && config.rerankHttpUrl)) {
    if (config.rerankHttpUrl) {
      base = new HttpCrossEncoderReranker(config.rerankHttpUrl, config.timeoutMs, localCe);
    }
  }

  const wantOnnx =
    config.rerankMode === "onnx" ||
    (config.rerankMode === "auto" && config.preferOnnx);

  if (wantOnnx) {
    return new LazyOnnxReranker(base, config);
  }
  return base;
}

function buildSummarizer(config: FrontStationConfig): Summarizer {
  const local = new LocalExtractiveSummarizer();
  if (config.summaryMode === "off") {
    return local;
  }
  if (
    (config.summaryMode === "http" || config.summaryMode === "auto") &&
    config.summaryHttpUrl
  ) {
    return new HttpExtractiveSummarizer(config.summaryHttpUrl, config.timeoutMs, local);
  }
  return local;
}

export function createFrontStation(env: NodeJS.ProcessEnv = process.env): FrontStationBundle {
  const config = resolveFrontStationConfig(env);
  return {
    config,
    intent: buildIntent(config),
    reranker: buildReranker(config),
    summarizer: buildSummarizer(config),
    track: "encoder_frontstation",
  };
}

export function getFrontStation(): FrontStationBundle {
  if (!cached) {
    cached = createFrontStation();
  }
  return cached;
}

export function resetFrontStationForTests(): void {
  cached = undefined;
}

/** 同步意图（AutoRouting 热路径）：关键字 + local_neural，不阻塞 ONNX 冷启动 */
export function classifyIntentSync(text: string): IntentClassification {
  return new LocalNeuralIntentClassifier().classifySync(text);
}

/** 异步意图：走完整级联（ONNX / HTTP / local） */
export async function classifyIntent(text: string): Promise<IntentClassification> {
  return getFrontStation().intent.classify(text);
}
