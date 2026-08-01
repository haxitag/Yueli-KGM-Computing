import type { NativeModelConfig } from "../types.js";

/**
 * Qwen 3.x GPU 权重导入适配
 * 支持 Qwen 3.5、Qwen 3.6 等版本
 * 基于 Qwen2 架构，但支持更大的参数规模和新的优化
 */

export type Qwen3SafetensorsAlias = { target: string; source: string; shape: number[] };

function assertPositiveInt(value: number, label: string): number {
  const v = Math.trunc(value);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`native_gpu_invalid_config_${label}:${value}`);
  }
  return v;
}

/**
 * Qwen 3.x 配置选项
 */
export interface Qwen3Config {
  useSlidingWindow?: boolean;      // 使用滑动窗口注意力
  slidingWindowSize?: number;      // 滑动窗口大小 (默认 4096)
  useQkvBias?: boolean;            // Q/K/V 投影使用 bias
  ropeScaling?: {
    type: string;                  // "linear" | "dynamic" | "yarn"
    factor: number;
  };
  usePostLlmNorm?: boolean;        // 使用 Post-LLM 归一化
  attentionDropout?: number;        // 注意力 dropout
}

/**
 * 构建 Qwen 3.x 权重别名映射
 * 支持从 Hugging Face Transformers 格式到本地 GPU 格式的转换
 */
export function buildQwen3SafetensorsAliases(params: {
  config: NativeModelConfig;
  tieWordEmbeddings?: boolean;
  qwen3Config?: Qwen3Config;
}): Qwen3SafetensorsAlias[] {
  const cfg = params.config;
  const vocab = assertPositiveInt(cfg.vocabSize, "vocabSize");
  const hidden = assertPositiveInt(cfg.hiddenSize, "hiddenSize");
  const intermediate = assertPositiveInt(cfg.intermediateSize, "intermediateSize");
  const layers = Math.max(0, Math.trunc(cfg.numLayers));
  const qwen3Config = params.qwen3Config ?? {};

  const aliases: Qwen3SafetensorsAlias[] = [
    // 嵌入层
    { target: "token_embedding.weight", source: "model.embed_tokens.weight", shape: [vocab, hidden] },
    
    // 最终归一化
    { target: "output_norm.weight", source: "model.norm.weight", shape: [hidden] },
    
    // 语言模型头
    {
      target: "lm_head.weight",
      source: params.tieWordEmbeddings ? "model.embed_tokens.weight" : "lm_head.weight",
      shape: [vocab, hidden],
    },
  ];

  // 如果启用 Post-LLM 归一化
  if (qwen3Config.usePostLlmNorm) {
    aliases.push({ target: "post_llm_norm.weight", source: "model.post_llm_norm.weight", shape: [hidden] });
  }

  // 为每一层构建权重映射
  for (let index = 0; index < layers; index += 1) {
    const layerAliases: Qwen3SafetensorsAlias[] = [
      // 注意力归一化
      { target: `layers.${index}.attn_norm.weight`, source: `model.layers.${index}.input_layernorm.weight`, shape: [hidden] },
      
      // FFN 归一化
      { target: `layers.${index}.ffn_norm.weight`, source: `model.layers.${index}.post_attention_layernorm.weight`, shape: [hidden] },
      
      // Q/K/V 投影 (Qwen3 可能使用 bias)
      { target: `layers.${index}.attention.wq.weight`, source: `model.layers.${index}.self_attn.q_proj.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wk.weight`, source: `model.layers.${index}.self_attn.k_proj.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wv.weight`, source: `model.layers.${index}.self_attn.v_proj.weight`, shape: [hidden, hidden] },
      
      // 输出投影
      { target: `layers.${index}.attention.wo.weight`, source: `model.layers.${index}.self_attn.o_proj.weight`, shape: [hidden, hidden] },
      
      // MLP (SwiGLU)
      { target: `layers.${index}.feed_forward.w1.weight`, source: `model.layers.${index}.mlp.gate_proj.weight`, shape: [intermediate, hidden] },
      { target: `layers.${index}.feed_forward.w2.weight`, source: `model.layers.${index}.mlp.down_proj.weight`, shape: [hidden, intermediate] },
      { target: `layers.${index}.feed_forward.w3.weight`, source: `model.layers.${index}.mlp.up_proj.weight`, shape: [intermediate, hidden] },
    ];

    // 如果使用 QKV bias
    if (qwen3Config.useQkvBias) {
      layerAliases.push(
        { target: `layers.${index}.attention.wq.bias`, source: `model.layers.${index}.self_attn.q_proj.bias`, shape: [hidden] },
        { target: `layers.${index}.attention.wk.bias`, source: `model.layers.${index}.self_attn.k_proj.bias`, shape: [hidden] },
        { target: `layers.${index}.attention.wv.bias`, source: `model.layers.${index}.self_attn.v_proj.bias`, shape: [hidden] },
      );
    }

    aliases.push(...layerAliases);
  }

  return aliases;
}

/**
 * Qwen 3.x 推荐配置
 * 针对不同模型规模的默认配置
 */
export const QWEN3_RECOMMENDED_CONFIGS: Record<string, NativeModelConfig & { qwen3Config: Qwen3Config }> = {
  "qwen3.5-7b": {
    architecture: "decoder-only",
    vocabSize: 152064,
    hiddenSize: 4096,
    intermediateSize: 11008,
    numLayers: 32,
    numHeads: 32,
    numKvHeads: 32,
    maxPositionEmbeddings: 131072,
    qwen3Config: {
      useSlidingWindow: false,
      useQkvBias: true,
      ropeScaling: { type: "yarn", factor: 1.0 },
    },
  },
  "qwen3.5-14b": {
    architecture: "decoder-only",
    vocabSize: 152064,
    hiddenSize: 5120,
    intermediateSize: 13824,
    numLayers: 40,
    numHeads: 40,
    numKvHeads: 40,
    maxPositionEmbeddings: 131072,
    qwen3Config: {
      useSlidingWindow: false,
      useQkvBias: true,
      ropeScaling: { type: "yarn", factor: 1.0 },
    },
  },
  "qwen3.5-32b": {
    architecture: "decoder-only",
    vocabSize: 152064,
    hiddenSize: 8192,
    intermediateSize: 22528,
    numLayers: 64,
    numHeads: 64,
    numKvHeads: 64,
    maxPositionEmbeddings: 131072,
    qwen3Config: {
      useSlidingWindow: false,
      useQkvBias: true,
      ropeScaling: { type: "yarn", factor: 1.0 },
    },
  },
  "qwen3.6-72b": {
    architecture: "decoder-only",
    vocabSize: 152064,
    hiddenSize: 8192,
    intermediateSize: 29568,
    numLayers: 80,
    numHeads: 64,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 131072,
    qwen3Config: {
      useSlidingWindow: true,
      slidingWindowSize: 4096,
      useQkvBias: false,
      ropeScaling: { type: "yarn", factor: 4.0 },
    },
  },
};

/**
 * 获取 Qwen 3.x 模型的内存需求估算
 */
export function estimateQwen3Memory(params: {
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
    // 两个 layernorm
    2 * hidden +
    // Q/K/V/O (hidden * hidden * 4)
    4 * hidden * hidden +
    // MLP (hidden * intermediate * 3)
    3 * hidden * intermediate
  ) * quantBits / 8 / 1024 / 1024;
  
  const weightsMB = embeddingSize + layerSize * layers;

  // KV Cache 内存 (MB)
  const batchSize = params.batchSize ?? 1;
  const maxSeqLen = params.maxSeqLen ?? cfg.maxPositionEmbeddings ?? 8192;
  const kvCacheMB = 2 * batchSize * layers * kvHeads * maxSeqLen * headDim * 2 / 1024 / 1024; // f16 = 2 bytes

  return {
    weights: Math.round(weightsMB),
    kvCache: Math.round(kvCacheMB),
    total: Math.round(weightsMB + kvCacheMB),
  };
}
