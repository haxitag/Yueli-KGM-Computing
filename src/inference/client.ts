import type { CompletionOptions } from "../llm/client.js";
import { EnhancedNativeRuntimeEngine, type EnhancedEngineOptions } from "./enhancedEngine.js";
import { generateId } from "../utils/id.js";

/**
 * 增强型LLM客户端
 * 将增强推理引擎集成到标准LLM客户端接口中
 */
export class EnhancedLLMClient {
  private engine: EnhancedNativeRuntimeEngine;
  private clientId: string;
  private modelName: string;

  constructor(engine: EnhancedNativeRuntimeEngine, modelName: string) {
    this.engine = engine;
    this.modelName = modelName;
    this.clientId = generateId();
  }

  /**
   * 完成文本生成
   */
  async complete(
    prompt: string,
    options?: CompletionOptions
  ): Promise<{
    text: string;
    finishReason: string;
    tokensGenerated: number;
    ttftMs: number;
    totalTimeMs: number;
    cacheHit: boolean;
  }> {
    const startTime = Date.now();

    // 执行推理
    const result = await this.engine.complete(prompt, {
      maxTokens: options?.maxTokens ?? 100,
      temperature: options?.temperature,
      topP: options?.topP,
    });

    const endTime = Date.now();

    // 检查是否命中前缀缓存
    const stats = this.engine.getEnhancedStats();
    const cacheHit = stats.prefixCache.hitRate > 0;

    return {
      text: result.text || "",
      finishReason: result.finishReason ?? "stop",
      tokensGenerated: result.tokensGenerated ?? 0,
      ttftMs: result.ttftMs ?? (endTime - startTime),
      totalTimeMs: endTime - startTime,
      cacheHit,
    };
  }

  /**
   * 流式文本生成
   */
  async *streamComplete(
    prompt: string,
    options?: CompletionOptions
  ): AsyncGenerator<{
    type: "token" | "start" | "end";
    text?: string;
    tokenIndex?: number;
    ttftMs?: number;
  }> {
    const startTime = Date.now();
    let tokenIndex = 0;
    let ttftMs: number | undefined;

    // 发送start事件
    yield {
      type: "start",
      text: prompt,
    };

    for await (const event of this.engine.streamComplete(prompt, {
      maxTokens: options?.maxTokens ?? 100,
      temperature: options?.temperature,
      topP: options?.topP,
    })) {
      if (event.type === "token") {
        // 第一次收到token时记录TTFT
        if (ttftMs === undefined) {
          ttftMs = Date.now() - startTime;
        }

        yield {
          type: "token",
          text: event.text,
          tokenIndex: tokenIndex++,
          ttftMs,
        };
      }
    }

    // 发送end事件
    yield {
      type: "end",
      tokenIndex,
      ttftMs,
    };
  }

  /**
   * 批量完成
   */
  async batchComplete(
    prompts: string[],
    options?: CompletionOptions
  ): Promise<
    Array<{
      text: string;
      tokensGenerated: number;
      ttftMs: number;
      totalTimeMs: number;
      cacheHit: boolean;
    }>
  > {
    // 如果引擎没有调度器,顺序执行
    const results: Array<{
      text: string;
      tokensGenerated: number;
      ttftMs: number;
      totalTimeMs: number;
      cacheHit: boolean;
    }> = [];

    for (const prompt of prompts) {
      const result = await this.complete(prompt, options);
      results.push(result);
    }

    return results;
  }

  /**
   * 获取性能统计
   */
  getStats(): {
    prefixCache: {
      hitRate: number;
      memoryBytes: number;
      totalBlocks: number;
      cachedBlocks: number;
    };
    scheduler: {
      totalRequests: number;
      completedRequests: number;
      avgLatencyMs: number;
      avgThroughputTokensPerSec: number;
      avgQueueWaitMs: number;
    } | null;
    kvCache: {
      utilization: number;
      totalMemoryBytes: number;
      usedMemoryBytes: number;
    };
  } {
    const engineStats = this.engine.getEnhancedStats();

    return {
      prefixCache: {
        hitRate: engineStats.prefixCache.hitRate,
        memoryBytes: engineStats.prefixCache.memoryBytes,
        totalBlocks: engineStats.prefixCache.totalBlocks,
        cachedBlocks: engineStats.prefixCache.cachedBlocks,
      },
      scheduler: engineStats.scheduler
        ? {
            totalRequests: engineStats.scheduler.totalRequests,
            completedRequests: engineStats.scheduler.completedRequests,
            avgLatencyMs: engineStats.scheduler.avgLatencyMs,
            avgThroughputTokensPerSec:
              engineStats.scheduler.avgThroughputTokensPerSec,
            avgQueueWaitMs: engineStats.scheduler.avgQueueWaitMs,
          }
        : null,
      kvCache: {
        utilization: engineStats.kvCache.utilization,
        totalMemoryBytes: engineStats.kvCache.totalMemoryBytes,
        usedMemoryBytes: engineStats.kvCache.usedMemoryBytes,
      },
    };
  }

  /**
   * 获取Prometheus指标
   */
  getPrometheusMetrics(): string {
    const stats = this.getStats();
    const lines: string[] = [];

    // 前缀缓存指标
    lines.push(`kgm_enhanced_prefix_cache_hit_rate{client_id="${this.clientId}",model="${this.modelName}"} ${stats.prefixCache.hitRate}`);
    lines.push(`kgm_enhanced_prefix_cache_memory_bytes{client_id="${this.clientId}",model="${this.modelName}"} ${stats.prefixCache.memoryBytes}`);

    // 调度器指标
    if (stats.scheduler) {
      lines.push(`kgm_enhanced_scheduler_avg_latency_ms{client_id="${this.clientId}",model="${this.modelName}"} ${stats.scheduler.avgLatencyMs}`);
      lines.push(`kgm_enhanced_scheduler_avg_throughput_tokens_per_sec{client_id="${this.clientId}",model="${this.modelName}"} ${stats.scheduler.avgThroughputTokensPerSec}`);
      lines.push(`kgm_enhanced_scheduler_avg_queue_wait_ms{client_id="${this.clientId}",model="${this.modelName}"} ${stats.scheduler.avgQueueWaitMs}`);
    }

    // KV Cache指标
    lines.push(`kgm_enhanced_kv_cache_utilization{client_id="${this.clientId}",model="${this.modelName}"} ${stats.kvCache.utilization}`);
    lines.push(`kgm_enhanced_kv_cache_memory_bytes{client_id="${this.clientId}",model="${this.modelName}"} ${stats.kvCache.usedMemoryBytes}`);

    return lines.join("\n");
  }

  /**
   * 清理前缀缓存
   */
  clearPrefixCache(): void {
    // 通过创建新引擎实例来清理
    // 或者可以扩展engine API添加clearCache方法
    console.log("清理前缀缓存功能暂未实现,请重启引擎");
  }

  /**
   * 关闭客户端
   */
  close(): void {
    this.engine.close();
  }

  /**
   * 获取引擎实例
   */
  getEngine(): EnhancedNativeRuntimeEngine {
    return this.engine;
  }

  /**
   * 获取模型名称
   */
  getModelName(): string {
    return this.modelName;
  }
}

/**
 * 创建增强型LLM客户端
 */
export function createEnhancedLLMClient(
  modelPath: string,
  modelName: string,
  options?: EnhancedEngineOptions
): EnhancedLLMClient {
  const engine = new EnhancedNativeRuntimeEngine(modelPath, options);
  return new EnhancedLLMClient(engine, modelName);
}
