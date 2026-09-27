/**
 * MOE (Mixture of Experts) CPU/GPU 混合卸载模块
 * 借鉴 Shimmy 的 MOE 策略，实现智能分层卸载
 */

import { EventEmitter } from "node:events";

export interface LayerPlacement {
  layerIndex: number;
  device: "cpu" | "gpu";
  memoryRequirement: number; // MB
  executionPriority: number; // 0-100, 越高越优先在 GPU
}

export interface MOEExecutionPlan {
  totalLayers: number;
  gpuLayers: number;
  cpuLayers: number;
  placements: LayerPlacement[];
  estimatedGpuMemory: number;
  estimatedCpuMemory: number;
  hybridOverhead: number; // 混合执行的额外开销
}

export interface DeviceInfo {
  type: "cpu" | "gpu";
  index: number;
  totalMemory: number; // MB
  availableMemory: number; // MB
  computeCapability?: number; // GPU 计算能力
  supportsCUDA?: boolean;
  supportsMetal?: boolean;
  supportsVulkan?: boolean;
}

export class MOEOffloading extends EventEmitter {
  private devices: Map<string, DeviceInfo> = new Map();
  private currentPlan: MOEExecutionPlan | null = null;

  /**
   * 注册设备
   */
  registerDevice(device: DeviceInfo): void {
    this.devices.set(`${device.type}-${device.index}`, device);
    this.emit("deviceRegistered", device);
  }

  /**
   * 创建设备执行计划
   * 这是核心算法，决定哪些层放在 GPU，哪些放在 CPU
   */
  createExecutionPlan(
    totalLayers: number,
    layerMemoryUsage: number[], // 每层内存占用 (MB)
    preferences: {
      minGpuLayers?: number; // 最少 GPU 层数
      maxCpuLayers?: number; // 最多 CPU 层数
      preferGpuForAttention?: boolean; // Attention 层优先 GPU
      preferCpuForFFN?: boolean; // FFN 层优先 CPU
    } = {}
  ): MOEExecutionPlan {
    const gpu = Array.from(this.devices.values()).find((d) => d.type === "gpu");
    const cpu = Array.from(this.devices.values()).find((d) => d.type === "cpu") || {
      type: "cpu",
      index: 0,
      totalMemory: Infinity,
      availableMemory: Infinity,
    };

    if (!gpu) {
      // 没有 GPU，全部 CPU
      return this.createAllCPUPlan(totalLayers, layerMemoryUsage);
    }

    const { minGpuLayers = 1, maxCpuLayers = totalLayers - 1 } = preferences;

    // 策略 1: 优先填满 GPU
    let gpuLayers = 0;
    let gpuMemoryUsed = 0;
    const placements: LayerPlacement[] = [];

    // 计算 KV 缓存预留 (每层大约需要)
    const kvCachePerLayer = 20; // MB, 粗略估算
    const availableGpuMemory = gpu.availableMemory - kvCachePerLayer * totalLayers * 2;

    // 策略: 优先将 Attention 层放在 GPU (通常 0, 1, total-2, total-1 是 Attention)
    // 这里的简化策略: 前 N 层和后 M 层放 GPU，中间放 CPU
    const attentionLayers = new Set([
      0,
      1,
      totalLayers - 2,
      totalLayers - 1,
    ]);

    // 计算可以放多少层到 GPU
    for (let i = 0; i < totalLayers; i++) {
      const memory = layerMemoryUsage[i] || layerMemoryUsage[0] || 100;
      const isAttention = attentionLayers.has(i);

      // 如果是 Attention 层且 GPU 内存还够，优先放 GPU
      if (
        isAttention &&
        preferences.preferGpuForAttention !== false &&
        gpuMemoryUsed + memory < availableGpuMemory * 0.8
      ) {
        gpuLayers++;
        gpuMemoryUsed += memory;
      }
    }

    // 继续填充 GPU，直到达到限制
    for (let i = 0; i < totalLayers; i++) {
      const memory = layerMemoryUsage[i] || layerMemoryUsage[0] || 100;
      const isAttention = attentionLayers.has(i);

      // 已经处理过的 Attention 层跳过
      if (isAttention) continue;

      // 检查是否还能放入 GPU
      if (
        gpuMemoryUsed + memory < availableGpuMemory * 0.9 && // 90% 使用率限制
        gpuLayers < totalLayers - maxCpuLayers &&
        gpuLayers < totalLayers - minGpuLayers + 1
      ) {
        gpuLayers++;
        gpuMemoryUsed += memory;
      }
    }

    // 确保满足最少 GPU 层数要求
    while (gpuLayers < minGpuLayers && gpuLayers < totalLayers) {
      const memory = layerMemoryUsage[gpuLayers] || layerMemoryUsage[0] || 100;
      if (gpuMemoryUsed + memory < gpu.totalMemory) {
        gpuMemoryUsed += memory;
        gpuLayers++;
      } else {
        break;
      }
    }

    const cpuLayers = totalLayers - gpuLayers;

    // 生成层放置方案
    // 策略: 前 X 层和后 Y 层放 GPU，中间放 CPU
    // 这样可以减少数据传输次数
    const frontGpuLayers = Math.ceil(gpuLayers / 2);
    const backGpuLayers = gpuLayers - frontGpuLayers;

    for (let i = 0; i < totalLayers; i++) {
      const memory = layerMemoryUsage[i] || layerMemoryUsage[0] || 100;

      let device: "cpu" | "gpu";
      let priority: number;

      if (i < frontGpuLayers || i >= totalLayers - backGpuLayers) {
        device = "gpu";
        // 越靠近两端，优先级越高 (减少数据传输)
        priority = i < frontGpuLayers ? 100 - i : 100 - (totalLayers - 1 - i);
      } else {
        device = "cpu";
        // CPU 层优先级较低
        priority = 10;
      }

      placements.push({
        layerIndex: i,
        device,
        memoryRequirement: memory,
        executionPriority: priority,
      });
    }

    // 计算 CPU 内存需求
    const cpuMemoryUsed = placements
      .filter((p) => p.device === "cpu")
      .reduce((sum, p) => sum + p.memoryRequirement, 0);

    // 估算混合开销 (CPU/GPU 数据传输)
    const hybridOverhead = this.calculateHybridOverhead(placements, totalLayers);

    const plan: MOEExecutionPlan = {
      totalLayers,
      gpuLayers,
      cpuLayers,
      placements,
      estimatedGpuMemory: gpuMemoryUsed,
      estimatedCpuMemory: cpuMemoryUsed,
      hybridOverhead,
    };

    this.currentPlan = plan;
    this.emit("planCreated", plan);

    return plan;
  }

  /**
   * 创建纯 CPU 执行计划
   */
  private createAllCPUPlan(
    totalLayers: number,
    layerMemoryUsage: number[]
  ): MOEExecutionPlan {
    const placements: LayerPlacement[] = [];
    let cpuMemoryUsed = 0;

    for (let i = 0; i < totalLayers; i++) {
      const memory = layerMemoryUsage[i] || layerMemoryUsage[0] || 100;
      placements.push({
        layerIndex: i,
        device: "cpu",
        memoryRequirement: memory,
        executionPriority: 50,
      });
      cpuMemoryUsed += memory;
    }

    return {
      totalLayers,
      gpuLayers: 0,
      cpuLayers: totalLayers,
      placements,
      estimatedGpuMemory: 0,
      estimatedCpuMemory: cpuMemoryUsed,
      hybridOverhead: 0,
    };
  }

  /**
   * 计算混合执行开销
   */
  private calculateHybridOverhead(
    placements: LayerPlacement[],
    totalLayers: number
  ): number {
    // 计算 CPU/GPU 切换次数
    let switches = 0;
    let lastDevice: "cpu" | "gpu" | null = null;

    for (const p of placements) {
      if (lastDevice !== null && lastDevice !== p.device) {
        switches++;
      }
      lastDevice = p.device;
    }

    // 每次切换大约 10-50ms 开销 (取决于数据大小)
    const overheadPerSwitch = 30; // ms
    return switches * overheadPerSwitch;
  }

  /**
   * 动态调整执行计划
   * 根据运行时性能反馈调整层放置
   */
  adjustPlan(
    performanceMetrics: {
      layerIndex: number;
      executionTime: number; // ms
      device: "cpu" | "gpu";
    }[]
  ): MOEExecutionPlan | null {
    if (!this.currentPlan) return null;

    // 找出性能瓶颈层
    const slowLayers = performanceMetrics
      .filter((m) => m.executionTime > 50) // > 50ms 认为是慢层
      .sort((a, b) => b.executionTime - a.executionTime);

    // 如果某层在 CPU 上很慢，尝试移动到 GPU (如果有空间)
    const newPlacements = [...this.currentPlan.placements];
    let modified = false;

    for (const slow of slowLayers) {
      if (slow.device === "cpu") {
        // 找到可以交换的 GPU 层
        const fastGpuLayer = performanceMetrics.find(
          (m) => m.device === "gpu" && m.executionTime < 10
        );

        if (fastGpuLayer) {
          // 交换两层的位置
          const slowIdx = newPlacements.findIndex(
            (p) => p.layerIndex === slow.layerIndex
          );
          const fastIdx = newPlacements.findIndex(
            (p) => p.layerIndex === fastGpuLayer.layerIndex
          );

          if (slowIdx !== -1 && fastIdx !== -1) {
            newPlacements[slowIdx].device = "gpu";
            newPlacements[fastIdx].device = "cpu";
            modified = true;
          }
        }
      }
    }

    if (modified) {
      this.currentPlan = {
        ...this.currentPlan,
        placements: newPlacements,
      };
      this.emit("planAdjusted", this.currentPlan);
    }

    return this.currentPlan;
  }

  /**
   * 导出为 llama.cpp 的 --n-gpu-layers 参数
   */
  toLlamaCppParams(plan: MOEExecutionPlan): string[] {
    return ["--n-gpu-layers", String(plan.gpuLayers), "--cpu-moe"];
  }

  /**
   * 导出为 vLLM 的 --num-gpu-blocks-override 参数
   */
  toVllmParams(plan: MOEExecutionPlan): Record<string, string | number> {
    return {
      "num_gpu_blocks_override": plan.gpuLayers,
      "cpu_offload_gb": plan.estimatedCpuMemory / 1024,
    };
  }

  /**
   * 获取当前执行计划
   */
  getCurrentPlan(): MOEExecutionPlan | null {
    return this.currentPlan;
  }

  /**
   * 估算层内存占用
   * 基于模型参数大小粗略估算
   */
  static estimateLayerMemory(
    modelSizeMB: number,
    numLayers: number,
    quantizationRatio: number = 0.5 // Q4 默认压缩率
  ): number[] {
    const avgLayerSize = (modelSizeMB * quantizationRatio) / numLayers;

    // 各层大小有差异: Attention 层通常较小，FFN 层较大
    const layerSizes: number[] = [];

    for (let i = 0; i < numLayers; i++) {
      // 简化的估算: 偶数层 (Attention) 较小，奇数层 (FFN) 较大
      const isAttention = i % 2 === 0;
      const ratio = isAttention ? 0.3 : 0.7;
      layerSizes.push(avgLayerSize * ratio);
    }

    return layerSizes;
  }
}

// 便捷导出
export const globalMOEOffloading = new MOEOffloading();
