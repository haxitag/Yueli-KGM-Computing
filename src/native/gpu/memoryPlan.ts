import type { NativeModelConfig } from "../types.js";
import type { NativeGpuDtype, NativeGpuMemoryPlan } from "./types.js";

function bytesPerElement(dtype: NativeGpuDtype): number {
  switch (dtype) {
    case "fp16":
    case "bf16":
      return 2;
    default:
      return 2;
  }
}

/**
 * Phase 6.2（SIM）：
 * - 真实 GPU backend 需要精细化 memory planner（KV cache / scratch / weights / fragmentation）。
 * - 当前仅提供 deterministic 的估算，用于回归与容量口径。
 */
export function buildGpuMemoryPlan(params: {
  modelConfig: NativeModelConfig;
  dtype: NativeGpuDtype;
  /** 预估服务侧最大并发会话数（影响 KV cache 预算） */
  maxSessions?: number;
  /** 预估每 session 最长上下文长度（影响 KV cache 预算） */
  maxContextTokens?: number;
}): NativeGpuMemoryPlan {
  const cfg = params.modelConfig;
  const bpe = bytesPerElement(params.dtype);
  const layers = Math.max(0, cfg.numLayers);
  const heads = Math.max(1, cfg.numHeads);
  const kvHeads = Math.max(1, cfg.numKvHeads ?? cfg.numHeads);
  const headDim = Math.max(1, Math.floor(cfg.hiddenSize / heads));
  const maxSessions = Math.max(1, params.maxSessions ?? 1);
  const maxCtx = Math.max(1, params.maxContextTokens ?? Math.min(2048, cfg.maxPositionEmbeddings));

  // KV cache（估算）：layers * (K+V) * sessions * tokens * kvHeads * headDim * bytes
  const kvPerToken = 2 * kvHeads * headDim * bpe;
  const kvCache = layers * maxSessions * maxCtx * kvPerToken;

  // activations scratch（估算）：hiddenSize * bytes * 常数
  const activationsScratch = cfg.hiddenSize * bpe * 64;

  // weights（估算）：按参数量近似（embed + lm_head + layers * (qkv/o + mlp)）
  const vocab = Math.max(1, cfg.vocabSize);
  const embed = vocab * cfg.hiddenSize * bpe;
  const head = vocab * cfg.hiddenSize * bpe;
  const perLayer = (4 * cfg.hiddenSize * cfg.hiddenSize + 3 * cfg.hiddenSize * cfg.intermediateSize) * bpe;
  const weights = embed + head + layers * perLayer;

  const total = kvCache + activationsScratch + weights;
  const notes = [
    "SIM memory plan: deterministic estimate (not a real allocator).",
    `dtype=${params.dtype} bytesPerElement=${bpe}`,
    `sessions=${maxSessions} maxContextTokens=${maxCtx}`,
  ];

  return {
    modelConfig: cfg,
    dtype: params.dtype,
    bytes: {
      kvCache,
      activationsScratch,
      weights,
      total,
    },
    notes,
  };
}

