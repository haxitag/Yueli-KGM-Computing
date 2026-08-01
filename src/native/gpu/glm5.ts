import type { NativeModelConfig } from "../types.js";

/**
 * GLM 5.x GPU 权重导入适配
 * 支持 GLM-4-9B、GLM-4-32B、GLM-5.0、GLM-5.1 等版本
 * GLM 架构特点:
 * - Multi-Query Attention (MHA)
 * - SwiGLU 激活
 * - RoPE 位置编码
 * - 双向 Prefix Attention (用于中文理解)
 */

export type Glm5SafetensorsAlias = { target: string; source: string; shape: number[] };

function assertPositiveInt(value: number, label: string): number {
  const v = Math.trunc(value);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`native_gpu_invalid_config_${label}:${value}`);
  }
  return v;
}

/**
 * GLM 5.x 特殊配置
 */
export interface Glm5Config {
  useBias?: boolean;              // 是否使用 bias (GLM-4 默认使用)
  useRmsNorm?: boolean;           // 使用 RMSNorm 而非 LayerNorm
  ropeScaling?: {
    type: "su" | "yarn" | "linear";  // GLM 使用 "su" (Scaled Unit) 或 "yarn"
    factor: number;
    original_max_position_embeddings?: number;
  };
  attentionImplementation?: "eager" | "sdpa" | "flash_attention_2";
  multiQueryGroupNum?: number;    // MQA 组数
}

/**
 * 构建 GLM 5.x 权重别名映射
 * GLM-4/5 使用类 LLaMA 权重布局，但有特定的命名差异
 */
export function buildGlm5SafetensorsAliases(params: {
  config: NativeModelConfig;
  tieWordEmbeddings?: boolean;
  glm5Config?: Glm5Config;
}): Glm5SafetensorsAlias[] {
  const cfg = params.config;
  const vocab = assertPositiveInt(cfg.vocabSize, "vocabSize");
  const hidden = assertPositiveInt(cfg.hiddenSize, "hiddenSize");
  const intermediate = assertPositiveInt(cfg.intermediateSize, "intermediateSize");
  const layers = Math.max(0, Math.trunc(cfg.numLayers));
  const glm5Config = params.glm5Config ?? {};

  // GLM 使用 Multi-Query Attention，KV 头的数量
  const numQueryGroups = glm5Config.multiQueryGroupNum ?? cfg.numKvHeads ?? 2;

  const aliases: Glm5SafetensorsAlias[] = [
    // 嵌入层 - GLM 使用 word_embeddings
    { target: "token_embedding.weight", source: "transformer.embedding.word_embeddings.weight", shape: [vocab, hidden] },
    
    // 最终归一化
    { target: "output_norm.weight", source: "transformer.encoder.final_layernorm.weight", shape: [hidden] },
    { target: "output_norm.bias", source: "transformer.encoder.final_layernorm.bias", shape: [hidden] },
    
    // 语言模型头
    {
      target: "lm_head.weight",
      source: params.tieWordEmbeddings 
        ? "transformer.embedding.word_embeddings.weight" 
        : "transformer.output_layer.weight",
      shape: [vocab, hidden],
    },
  ];

  // 为每一层构建权重映射
  for (let index = 0; index < layers; index += 1) {
    const layerAliases: Glm5SafetensorsAlias[] = [
      // 输入归一化 (Pre-LN)
      { target: `layers.${index}.input_layernorm.weight`, source: `transformer.encoder.layers.${index}.input_layernorm.weight`, shape: [hidden] },
      { target: `layers.${index}.input_layernorm.bias`, source: `transformer.encoder.layers.${index}.input_layernorm.bias`, shape: [hidden] },
      
      // 后注意力归一化 (Post-Attention LN)
      { target: `layers.${index}.post_attention_layernorm.weight`, source: `transformer.encoder.layers.${index}.post_attention_layernorm.weight`, shape: [hidden] },
      { target: `layers.${index}.post_attention_layernorm.bias`, source: `transformer.encoder.layers.${index}.post_attention_layernorm.bias`, shape: [hidden] },
      
      // Q 投影 (全头)
      { target: `layers.${index}.attention.wq.weight`, source: `transformer.encoder.layers.${index}.self_attention.query.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wq.bias`, source: `transformer.encoder.layers.${index}.self_attention.query.bias`, shape: [hidden] },
      
      // K 投影 (MQA - 共享)
      { target: `layers.${index}.attention.wk.weight`, source: `transformer.encoder.layers.${index}.self_attention.key.weight`, shape: [numQueryGroups * (hidden / cfg.numHeads), hidden] },
      { target: `layers.${index}.attention.wk.bias`, source: `transformer.encoder.layers.${index}.self_attention.key.bias`, shape: [numQueryGroups * (hidden / cfg.numHeads)] },
      
      // V 投影 (MQA - 共享)
      { target: `layers.${index}.attention.wv.weight`, source: `transformer.encoder.layers.${index}.self_attention.value.weight`, shape: [numQueryGroups * (hidden / cfg.numHeads), hidden] },
      { target: `layers.${index}.attention.wv.bias`, source: `transformer.encoder.layers.${index}.self_attention.value.bias`, shape: [numQueryGroups * (hidden / cfg.numHeads)] },
      
      // 输出投影
      { target: `layers.${index}.attention.wo.weight`, source: `transformer.encoder.layers.${index}.self_attention.dense.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wo.bias`, source: `transformer.encoder.layers.${index}.self_attention.dense.bias`, shape: [hidden] },
      
      // MLP (SwiGLU) - GLM 使用不同命名
      { target: `layers.${index}.mlp.w1.weight`, source: `transformer.encoder.layers.${index}.mlp.dense_h_to_4h.weight`, shape: [intermediate, hidden] },
      { target: `layers.${index}.mlp.w1.bias`, source: `transformer.encoder.layers.${index}.mlp.dense_h_to_4h.bias`, shape: [intermediate] },
      { target: `layers.${index}.mlp.w2.weight`, source: `transformer.encoder.layers.${index}.mlp.dense_4h_to_h.weight`, shape: [hidden, intermediate] },
      { target: `layers.${index}.mlp.w2.bias`, source: `transformer.encoder.layers.${index}.mlp.dense_4h_to_h.bias`, shape: [hidden] },
    ];

    aliases.push(...layerAliases);
  }

  return aliases;
}

/**
 * GLM 5.x 推荐配置
 */
export const GLM5_RECOMMENDED_CONFIGS: Record<string, NativeModelConfig & { glm5Config: Glm5Config }> = {
  "glm-4-9b": {
    architecture: "decoder-only",
    vocabSize: 151552,
    hiddenSize: 4096,
    intermediateSize: 13696,
    numLayers: 40,
    numHeads: 32,
    numKvHeads: 2,  // MQA
    maxPositionEmbeddings: 131072,
    glm5Config: {
      useBias: true,
      useRmsNorm: false,
      ropeScaling: { type: "su", factor: 1.0 },
      multiQueryGroupNum: 2,
    },
  },
  "glm-4-32b": {
    architecture: "decoder-only",
    vocabSize: 151552,
    hiddenSize: 8192,
    intermediateSize: 27392,
    numLayers: 80,
    numHeads: 64,
    numKvHeads: 2,  // MQA
    maxPositionEmbeddings: 131072,
    glm5Config: {
      useBias: true,
      useRmsNorm: false,
      ropeScaling: { type: "su", factor: 1.0 },
      multiQueryGroupNum: 2,
    },
  },
  "glm-5.0": {
    architecture: "decoder-only",
    vocabSize: 151680,  // 扩展词表
    hiddenSize: 8192,
    intermediateSize: 28672,
    numLayers: 80,
    numHeads: 64,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 200000,
    glm5Config: {
      useBias: true,
      useRmsNorm: true,
      ropeScaling: { type: "yarn", factor: 2.0, original_max_position_embeddings: 131072 },
      multiQueryGroupNum: 8,
    },
  },
  "glm-5.1": {
    architecture: "decoder-only",
    vocabSize: 151680,
    hiddenSize: 8192,
    intermediateSize: 28672,
    numLayers: 80,
    numHeads: 64,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 200000,
    glm5Config: {
      useBias: true,
      useRmsNorm: true,
      ropeScaling: { type: "yarn", factor: 2.0, original_max_position_embeddings: 131072 },
      attentionImplementation: "flash_attention_2",
      multiQueryGroupNum: 8,
    },
  },
};

/**
 * 获取 GLM 5.x 模型的内存需求估算
 */
export function estimateGlm5Memory(params: {
  config: NativeModelConfig;
  glm5Config?: Glm5Config;
  quantization?: "q4_0" | "q4_1" | "q5_0" | "q5_1" | "q8_0" | "f16" | "f32";
  batchSize?: number;
  maxSeqLen?: number;
}): { weights: number; kvCache: number; total: number } {
  const cfg = params.config;
  const glm5Config = params.glm5Config ?? {};
  const quantBits = {
    q4_0: 4, q4_1: 4.5, q5_0: 5, q5_1: 5.5, q8_0: 8, f16: 16, f32: 32,
  }[params.quantization ?? "f16"];

  // 权重内存 (MB)
  const vocabSize = cfg.vocabSize;
  const hidden = cfg.hiddenSize;
  const intermediate = cfg.intermediateSize;
  const layers = cfg.numLayers;
  
  // MQA: K/V 参数大幅减少
  const numQueryGroups = glm5Config.multiQueryGroupNum ?? cfg.numKvHeads ?? 2;
  const headDim = hidden / cfg.numHeads;
  
  const embeddingSize = vocabSize * hidden * quantBits / 8 / 1024 / 1024;
  
  // 每一层权重计算
  const layerSize = (
    // 2 个 LayerNorm (带 bias)
    2 * hidden * 2 +
    // Q 投影 (全头)
    hidden * hidden +
    // K/V 投影 (MQA - 共享)
    2 * numQueryGroups * headDim * hidden +
    // O 投影
    hidden * hidden +
    // MLP (SwiGLU: w1, w2, gate 或 dense_h_to_4h, dense_4h_to_h)
    2 * hidden * intermediate
  ) * quantBits / 8 / 1024 / 1024;
  
  const weightsMB = embeddingSize + layerSize * layers;

  // KV Cache 内存 (MB) - MQA 使得 KV cache 大幅减少
  const batchSize = params.batchSize ?? 1;
  const maxSeqLen = params.maxSeqLen ?? cfg.maxPositionEmbeddings ?? 8192;
  // MQA: 每层的 KV 头数等于 numQueryGroups
  const kvCacheMB = 2 * batchSize * layers * numQueryGroups * maxSeqLen * headDim * 2 / 1024 / 1024;

  return {
    weights: Math.round(weightsMB),
    kvCache: Math.round(kvCacheMB),
    total: Math.round(weightsMB + kvCacheMB),
  };
}

/**
 * GLM 特有: 构建双向 Prefix 注意力掩码
 * 用于中文理解场景
 */
export function buildGlmPrefixMask(seqLen: number, prefixLen: number): number[][] {
  const mask: number[][] = [];
  for (let i = 0; i < seqLen; i++) {
    const row: number[] = [];
    for (let j = 0; j < seqLen; j++) {
      if (j < prefixLen) {
        // Prefix 部分双向可见
        row.push(0);
      } else if (j <= i) {
        // 非 prefix 部分因果掩码
        row.push(0);
      } else {
        row.push(Number.NEGATIVE_INFINITY);
      }
    }
    mask.push(row);
  }
  return mask;
}
