import type { NativeModelConfig } from "../types.js";

/**
 * MiniMax 2.5/2.7 GPU 权重导入适配
 * 支持 MiniMax-Text-01 系列模型
 * MiniMax 架构特点:
 * - GQA (Grouped Query Attention)
 * - RoPE 位置编码
 * - RMSNorm 归一化
 * - SwiGLU 激活
 * - 超大上下文窗口 (400K tokens)
 */

export type Minimax25SafetensorsAlias = { target: string; source: string; shape: number[] };

function assertPositiveInt(value: number, label: string): number {
  const v = Math.trunc(value);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`native_gpu_invalid_config_${label}:${value}`);
  }
  return v;
}

/**
 * MiniMax 2.5+ 特殊配置
 */
export interface Minimax25Config {
  useSlidingWindow?: boolean;      // 使用滑动窗口注意力
  slidingWindowSize?: number;      // 滑动窗口大小
  ropeScaling?: {
    type: "su" | "yarn" | "linear" | "dynamic";
    factor: number;
    original_max_position_embeddings?: number;
  };
  attentionImplementation?: "eager" | "sdpa" | "flash_attention_2";
  compressKV?: boolean;           // KV 缓存压缩
  compressKVFactor?: number;    // 压缩因子
}

/**
 * 构建 MiniMax 2.5/2.7 权重别名映射
 * MiniMax 使用类似 LLaMA 3 的权重命名
 */
export function buildMinimax25SafetensorsAliases(params: {
  config: NativeModelConfig;
  tieWordEmbeddings?: boolean;
  minimax25Config?: Minimax25Config;
}): Minimax25SafetensorsAlias[] {
  const cfg = params.config;
  const vocab = assertPositiveInt(cfg.vocabSize, "vocabSize");
  const hidden = assertPositiveInt(cfg.hiddenSize, "hiddenSize");
  const intermediate = assertPositiveInt(cfg.intermediateSize, "intermediateSize");
  const layers = Math.max(0, Math.trunc(cfg.numLayers));

  const aliases: Minimax25SafetensorsAlias[] = [
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
    const layerAliases: Minimax25SafetensorsAlias[] = [
      // 输入归一化 - RMSNorm
      { target: `layers.${index}.attn_norm.weight`, source: `model.layers.${index}.input_layernorm.weight`, shape: [hidden] },
      
      // 后注意力归一化 - RMSNorm
      { target: `layers.${index}.ffn_norm.weight`, source: `model.layers.${index}.post_attention_layernorm.weight`, shape: [hidden] },
      
      // Q 投影 (全头)
      { target: `layers.${index}.attention.wq.weight`, source: `model.layers.${index}.self_attn.q_proj.weight`, shape: [hidden, hidden] },
      
      // K 投影 (GQA - 分组)
      { target: `layers.${index}.attention.wk.weight`, source: `model.layers.${index}.self_attn.k_proj.weight`, shape: [(cfg.numKvHeads ?? cfg.numHeads) * (hidden / cfg.numHeads), hidden] },
      
      // V 投影 (GQA - 分组)
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
 * MiniMax 2.5/2.7 推荐配置
 */
export const MINIMAX25_RECOMMENDED_CONFIGS: Record<string, NativeModelConfig & { minimax25Config: Minimax25Config }> = {
  "minimax-text-01-4b": {
    architecture: "decoder-only",
    vocabSize: 102400,
    hiddenSize: 3072,
    intermediateSize: 12288,
    numLayers: 32,
    numHeads: 24,
    numKvHeads: 6,  // GQA
    maxPositionEmbeddings: 131072,
    minimax25Config: {
      useSlidingWindow: true,
      slidingWindowSize: 8192,
      ropeScaling: { type: "su", factor: 1.0 },
      attentionImplementation: "flash_attention_2",
    },
  },
  "minimax-text-01-8b": {
    architecture: "decoder-only",
    vocabSize: 102400,
    hiddenSize: 4096,
    intermediateSize: 16384,
    numLayers: 40,
    numHeads: 32,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 131072,
    minimax25Config: {
      useSlidingWindow: true,
      slidingWindowSize: 8192,
      ropeScaling: { type: "su", factor: 1.0 },
      attentionImplementation: "flash_attention_2",
    },
  },
  "minimax-text-01-32b": {
    architecture: "decoder-only",
    vocabSize: 102400,
    hiddenSize: 7168,
    intermediateSize: 28672,
    numLayers: 56,
    numHeads: 56,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 400000,  // 400K 上下文
    minimax25Config: {
      useSlidingWindow: true,
      slidingWindowSize: 65536,
      ropeScaling: { type: "yarn", factor: 4.0, original_max_position_embeddings: 32768 },
      attentionImplementation: "flash_attention_2",
      compressKV: true,
      compressKVFactor: 4,
    },
  },
  "minimax-text-01-456b": {
    architecture: "decoder-only",
    vocabSize: 102400,
    hiddenSize: 12288,
    intermediateSize: 49152,
    numLayers: 80,
    numHeads: 96,
    numKvHeads: 8,  // GQA
    maxPositionEmbeddings: 400000,
    minimax25Config: {
      useSlidingWindow: true,
      slidingWindowSize: 131072,
      ropeScaling: { type: "yarn", factor: 12.0, original_max_position_embeddings: 32768 },
      attentionImplementation: "flash_attention_2",
      compressKV: true,
      compressKVFactor: 8,
    },
  },
};

/**
 * 获取 MiniMax 2.5/2.7 模型的内存需求估算
 */
export function estimateMinimax25Memory(params: {
  config: NativeModelConfig;
  minimax25Config?: Minimax25Config;
  quantization?: "q4_0" | "q4_1" | "q5_0" | "q5_1" | "q8_0" | "f16" | "f32";
  batchSize?: number;
  maxSeqLen?: number;
}): { weights: number; kvCache: number; total: number } {
  const cfg = params.config;
  const minimax25Config = params.minimax25Config ?? {};
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

  // KV Cache 内存 (MB) - 考虑压缩
  const batchSize = params.batchSize ?? 1;
  const maxSeqLen = params.maxSeqLen ?? cfg.maxPositionEmbeddings ?? 8192;
  const compressFactor = minimax25Config.compressKV 
    ? (minimax25Config.compressKVFactor ?? 1) 
    : 1;
  const kvCacheMB = 2 * batchSize * layers * kvHeads * (maxSeqLen / compressFactor) * headDim * 2 / 1024 / 1024;

  return {
    weights: Math.round(weightsMB),
    kvCache: Math.round(kvCacheMB),
    total: Math.round(weightsMB + kvCacheMB),
  };
}

/**
 * MiniMax 特有: KV 缓存压缩
 * 对长序列进行分层压缩
 */
export function compressMinimaxKVCache(
  kvCache: { k: Float32Array; v: Float32Array },
  factor: number,
  method: "mean" | "max" | "stride" = "mean"
): { k: Float32Array; v: Float32Array } {
  const seqLen = kvCache.k.length / (kvCache.k.BYTES_PER_ELEMENT || 4);
  const compressedLen = Math.floor(seqLen / factor);
  
  const compressedK = new Float32Array(kvCache.k.length / factor);
  const compressedV = new Float32Array(kvCache.v.length / factor);
  
  for (let i = 0; i < compressedLen; i++) {
    const start = i * factor;
    const end = Math.min(start + factor, seqLen);
    
    for (let j = 0; j < compressedK.length / compressedLen; j++) {
      const offset = j * compressedLen + i;
      
      if (method === "mean") {
        let sumK = 0, sumV = 0, count = 0;
        for (let k = start; k < end; k++) {
          const srcIdx = j * seqLen + k;
          sumK += kvCache.k[srcIdx];
          sumV += kvCache.v[srcIdx];
          count++;
        }
        compressedK[offset] = sumK / count;
        compressedV[offset] = sumV / count;
      } else if (method === "max") {
        let maxK = -Infinity, maxV = -Infinity;
        for (let k = start; k < end; k++) {
          const srcIdx = j * seqLen + k;
          maxK = Math.max(maxK, kvCache.k[srcIdx]);
          maxV = Math.max(maxV, kvCache.v[srcIdx]);
        }
        compressedK[offset] = maxK;
        compressedV[offset] = maxV;
      } else if (method === "stride") {
        compressedK[offset] = kvCache.k[j * seqLen + start];
        compressedV[offset] = kvCache.v[j * seqLen + start];
      }
    }
  }
  
  return { k: compressedK, v: compressedV };
}
