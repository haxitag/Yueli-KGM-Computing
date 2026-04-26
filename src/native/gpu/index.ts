/**
 * Yueli Native GPU 模型适配器统一导出
 * 支持 Qwen 3.5/3.6, GLM 5.0/5.1, Google Gemma 4, Minimax 2.5/2.7, MiMo 2.5
 */

// Qwen 3.x 系列
import {
  buildQwen3SafetensorsAliases,
  QWEN3_RECOMMENDED_CONFIGS,
  estimateQwen3Memory,
  type Qwen3Config,
  type Qwen3SafetensorsAlias,
} from "./qwen3.js";
export { buildQwen3SafetensorsAliases, QWEN3_RECOMMENDED_CONFIGS, estimateQwen3Memory, type Qwen3Config, type Qwen3SafetensorsAlias };

// GLM 5.x 系列
import {
  buildGlm5SafetensorsAliases,
  GLM5_RECOMMENDED_CONFIGS,
  estimateGlm5Memory,
  buildGlmPrefixMask,
  type Glm5Config,
  type Glm5SafetensorsAlias,
} from "./glm5.js";
export { buildGlm5SafetensorsAliases, GLM5_RECOMMENDED_CONFIGS, estimateGlm5Memory, buildGlmPrefixMask, type Glm5Config, type Glm5SafetensorsAlias };

// Google Gemma 4.x 系列
import {
  buildGemma4SafetensorsAliases,
  GEMMA4_RECOMMENDED_CONFIGS,
  estimateGemma4Memory,
  normalizeGemmaEmbeddings,
  applyGeGLU,
  type Gemma4Config,
  type Gemma4SafetensorsAlias,
} from "./gemma4.js";
export { buildGemma4SafetensorsAliases, GEMMA4_RECOMMENDED_CONFIGS, estimateGemma4Memory, normalizeGemmaEmbeddings, applyGeGLU, type Gemma4Config, type Gemma4SafetensorsAlias };

// MiniMax 2.5/2.7 系列
import {
  buildMinimax25SafetensorsAliases,
  MINIMAX25_RECOMMENDED_CONFIGS,
  estimateMinimax25Memory,
  compressMinimaxKVCache,
  type Minimax25Config,
  type Minimax25SafetensorsAlias,
} from "./minimax25.js";
export { buildMinimax25SafetensorsAliases, MINIMAX25_RECOMMENDED_CONFIGS, estimateMinimax25Memory, compressMinimaxKVCache, type Minimax25Config, type Minimax25SafetensorsAlias };

// MiMo 2.5 系列
import {
  buildMimo25SafetensorsAliases,
  MIMO25_RECOMMENDED_CONFIGS,
  estimateMimo25Memory,
  getMimoEdgeQuantizationConfig,
  getMimoRecommendedBatchSize,
  type Mimo25Config,
  type Mimo25SafetensorsAlias,
} from "./mimo25.js";
export { buildMimo25SafetensorsAliases, MIMO25_RECOMMENDED_CONFIGS, estimateMimo25Memory, getMimoEdgeQuantizationConfig, getMimoRecommendedBatchSize, type Mimo25Config, type Mimo25SafetensorsAlias };

// 原有 Qwen2 支持
import {
  buildQwen2SafetensorsAliases,
  QWEN2_RECOMMENDED_CONFIGS,
  estimateQwen2Memory,
  type Qwen2SafetensorsAlias,
} from "./qwen2.js";
export { buildQwen2SafetensorsAliases, QWEN2_RECOMMENDED_CONFIGS, estimateQwen2Memory, type Qwen2SafetensorsAlias };

// 模型类型枚举
export type SupportedModelFamily = 
  | "qwen"
  | "glm" 
  | "gemma"
  | "minimax"
  | "mimo";

/**
 * 模型注册表
 * 所有支持的模型及其配置
 */
export const MODEL_REGISTRY = {
  // Qwen 系列
  qwen: {
    name: "Qwen",
    family: "qwen" as SupportedModelFamily,
    models: {
      "qwen2-7b": { config: "qwen2", size: "7B" },
      "qwen2-14b": { config: "qwen2", size: "14B" },
      "qwen3.5-7b": { config: "qwen3", size: "7B" },
      "qwen3.5-14b": { config: "qwen3", size: "14B" },
      "qwen3.5-32b": { config: "qwen3", size: "32B" },
      "qwen3.6-72b": { config: "qwen3", size: "72B" },
    },
    features: ["SlidingWindow", "RoPE", "SwiGLU"],
  },
  
  // GLM 系列
  glm: {
    name: "GLM",
    family: "glm" as SupportedModelFamily,
    models: {
      "glm-4-9b": { config: "glm5", size: "9B" },
      "glm-4-32b": { config: "glm5", size: "32B" },
      "glm-5.0": { config: "glm5", size: "32B" },
      "glm-5.1": { config: "glm5", size: "32B" },
    },
    features: ["MultiQueryAttention", "PrefixAttention", "ChineseOptimized"],
  },
  
  // Gemma 系列
  gemma: {
    name: "Gemma",
    family: "gemma" as SupportedModelFamily,
    models: {
      "gemma-4-2b-it": { config: "gemma4", size: "2B" },
      "gemma-4-4b": { config: "gemma4", size: "4B" },
      "gemma-4-9b": { config: "gemma4", size: "9B" },
      "gemma-4-27b": { config: "gemma4", size: "27B" },
    },
    features: ["RMSNorm", "GeGLU", "NoBias"],
  },
  
  // MiniMax 系列
  minimax: {
    name: "MiniMax",
    family: "minimax" as SupportedModelFamily,
    models: {
      "minimax-text-01-4b": { config: "minimax25", size: "4B" },
      "minimax-text-01-8b": { config: "minimax25", size: "8B" },
      "minimax-text-01-32b": { config: "minimax25", size: "32B" },
      "minimax-text-01-456b": { config: "minimax25", size: "456B" },
    },
    features: ["GQA", "400KContext", "KVCompression", "FlashAttention2"],
  },
  
  // MiMo 系列
  mimo: {
    name: "MiMo",
    family: "mimo" as SupportedModelFamily,
    models: {
      "mimo-2.5-1.5b": { config: "mimo25", size: "1.5B" },
      "mimo-2.5-7b": { config: "mimo25", size: "7B" },
      "mimo-2.5-13b": { config: "mimo25", size: "13B" },
      "mimo-2.5-30b": { config: "mimo25", size: "30B" },
    },
    features: ["EdgeOptimized", "GQA", "Int4Quantization"],
  },
};

/**
 * 根据模型名称获取配置
 */
export function getModelConfig(modelName: string): {
  family: SupportedModelFamily;
  config: unknown;
  size: string;
} | null {
  for (const [familyKey, familyData] of Object.entries(MODEL_REGISTRY)) {
    if (modelName in familyData.models) {
      const modelData = familyData.models[modelName as keyof typeof familyData.models];
      if (modelData) {
        let config;
        switch (modelData.config) {
          case "qwen2":
            config = QWEN2_RECOMMENDED_CONFIGS[modelName];
            break;
          case "qwen3":
            config = QWEN3_RECOMMENDED_CONFIGS[modelName];
            break;
          case "glm5":
            config = GLM5_RECOMMENDED_CONFIGS[modelName];
            break;
          case "gemma4":
            config = GEMMA4_RECOMMENDED_CONFIGS[modelName];
            break;
          case "minimax25":
            config = MINIMAX25_RECOMMENDED_CONFIGS[modelName];
            break;
          case "mimo25":
            config = MIMO25_RECOMMENDED_CONFIGS[modelName];
            break;
          default:
            return null;
        }
        return {
          family: familyData.family,
          config,
          size: modelData.size,
        };
      }
    }
  }
  return null;
}

/**
 * 获取模型的内存需求
 */
export function estimateModelMemory(
  modelName: string,
  params: {
    quantization?: "q4_0" | "q4_1" | "q5_0" | "q5_1" | "q8_0" | "f16" | "f32";
    batchSize?: number;
    maxSeqLen?: number;
  }
): { weights: number; kvCache: number; total: number } | null {
  const modelInfo = getModelConfig(modelName);
  if (!modelInfo || !modelInfo.config) return null;

  const config = modelInfo.config as NativeModelConfig & { 
    qwen3Config?: unknown;
    glm5Config?: unknown;
    gemma4Config?: unknown;
    minimax25Config?: unknown;
    mimo25Config?: unknown;
  };

  switch (modelInfo.family) {
    case "qwen":
      if ("qwen3Config" in config) {
        return estimateQwen3Memory({
          config,
          quantization: params.quantization,
          batchSize: params.batchSize,
          maxSeqLen: params.maxSeqLen,
        });
      }
      return estimateQwen2Memory({
        config,
        quantization: params.quantization,
        batchSize: params.batchSize,
        maxSeqLen: params.maxSeqLen,
      });
    case "glm":
      return estimateGlm5Memory({
        config,
        glm5Config: config.glm5Config,
        quantization: params.quantization,
        batchSize: params.batchSize,
        maxSeqLen: params.maxSeqLen,
      });
    case "gemma":
      return estimateGemma4Memory({
        config,
        gemma4Config: config.gemma4Config,
        quantization: params.quantization,
        batchSize: params.batchSize,
        maxSeqLen: params.maxSeqLen,
      });
    case "minimax":
      return estimateMinimax25Memory({
        config,
        minimax25Config: config.minimax25Config,
        quantization: params.quantization,
        batchSize: params.batchSize,
        maxSeqLen: params.maxSeqLen,
      });
    case "mimo":
      return estimateMimo25Memory({
        config,
        mimo25Config: config.mimo25Config,
        quantization: params.quantization,
        batchSize: params.batchSize,
        maxSeqLen: params.maxSeqLen,
      });
    default:
      return null;
  }
}

// 导入 NativeModelConfig 类型
import type { NativeModelConfig } from "../types.js";
