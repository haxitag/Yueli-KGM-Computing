/**
 * 量化配置管理模块
 * 借鉴 Shimmy 的量化策略，统一管理 Q4/Q8/KV 缓存
 */

export type QuantizationType =
  | "q4_0"
  | "q4_1"
  | "q5_0"
  | "q5_1"
  | "q8_0"
  | "q2_k"
  | "q3_k"
  | "q4_k"
  | "q5_k"
  | "q6_k"
  | "q8_k"
  | "f16"
  | "f32";

export interface QuantizationConfig {
  type: QuantizationType;
  kvCacheQuantization?: QuantizationType;
  kvCacheSize?: number; // MB
  groupSize?: number;
  useFlashAttention?: boolean;
  ropeScaling?: "linear" | "yarn" | "dynamic" | "none";
  ropeBase?: number;
  contextLength?: number;
}

export interface MemoryConfig {
  // GPU 显存限制 (MB)
  gpuMemoryLimit?: number;
  // CPU 内存限制 (MB)
  cpuMemoryLimit?: number;
  // 是否启用内存映射
  useMmap?: boolean;
  // 是否锁定内存
  useMlock?: boolean;
  // 批量大小
  batchSize?: number;
  // 线程数
  threads?: number;
  // GPU 层数 (自动计算或手动指定)
  gpuLayers?: number | "auto";
}

export interface MOEConfig {
  // 启用 MOE CPU 卸载
  enabled: boolean;
  // CPU 处理的层数
  cpuLayers?: number;
  // GPU 处理的层数 (auto = 全部 - cpuLayers)
  gpuLayers?: number | "auto";
  // 混合精度
  mixedPrecision?: boolean;
  // 专家并行策略
  expertParallel?: "data" | "tensor" | "pipeline";
}

export class QuantizationManager {
  /**
   * 获取推荐的量化配置
   * 根据可用内存自动选择最优量化策略
   */
  static getRecommendedConfig(
    availableGPUMB: number,
    availableCPUMB: number,
    modelSizeMB: number,
    contextLength = 4096
  ): {
    quantization: QuantizationConfig;
    memory: MemoryConfig;
    moe: MOEConfig;
  } {
    // 计算是否需要 MOE 卸载
    const needsMOE = modelSizeMB > availableGPUMB * 0.8;

    // 选择量化级别
    let quantizationType: QuantizationType;
    let kvQuant: QuantizationType | undefined;

    if (availableGPUMB > modelSizeMB * 2) {
      // 显存充足，使用 Q8
      quantizationType = "q8_0";
      kvQuant = "q8_0";
    } else if (availableGPUMB > modelSizeMB) {
      // 显存适中，使用 Q5
      quantizationType = "q5_k";
      kvQuant = "q8_0";
    } else if (availableGPUMB > modelSizeMB * 0.5) {
      // 显存紧张，使用 Q4
      quantizationType = "q4_k";
      kvQuant = "q4_k";
    } else {
      // 显存严重不足，使用 Q2 + MOE
      quantizationType = "q2_k";
      kvQuant = "q4_k";
    }

    // 计算 KV 缓存大小
    // 公式: 2 * num_layers * num_heads * head_dim * seq_len * bytes_per_token
    const kvCacheSize = this.estimateKVCacheSize(
      modelSizeMB,
      contextLength,
      kvQuant
    );

    // 计算 GPU 层数
    let gpuLayers: number | "auto" = "auto";
    let cpuLayers = 0;

    if (needsMOE) {
      // 估算每层大小
      const avgLayerSize = modelSizeMB / 40; // 假设 40 层
      const maxGpuLayers = Math.floor(
        (availableGPUMB - kvCacheSize) / avgLayerSize
      );
      gpuLayers = Math.max(1, maxGpuLayers);
      cpuLayers = 40 - gpuLayers;
    }

    return {
      quantization: {
        type: quantizationType,
        kvCacheQuantization: kvQuant,
        kvCacheSize,
        groupSize: 128,
        useFlashAttention: availableGPUMB > 4000, // 4GB+ 启用 Flash Attention
        ropeScaling: contextLength > 4096 ? "yarn" : "none",
        ropeBase: contextLength > 4096 ? 10000 : 10000,
        contextLength,
      },
      memory: {
        gpuMemoryLimit: availableGPUMB,
        cpuMemoryLimit: availableCPUMB,
        useMmap: true,
        useMlock: false,
        batchSize: needsMOE ? 256 : 512,
        threads: Math.min(8, Math.max(4, Math.floor(availableCPUMB / 2048))),
        gpuLayers,
      },
      moe: {
        enabled: needsMOE,
        cpuLayers,
        gpuLayers,
        mixedPrecision: true,
        expertParallel: "data",
      },
    };
  }

  /**
   * 估算 KV 缓存大小
   */
  private static estimateKVCacheSize(
    modelSizeMB: number,
    seqLen: number,
    quantType?: QuantizationType
  ): number {
    // 粗略估算: 假设模型有 40 层，32 个头，128 维
    const numLayers = 40;
    const numHeads = 32;
    const headDim = 128;
    const bytesPerToken = this.getBytesPerToken(quantType);

    // 2 (K and V) * layers * heads * dim * seq_len * bytes
    const kvSizeBytes =
      2 * numLayers * numHeads * headDim * seqLen * bytesPerToken;
    const kvSizeMB = kvSizeBytes / (1024 * 1024);

    return Math.ceil(kvSizeMB);
  }

  /**
   * 获取量化类型的字节数
   */
  private static getBytesPerToken(type?: QuantizationType): number {
    switch (type) {
      case "q4_0":
      case "q4_1":
      case "q4_k":
        return 0.5;
      case "q5_0":
      case "q5_1":
      case "q5_k":
        return 0.625;
      case "q6_k":
        return 0.75;
      case "q8_0":
      case "q8_k":
        return 1.0;
      case "q2_k":
        return 0.25;
      case "q3_k":
        return 0.375;
      case "f16":
        return 2.0;
      case "f32":
        return 4.0;
      default:
        return 2.0; // 默认 f16
    }
  }

  /**
   * 将量化配置转换为 llama.cpp 参数
   */
  static toLlamaCppParams(config: {
    quantization: QuantizationConfig;
    memory: MemoryConfig;
    moe: MOEConfig;
  }): string[] {
    const args: string[] = [];

    // 量化类型
    args.push("--n-gpu-layers", String(config.memory.gpuLayers ?? 0));

    // 上下文长度
    if (config.quantization.contextLength) {
      args.push("-c", String(config.quantization.contextLength));
    }

    // 批大小
    if (config.memory.batchSize) {
      args.push("-b", String(config.memory.batchSize));
    }

    // 线程数
    if (config.memory.threads) {
      args.push("--threads", String(config.memory.threads));
    }

    // 内存映射
    if (config.memory.useMmap) {
      args.push("--mmap");
    }

    // 内存锁定
    if (config.memory.useMlock) {
      args.push("--mlock");
    }

    // 启用 Flash Attention
    if (config.quantization.useFlashAttention) {
      args.push("--flash-attn");
    }

    // RoPE 配置
    if (config.quantization.ropeScaling && config.quantization.ropeScaling !== "none") {
      args.push("--rope-scaling", config.quantization.ropeScaling);
    }

    if (config.quantization.ropeBase) {
      args.push("--rope-freq-base", String(config.quantization.ropeBase));
    }

    // MOE 配置 (llama.cpp 特定参数)
    if (config.moe.enabled) {
      args.push("--cpu-moe");
      if (config.moe.cpuLayers) {
        args.push("--n-cpu-moe", String(config.moe.cpuLayers));
      }
    }

    return args;
  }

  /**
   * 估算模型显存需求
   */
  static estimateMemoryRequirement(
    modelSizeMB: number,
    contextLength: number,
    quantType: QuantizationType = "q4_k",
    batchSize = 512
  ): {
    modelMemory: number;
    kvCacheMemory: number;
    activationMemory: number;
    totalMemory: number;
    recommendedGPUMB: number;
  } {
    const quantRatio = this.getBytesPerToken(quantType) / 2; // 相对于 f16
    const quantizedSize = modelSizeMB * quantRatio;

    const kvCacheSize = this.estimateKVCacheSize(
      modelSizeMB,
      contextLength,
      quantType
    );

    // 激活值内存估算 (粗略)
    const activationMemory = batchSize * contextLength * 0.5; // MB

    const totalMemory = quantizedSize + kvCacheSize + activationMemory;

    // 建议显存 (含 20% 余量)
    const recommendedGPUMB = Math.ceil(totalMemory * 1.2);

    return {
      modelMemory: Math.ceil(quantizedSize),
      kvCacheMemory: Math.ceil(kvCacheSize),
      activationMemory: Math.ceil(activationMemory),
      totalMemory: Math.ceil(totalMemory),
      recommendedGPUMB,
    };
  }

  /**
   * 获取支持的量化类型列表
   */
  static getSupportedQuantizations(): Array<{
    type: QuantizationType;
    description: string;
    compressionRatio: number;
    quality: "high" | "medium" | "low";
  }> {
    return [
      { type: "q4_0", description: "Q4_0 (legacy)", compressionRatio: 4, quality: "medium" },
      { type: "q4_1", description: "Q4_1 (legacy)", compressionRatio: 4, quality: "medium" },
      { type: "q5_0", description: "Q5_0 (legacy)", compressionRatio: 3.2, quality: "medium" },
      { type: "q5_1", description: "Q5_1 (legacy)", compressionRatio: 3.2, quality: "medium" },
      { type: "q8_0", description: "Q8_0 (high quality)", compressionRatio: 2, quality: "high" },
      { type: "q2_k", description: "Q2_K (smallest)", compressionRatio: 8, quality: "low" },
      { type: "q3_k", description: "Q3_K (small)", compressionRatio: 5.3, quality: "low" },
      { type: "q4_k", description: "Q4_K (balanced)", compressionRatio: 4, quality: "medium" },
      { type: "q5_k", description: "Q5_K (good)", compressionRatio: 3.2, quality: "medium" },
      { type: "q6_k", description: "Q6_K (better)", compressionRatio: 2.7, quality: "high" },
      { type: "q8_k", description: "Q8_K (best quantized)", compressionRatio: 2, quality: "high" },
      { type: "f16", description: "FP16 (half precision)", compressionRatio: 1, quality: "high" },
      { type: "f32", description: "FP32 (full precision)", compressionRatio: 0.5, quality: "high" },
    ];
  }
}

// 便捷导出
export const getRecommendedQuantization = QuantizationManager.getRecommendedConfig;
export const estimateMemory = QuantizationManager.estimateMemoryRequirement;
