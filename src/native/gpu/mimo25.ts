import type { NativeModelConfig } from "../types.js";

/**
 * MiMo 2.5 (小米) GPU 权重导入适配
 * 支持 MiMo-2.5 系列模型
 * MiMo 架构特点:
 * - 端侧优化设计
 * - GQA (Grouped Query Attention)
 * - RMSNorm 归一化
 * - SwiGLU 激活
 * - 适合移动端和边缘设备
 */

export type Mimo25SafetensorsAlias = { target: string; source: string; shape: number[] };

function assertPositiveInt(value: number, label: string): number {
  const v = Math.trunc(value);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`native_gpu_invalid_config_${label}:${value}`);
  }
  return v;
}

/**
 * MiMo 2.5 特殊配置
 */
export interface Mimo25Config {
  headDim?: number;               // 注意力头维度
  useSlidingWindow?: boolean;     // 使用滑动窗口注意力
  slidingWindowSize?: number;     // 滑动窗口大小
  ropeScaling?: {
    type: "su" | "yarn" | "linear";
    factor: number;
  };
  attentionImplementation?: "eager" | "sdpa" | "flash_attention_2";
  quantizationConfig?: {
    activation?: "int8" | "fp16";
    weight?: "int8" | "int4" | "fp16";
  };
}

/**
 * 构建 MiMo 2.5 权重别名映射
 * MiMo 使用标准 LLaMA 3 权重命名
 */
export function buildMimo25SafetensorsAliases(params: {
  config: NativeModelConfig;
  tieWordEmbeddings?: boolean;
  mimo25Config?: Mimo25Config;
}): Mimo25SafetensorsAlias[] {
  const cfg = params.config;
  const vocab = assertPositiveInt(cfg.vocabSize, "vocabSize");
  const hidden = assertPositiveInt(cfg.hiddenSize, "hiddenSize");
  const intermediate = assertPositiveInt(cfg.intermediateSize, "intermediateSize");
  const layers = Math.max(0, Math.trunc(cfg.numLayers));

  const aliases: Mimo25SafetensorsAlias[] = [
    // 嵌入层
    { target: "token_embedding.weight", source: "model.embed_tokens.weight", shape: [vocab, hidden] },
    
    // 最终归一化 - RMSNorm
    { target: "output_norm.weight", source: "model.norm.weight", shape: [hidden] },
    
    // 语言模型头
    {
      target: "lm_head.weight",
      source: params.tieWordEmbeddings !== false 
        ? "model.embed_tokens.weight" 
        : "lm_head.weight",
      shape: [vocab, hidden],
    },
  ];

  // 为每一层构建权重映射
  for (let index = 0; index < layers; index += 1) {
    const layerAliases: Mimo25SafetensorsAlias[] = [
      // 输入归一化 - RMSNorm
      { target: `layers.${index}.attn_norm.weight`, source: `model.layers.${index}.input_layernorm.weight`, shape: [hidden] },
      
      // 后注意力归一化 - RMSNorm
      { target: `layers.${index}.ffn_norm.weight`, source: `model.layers.${index}.post_attention_layernorm.weight`, shape: [hidden] },
      
      // Q 投影 (全头)
      { target: `layers.${index}.attention.wq.weight`, source: `model.layers.${index}.self_attn.q_proj.weight`, shape: [hidden, hidden] },
      
      // K 投影 (GQA)
      { target: `layers.${index}.attention.wk.weight`, source: `model.layers.${index}.self_attn.k_proj.weight`, shape: [(cfg.numKvHeads ?? cfg.numHeads) * (hidden / cfg.numHeads), hidden] },
      
      // V 投影 (GQA)
      { target: `layers.${index}.attention.wv.weight`, source: `model.layers.${index}.self_attn.v_proj.weight`, shape: [(cfg.numKvHeads ?? cfg.numHeads) * (hidden / cfg.numHeads), hidden] },
      
      // 输出投影
      { target: `layers.${index}.attention.wo.weight`, source: `model.layers.${index}.self_attn.o_proj.weight`, shape: [hidden, hidden] },
      
      // MLP - SwiGLU
      { target: `layers.${index}.feed_forward.gate_proj.weight`, source: `model.layers.${index}.mlp.gate_proj.weight`, shape: [intermediate, hidden] },
      { target: `layers.${index}.feed_forward.up_proj.weight`, source: `model.layers.${index}.mlp.up_proj.weight`, shape: [intermediate, hidden] },
      { target: `layers.${index}.feed_forward.down_proj.weight`, source: `model.layers.${index}.mlp.down_proj.weight`, shape: [hidden, intermediate] },
    ];

    aliases.push(...layerAliases);
  }

  return aliases;
}

/**
 * MiMo 2.5 推荐配置
 */
export const MIMO25_RECOMMENDED_CONFIGS: Record<string, NativeModelConfig & { mimo25Config: Mimo25Config }> = {
  "mimo-2.5-1.5b": {
    architecture: "decoder-only",
    vocabSize: 128256,
    hiddenSize: 2048,
    intermediateSize: 8192,
    numLayers: 24,
    numHeads: 16,
    numKvHeads: 4,  // GQA
    maxPositionEmbeddings: 32768,
    mimo25Config: {
      headDim: 128,
      useSlidingWindow: false,
      ropeScaling: { type: "su", factor: 1.0 },
      attentionImplementation: "sdpa",
      quantizationConfig: { activation: "fp16", weight: "int8" },
    },
  },
  "mimo-2.5-7b": {
    architecture: "decoder-only",
    vocabSize: 128256,
    hiddenSize: 4096,
    intermediateSize: 14336,
    numLayers: 32,
    numHeads: 32,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 131072,
    mimo25Config: {
      headDim: 128,
      useSlidingWindow: true,
      slidingWindowSize: 4096,
      ropeScaling: { type: "su", factor: 1.0 },
      attentionImplementation: "flash_attention_2",
      quantizationConfig: { activation: "fp16", weight: "int8" },
    },
  },
  "mimo-2.5-13b": {
    architecture: "decoder-only",
    vocabSize: 128256,
    hiddenSize: 5120,
    intermediateSize: 17920,
    numLayers: 40,
    numHeads: 40,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 131072,
    mimo25Config: {
      headDim: 128,
      useSlidingWindow: true,
      slidingWindowSize: 8192,
      ropeScaling: { type: "su", factor: 1.0 },
      attentionImplementation: "flash_attention_2",
      quantizationConfig: { activation: "fp16", weight: "int4" },
    },
  },
  "mimo-2.5-30b": {
    architecture: "decoder-only",
    vocabSize: 128256,
    hiddenSize: 6656,
    intermediateSize: 23296,
    numLayers: 60,
    numHeads: 52,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 131072,
    mimo25Config: {
      headDim: 128,
      useSlidingWindow: true,
      slidingWindowSize: 8192,
      ropeScaling: { type: "su", factor: 1.0 },
      attentionImplementation: "flash_attention_2",
      quantizationConfig: { activation: "fp16", weight: "int4" },
    },
  },
};

/**
 * 获取 MiMo 2.5 模型的内存需求估算
 */
export function estimateMimo25Memory(params: {
  config: NativeModelConfig;
  mimo25Config?: Mimo25Config;
  quantization?: "q4_0" | "q4_1" | "q5_0" | "q5_1" | "q8_0" | "f16" | "f32";
  batchSize?: number;
  maxSeqLen?: number;
}): { weights: number; kvCache: number; total: number } {
  const cfg = params.config;
  const mimo25Config = params.mimo25Config ?? {};
  const quantBits = {
    q4_0: 4, q4_1: 4.5, q5_0: 5, q5_1: 5.5, q8_0: 8, f16: 16, f32: 32,
  }[params.quantization ?? "f16"];

  // 权重内存 (MB)
  const vocabSize = cfg.vocabSize;
  const hidden = cfg.hiddenSize;
  const intermediate = cfg.intermediateSize;
  const layers = cfg.numLayers;
  
  const embeddingSize = vocabSize * hidden * quantBits / 8 / 1024 / 1024;
  
  // GQA 减少 K/V 参数
  const kvHeads = cfg.numKvHeads ?? cfg.numHeads;
  const headDim = hidden / cfg.numHeads;
  
  const layerSize = (
    // 2 个 RMSNorm
    2 * hidden +
    // Q 投影 (全头)
    hidden * hidden +
    // K/V 投影 (GQA)
    2 * kvHeads * headDim * hidden +
    // O 投影
    hidden * hidden +
    // MLP (SwiGLU: gate, up, down)
    3 * hidden * intermediate
  ) * quantBits / 8 / 1024 / 1024;
  
  const weightsMB = embeddingSize + layerSize * layers;

  // KV Cache 内存 (MB)
  const batchSize = params.batchSize ?? 1;
  const maxSeqLen = params.maxSeqLen ?? cfg.maxPositionEmbeddings ?? 32768;
  const kvCacheMB = 2 * batchSize * layers * kvHeads * maxSeqLen * headDim * 2 / 1024 / 1024;

  return {
    weights: Math.round(weightsMB),
    kvCache: Math.round(kvCacheMB),
    total: Math.round(weightsMB + kvCacheMB),
  };
}

/**
 * MiMo 特有: 端侧量化配置
 * 为移动设备优化的量化设置
 */
export function getMimoEdgeQuantizationConfig(modelSize: string): {
  weightQuant: "int4" | "int8";
  activationQuant: "fp16" | "int8";
  groupSize: number;
} {
  const configs: Record<string, { weightQuant: "int4" | "int8"; activationQuant: "fp16" | "int8"; groupSize: number }> = {
    "1.5b": { weightQuant: "int8", activationQuant: "fp16", groupSize: 128 },
    "7b": { weightQuant: "int8", activationQuant: "fp16", groupSize: 128 },
    "13b": { weightQuant: "int4", activationQuant: "fp16", groupSize: 128 },
    "30b": { weightQuant: "int4", activationQuant: "fp16", groupSize: 128 },
  };
  
  return configs[modelSize] ?? { weightQuant: "int8", activationQuant: "fp16", groupSize: 128 };
}

/**
 * MiMo 特有: 计算推荐 batch size
 * 基于可用内存和设备类型
 */
export function getMimoRecommendedBatchSize(
  modelSize: string,
  availableMemoryMB: number,
  seqLen: number
): number {
  const memoryEstimate = estimateMimo25Memory({
    config: MIMO25_RECOMMENDED_CONFIGS[`mimo-2.5-${modelSize}`] ?? MIMO25_RECOMMENDED_CONFIGS["mimo-2.5-7b"],
    batchSize: 1,
    maxSeqLen: seqLen,
  });
  
  // 预留 30% 内存用于激活和其他开销
  const usableMemory = availableMemoryMB * 0.7;
  const batchSize = Math.floor(usableMemory / memoryEstimate.total);
  
  return Math.max(1, Math.min(batchSize, 8));
}
