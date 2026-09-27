import type { NativeModelConfig } from "../types.js";

/**
 * Google Gemma 4.x GPU 权重导入适配
 * 支持 Gemma 4 系列模型
 * Gemma 架构特点:
 * - RMSNorm (无 bias)
 * - Multi-Head Attention
 * - Gated Linear Units (GeGLU 激活)
 * - 无偏置的线性层
 * - 嵌入式归一化 (input embedding + final norm 共享)
 */

export type Gemma4SafetensorsAlias = { target: string; source: string; shape: number[] };

function assertPositiveInt(value: number, label: string): number {
  const v = Math.trunc(value);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`native_gpu_invalid_config_${label}:${value}`);
  }
  return v;
}

/**
 * Gemma 4.x 特殊配置
 */
export interface Gemma4Config {
  headDim?: number;               // 注意力头维度 (Gemma 使用固定的 head_dim)
  queryPreAttnScalar?: number;    // 注意力缩放因子
  useGeGLU?: boolean;            // 使用 GeGLU (Gated GeLU) 激活
  normalizeEmbeddings?: boolean;   // 是否归一化嵌入
  attentionLogitSoftcap?: number; // 注意力 logits softcap
}

/**
 * 构建 Gemma 4.x 权重别名映射
 * Gemma 使用简洁的权重命名，无 bias
 */
export function buildGemma4SafetensorsAliases(params: {
  config: NativeModelConfig;
  tieWordEmbeddings?: boolean;
  gemma4Config?: Gemma4Config;
}): Gemma4SafetensorsAlias[] {
  const cfg = params.config;
  const vocab = assertPositiveInt(cfg.vocabSize, "vocabSize");
  const hidden = assertPositiveInt(cfg.hiddenSize, "hiddenSize");
  const intermediate = assertPositiveInt(cfg.intermediateSize, "intermediateSize");
  const layers = Math.max(0, Math.trunc(cfg.numLayers));

  const aliases: Gemma4SafetensorsAlias[] = [
    // 嵌入层 - Gemma 使用 model.embed_tokens
    { target: "token_embedding.weight", source: "model.embed_tokens.weight", shape: [vocab, hidden] },
    
    // 最终归一化 - RMSNorm (无 bias)
    { target: "output_norm.weight", source: "model.norm.weight", shape: [hidden] },
    
    // 语言模型头 - Gemma 通常 tie embeddings
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
    const layerAliases: Gemma4SafetensorsAlias[] = [
      // 输入归一化 - RMSNorm (无 bias)
      { target: `layers.${index}.attn_norm.weight`, source: `model.layers.${index}.input_layernorm.weight`, shape: [hidden] },
      
      // 后注意力归一化 - RMSNorm (无 bias)
      { target: `layers.${index}.ffn_norm.weight`, source: `model.layers.${index}.post_attention_layernorm.weight`, shape: [hidden] },
      
      // Q/K/V 投影 - 无 bias
      { target: `layers.${index}.attention.wq.weight`, source: `model.layers.${index}.self_attn.q_proj.weight`, shape: [hidden, hidden] },
      { target: `layers.${index}.attention.wk.weight`, source: `model.layers.${index}.self_attn.k_proj.weight`, shape: [(cfg.numKvHeads ?? cfg.numHeads) * (hidden / cfg.numHeads), hidden] },
      { target: `layers.${index}.attention.wv.weight`, source: `model.layers.${index}.self_attn.v_proj.weight`, shape: [(cfg.numKvHeads ?? cfg.numHeads) * (hidden / cfg.numHeads), hidden] },
      { target: `layers.${index}.attention.wo.weight`, source: `model.layers.${index}.self_attn.o_proj.weight`, shape: [hidden, hidden] },
      
      // MLP - GeGLU (Gated GeLU): gate_up_proj 包含 gate 和 up
      { target: `layers.${index}.feed_forward.gate_up.weight`, source: `model.layers.${index}.mlp.gate_up_proj.weight`, shape: [intermediate * 2, hidden] },
      { target: `layers.${index}.feed_forward.down.weight`, source: `model.layers.${index}.mlp.down_proj.weight`, shape: [hidden, intermediate] },
    ];

    aliases.push(...layerAliases);
  }

  return aliases;
}

/**
 * Gemma 4.x 推荐配置
 */
export const GEMMA4_RECOMMENDED_CONFIGS: Record<string, NativeModelConfig & { gemma4Config: Gemma4Config }> = {
  "gemma-4-4b": {
    architecture: "decoder-only",
    vocabSize: 256000,
    hiddenSize: 3072,
    intermediateSize: 12288,
    numLayers: 34,
    numHeads: 16,
    numKvHeads: 16,
    maxPositionEmbeddings: 8192,
    gemma4Config: {
      headDim: 256,
      queryPreAttnScalar: 144,  // head_dim ** -0.5
      useGeGLU: true,
      normalizeEmbeddings: true,
      attentionLogitSoftcap: 50.0,
    },
  },
  "gemma-4-9b": {
    architecture: "decoder-only",
    vocabSize: 256000,
    hiddenSize: 3584,
    intermediateSize: 14336,
    numLayers: 42,
    numHeads: 16,
    numKvHeads: 16,
    maxPositionEmbeddings: 8192,
    gemma4Config: {
      headDim: 256,
      queryPreAttnScalar: 144,
      useGeGLU: true,
      normalizeEmbeddings: true,
      attentionLogitSoftcap: 50.0,
    },
  },
  "gemma-4-27b": {
    architecture: "decoder-only",
    vocabSize: 256000,
    hiddenSize: 6144,
    intermediateSize: 24576,
    numLayers: 46,
    numHeads: 32,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 128000,
    gemma4Config: {
      headDim: 128,
      queryPreAttnScalar: 128,
      useGeGLU: true,
      normalizeEmbeddings: true,
      attentionLogitSoftcap: 50.0,
    },
  },
  "gemma-4-2b-it": {
    architecture: "decoder-only",
    vocabSize: 256000,
    hiddenSize: 2304,
    intermediateSize: 9216,
    numLayers: 26,
    numHeads: 8,
    numKvHeads: 1,  // MQA
    maxPositionEmbeddings: 8192,
    gemma4Config: {
      headDim: 256,
      queryPreAttnScalar: 144,
      useGeGLU: true,
      normalizeEmbeddings: true,
      attentionLogitSoftcap: 50.0,
    },
  },
};

/**
 * 获取 Gemma 4.x 模型的内存需求估算
 */
export function estimateGemma4Memory(params: {
  config: NativeModelConfig;
  gemma4Config?: Gemma4Config;
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
  
  const embeddingSize = vocabSize * hidden * quantBits / 8 / 1024 / 1024;
  
  // Gemma 无 bias，且使用 GeGLU (gate_up 是 2x 大小)
  const layerSize = (
    // 2 个 RMSNorm (只有 weight，无 bias)
    2 * hidden +
    // Q/K/V/O (hidden * hidden * 4)
    4 * hidden * hidden +
    // MLP - GeGLU: gate_up (2 * hidden * intermediate) + down (hidden * intermediate)
    3 * hidden * intermediate
  ) * quantBits / 8 / 1024 / 1024;
  
  const weightsMB = embeddingSize + layerSize * layers;

  // KV Cache 内存 (MB)
  const batchSize = params.batchSize ?? 1;
  const maxSeqLen = params.maxSeqLen ?? cfg.maxPositionEmbeddings ?? 8192;
  const kvHeads = cfg.numKvHeads ?? cfg.numHeads;
  const headDim = hidden / cfg.numHeads;
  const kvCacheMB = 2 * batchSize * layers * kvHeads * maxSeqLen * headDim * 2 / 1024 / 1024;

  return {
    weights: Math.round(weightsMB),
    kvCache: Math.round(kvCacheMB),
    total: Math.round(weightsMB + kvCacheMB),
  };
}

/**
 * Gemma 特有: 嵌入归一化
 * Gemma 对输入嵌入进行 L2 归一化
 */
export function normalizeGemmaEmbeddings(embeddings: Float32Array, hiddenSize: number): Float32Array {
  const normalized = new Float32Array(embeddings.length);
  for (let i = 0; i < embeddings.length; i += hiddenSize) {
    let sum = 0;
    for (let j = 0; j < hiddenSize; j++) {
      sum += embeddings[i + j] * embeddings[i + j];
    }
    const norm = Math.sqrt(sum) + 1e-6;
    for (let j = 0; j < hiddenSize; j++) {
      normalized[i + j] = embeddings[i + j] / norm;
    }
  }
  return normalized;
}

/**
 * Gemma 特有: GeGLU 激活
 * Gated GeLU: output = gate(x) * GeLU(up(x))
 */
export function applyGeGLU(input: Float32Array, gate: Float32Array, up: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    // GeLU(x) = 0.5 * x * (1 + tanh(sqrt(2/π) * (x + 0.044715 * x^3)))
    const x = up[i];
    const gelu = 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
    output[i] = gate[i] * gelu;
  }
  return output;
}
