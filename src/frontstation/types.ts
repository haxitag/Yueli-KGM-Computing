/**
 * 前站浅层核（encoder 轨）：意图 / Cross-Encoder / extractive 摘要。
 * 生成式 Native GPU 仍为 decoder-only，不混入本模块。
 */
import type { Summarizer } from "./extractiveSummary.js";

export type FrontStationIntentLabel =
  | "knowledge_query"
  | "path_analysis"
  | "summary"
  | "risk_analysis"
  | "code_generation"
  | "structured_output"
  | "math_reasoning"
  | "translation"
  | "reasoning"
  | "general";

export type IntentBackend = "local_neural" | "http" | "heuristic" | "onnx";

export type IntentClassification = {
  intent: FrontStationIntentLabel;
  confidence: number;
  scores: Record<string, number>;
  backend: IntentBackend;
  /** 兼容 KCE 旧 intent 字符串 */
  kceIntent: string;
};

export type CrossEncoderDocument = {
  id: string;
  text: string;
};

export type CrossEncoderHit = {
  id: string;
  score: number;
  text: string;
};

export type CrossEncoderBackend = "local_cross_encoder" | "http" | "passthrough" | "onnx";

export type CrossEncoderResult = {
  results: CrossEncoderHit[];
  backend: CrossEncoderBackend;
  latencyMs: number;
};

export interface IntentClassifier {
  readonly kind: IntentBackend;
  classify(text: string): Promise<IntentClassification>;
}

export interface CrossEncoderReranker {
  readonly kind: CrossEncoderBackend;
  rerank(query: string, documents: CrossEncoderDocument[], topK?: number): Promise<CrossEncoderResult>;
}

export type FrontStationMode = "auto" | "onnx" | "http" | "local_neural" | "heuristic" | "off";

export type FrontStationConfig = {
  /** 顶层模式；细粒度 intent/rerank/summary 可分别覆盖 */
  mode: FrontStationMode;
  intentMode: "auto" | "onnx" | "http" | "local_neural" | "heuristic";
  rerankMode: "auto" | "onnx" | "http" | "local_cross_encoder" | "off";
  summaryMode: "auto" | "local" | "http" | "off";
  intentHttpUrl?: string;
  rerankHttpUrl?: string;
  summaryHttpUrl?: string;
  /** Transformers.js / ONNX MiniLM 模型 id */
  onnxModelId: string;
  onnxDevice?: string;
  onnxDtype?: string;
  /** 是否允许 auto 尝试加载本机 MiniLM ONNX */
  preferOnnx: boolean;
  timeoutMs: number;
};

function parseMode(raw: string | undefined, fallback: FrontStationMode): FrontStationMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "auto" || v === "onnx" || v === "http" || v === "local_neural" || v === "heuristic" || v === "off") {
    return v;
  }
  return fallback;
}

export function resolveFrontStationConfig(env: NodeJS.ProcessEnv = process.env): FrontStationConfig {
  const mode = parseMode(env.KGM_FRONTSTATION_MODE, "auto");
  const intentRaw = (env.KGM_FRONTSTATION_INTENT_MODE ?? mode).trim().toLowerCase();
  const rerankRaw = (env.KGM_FRONTSTATION_RERANK_MODE ?? mode).trim().toLowerCase();
  const summaryRaw = (env.KGM_FRONTSTATION_SUMMARY_MODE ?? "local").trim().toLowerCase();

  const intentMode =
    intentRaw === "auto" ||
    intentRaw === "onnx" ||
    intentRaw === "http" ||
    intentRaw === "local_neural" ||
    intentRaw === "heuristic"
      ? intentRaw
      : mode === "heuristic"
        ? "heuristic"
        : mode === "http"
          ? "http"
          : mode === "onnx"
            ? "onnx"
            : "auto";

  const rerankMode =
    rerankRaw === "auto" ||
    rerankRaw === "onnx" ||
    rerankRaw === "http" ||
    rerankRaw === "local_cross_encoder" ||
    rerankRaw === "off"
      ? rerankRaw
      : mode === "off"
        ? "off"
        : mode === "http"
          ? "http"
          : mode === "onnx"
            ? "onnx"
            : "auto";

  const summaryMode =
    summaryRaw === "auto" || summaryRaw === "local" || summaryRaw === "http" || summaryRaw === "off"
      ? summaryRaw
      : "local";

  const preferOnnx =
    (env.KGM_FRONTSTATION_PREFER_ONNX ?? "1").trim() !== "0" &&
    (env.KGM_FRONTSTATION_PREFER_ONNX ?? "1").trim().toLowerCase() !== "false";

  return {
    mode,
    intentMode,
    rerankMode,
    summaryMode,
    intentHttpUrl: (env.KGM_FRONTSTATION_INTENT_URL ?? "").trim() || undefined,
    rerankHttpUrl: (env.KGM_FRONTSTATION_RERANK_URL ?? env.KGM_RERANK_HTTP_URL ?? "").trim() || undefined,
    summaryHttpUrl: (env.KGM_FRONTSTATION_SUMMARY_URL ?? "").trim() || undefined,
    onnxModelId: (env.KGM_FRONTSTATION_ONNX_MODEL ?? "Xenova/all-MiniLM-L6-v2").trim(),
    onnxDevice: (env.KGM_FRONTSTATION_ONNX_DEVICE ?? "").trim() || undefined,
    onnxDtype: (env.KGM_FRONTSTATION_ONNX_DTYPE ?? "").trim() || undefined,
    preferOnnx,
    timeoutMs: Math.max(50, Number.parseInt(env.KGM_FRONTSTATION_TIMEOUT_MS ?? "8000", 10) || 8000),
  };
}

export type { Summarizer };
