import type { NativeModelConfig } from "../types.js";

/**
 * GPU 权重导入的最小目标：Qwen2.x decoder-only（HF/Transformers 常见命名）。
 *
 * 说明：
 * - 这里的 alias 规则与 `loaders.ts` 中 CPU reference safetensors alias 保持一致（同一张量命名约定）。
 * - 仅用于 **layout/import 对齐**（name/shape/dtype/offset），不涉及算子实现。
 */

export type Qwen2SafetensorsAlias = { target: string; source: string; shape: number[] };

function assertPositiveInt(value: number, label: string): number {
  const v = Math.trunc(value);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`native_gpu_invalid_config_${label}:${value}`);
  }
  return v;
}

export function buildQwen2SafetensorsAliases(params: {
  config: NativeModelConfig;
  tieWordEmbeddings?: boolean;
}): Qwen2SafetensorsAlias[] {
  const cfg = params.config;
  const vocab = assertPositiveInt(cfg.vocabSize, "vocabSize");
  const hidden = assertPositiveInt(cfg.hiddenSize, "hiddenSize");
  const intermediate = assertPositiveInt(cfg.intermediateSize, "intermediateSize");
  const layers = Math.max(0, Math.trunc(cfg.numLayers));

  const aliases: Qwen2SafetensorsAlias[] = [
    { target: "token_embedding.weight", source: "model.embed_tokens.weight", shape: [vocab, hidden] },
    { target: "output_norm.weight", source: "model.norm.weight", shape: [hidden] },
    {
      target: "lm_head.weight",
      source: params.tieWordEmbeddings ? "model.embed_tokens.weight" : "lm_head.weight",
      shape: [vocab, hidden],
    },
  ];

  for (let index = 0; index < layers; index += 1) {
    aliases.push(
      { target: `layers.${index}.attn_norm.weight`, source: `model.layers.${index}.input_layernorm.weight`, shape: [hidden] },
      { target: `layers.${index}.ffn_norm.weight`, source: `model.layers.${index}.post_attention_layernorm.weight`, shape: [hidden] },
      { target: `layers.${index}.attention.wq.weight`, source: `model.layers.${index}.self_attn.q_proj.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wk.weight`, source: `model.layers.${index}.self_attn.k_proj.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wv.weight`, source: `model.layers.${index}.self_attn.v_proj.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wo.weight`, source: `model.layers.${index}.self_attn.o_proj.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.feed_forward.w1.weight`, source: `model.layers.${index}.mlp.gate_proj.weight`, shape: [intermediate, hidden] },
      { target: `layers.${index}.feed_forward.w2.weight`, source: `model.layers.${index}.mlp.down_proj.weight`, shape: [hidden, intermediate] },
      { target: `layers.${index}.feed_forward.w3.weight`, source: `model.layers.${index}.mlp.up_proj.weight`, shape: [intermediate, hidden] },
    );
  }

  return aliases;
}

/**
 * Qwen 2.x 推荐配置
 */
export const QWEN2_RECOMMENDED_CONFIGS: Record<string, NativeModelConfig> = {
  "qwen2-7b": {
    architecture: "decoder-only",
    vocabSize: 152064,
    hiddenSize: 3584,
    intermediateSize: 18944,
    numLayers: 28,
    numHeads: 28,
    numKvHeads: 4,  // GQA
    maxPositionEmbeddings: 131072,
  },
  "qwen2-14b": {
    architecture: "decoder-only",
    vocabSize: 152064,
    hiddenSize: 5120,
    intermediateSize: 13824,
    numLayers: 40,
    numHeads: 40,
    numKvHeads: 5,  // GQA
    maxPositionEmbeddings: 131072,
  },
};

/**
 * 获取 Qwen 2.x 模型的内存需求估算
 */
export function estimateQwen2Memory(params: {
  config: NativeModelConfig;
  quantization?: "q4_0" | "q4_1" | "q5_0" | "q5_1" | "q8_0" | "f16" | "f32";
  batchSize?: number;
  maxSeqLen?: number;
}): { weights: number; kvCache: number; total: number } {
  const cfg = params.config;
  const quantBits = {
    q4_0: 4, q4_1: 4.5, q5_0: 5, q5_1: 5.5, q8_0: 8, f16: 16, f32: 32,
  }[params.quantization ?? "f16"];

  // 权重内存 (MB)
  const vocabSize = cfg.vocabSize;
  const hidden = cfg.hiddenSize;
  const intermediate = cfg.intermediateSize;
  const layers = cfg.numLayers;
  const kvHeads = cfg.numKvHeads ?? cfg.numHeads;
  const headDim = hidden / cfg.numHeads;
  
  const embeddingSize = vocabSize * hidden * quantBits / 8 / 1024 / 1024;
  const layerSize = (
    // 两个 RMSNorm
    2 * hidden +
    // Q/K/V/O (hidden * hidden * 4, 但 K/V 使用 GQA)
    2 * hidden * hidden +  // Q + O
    2 * kvHeads * headDim * hidden +  // K + V (GQA)
    // MLP (SwiGLU)
    3 * hidden * intermediate
  ) * quantBits / 8 / 1024 / 1024;
  
  const weightsMB = embeddingSize + layerSize * layers;

  // KV Cache 内存 (MB)
  const batchSize = params.batchSize ?? 1;
  const maxSeqLen = params.maxSeqLen ?? cfg.maxPositionEmbeddings ?? 8192;
  const kvCacheMB = 2 * batchSize * layers * kvHeads * maxSeqLen * headDim * 2 / 1024 / 1024;

  return {
    weights: Math.round(weightsMB),
    kvCache: Math.round(kvCacheMB),
    total: Math.round(weightsMB + kvCacheMB),
  };
}

