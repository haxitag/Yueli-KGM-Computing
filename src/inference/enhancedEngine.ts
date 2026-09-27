import type { CompletionOptions, CompletionResult, CompletionStreamEvent } from "../llm/client.js";
import type { NativeServingBackend, NativeServingBackendOptions } from "../native/backend.js";
import {
  createNativeServingBackend,
  type LoadedNativeModel,
} from "../native/backend.js";
import { MapPrefixCache, computeStableContextHash } from "./prefixCache.js";
import { PagedKvCacheManager } from "./pagedKvCache.js";
import {
  ContinuousBatchingScheduler,
  type BatchSchedulerStats,
} from "./continuousBatching.js";

/**
 * 增强型推理引擎选项
 */
export type EnhancedEngineOptions = NativeServingBackendOptions & {
  enablePrefixCache?: boolean;
  prefixCacheMaxMemoryBytes?: number;
  /** 多请求有界并发调度（委托真实 backend，非 dummy token） */
  enableContinuousBatching?: boolean;
  continuousBatchingMaxBatchSize?: number;
  continuousBatchingMaxQueueSize?: number;
  continuousBatchingMaxWaitingTimeMs?: number;
};

/**
 * 增强型推理引擎
 *
 * Continuous batching 开启时：用 ConcurrentRequestScheduler 做多请求准入/并发，
 * 执行器委托 `NativeServingBackend`（js-reference 内自带 token 级调度环）。
 * 关闭时：直接走 backend，由后端自行处理单请求流。
 */
export class EnhancedNativeRuntimeEngine {
  private backend: NativeServingBackend;
  private prefixCache: MapPrefixCache;
  private requestScheduler?: ContinuousBatchingScheduler;
  private kvCacheManager: PagedKvCacheManager;
  private enablePrefixCache: boolean;
  private enableContinuousBatching: boolean;

  constructor(modelPath: string, options?: EnhancedEngineOptions) {
    this.backend = createNativeServingBackend(modelPath, {
      ...options,
      // 与增强层并发上限对齐，便于多请求同拍 decode
      schedulerMaxBatchSize:
        options?.schedulerMaxBatchSize ?? options?.continuousBatchingMaxBatchSize ?? 8,
      schedulerMaxPrefillsPerTick:
        options?.schedulerMaxPrefillsPerTick ??
        Math.min(4, options?.continuousBatchingMaxBatchSize ?? options?.schedulerMaxBatchSize ?? 8),
    });

    this.enablePrefixCache = options?.enablePrefixCache ?? true;
    this.enableContinuousBatching = options?.enableContinuousBatching ?? true;

    this.prefixCache = new MapPrefixCache({
      maxMemoryBytes: options?.prefixCacheMaxMemoryBytes,
    });

    const hiddenSize = this.backend.metadata().hiddenSize ?? 4096;
    this.kvCacheManager = new PagedKvCacheManager({
      pageSize: options?.kvPageSize ?? 16,
      maxBlocks: options?.cachedKvPageBudget ?? 256,
      hiddenSize,
    });

    if (this.enableContinuousBatching) {
      const maxConcurrency = options?.continuousBatchingMaxBatchSize ?? 8;
      this.requestScheduler = new ContinuousBatchingScheduler(
        {
          maxConcurrency,
          maxBatchSize: maxConcurrency,
          maxQueueLength: options?.continuousBatchingMaxQueueSize ?? 64,
          maxWaitingTime: options?.continuousBatchingMaxWaitingTimeMs ?? 0,
        },
        async (job) => {
          const result = await this.backend.complete(job.prompt, {
            ...job.options,
            requestId: job.options?.requestId ?? job.id,
            signal: job.signal ?? job.options?.signal,
          });
          if (this.enablePrefixCache) {
            const contextHash = this.computeContextHash(job.prompt, job.options);
            // 真实路径无独立 kvBlocks 句柄时，仍记录请求级命中统计占位
            void contextHash;
          }
          return result;
        },
      );
    }
  }

  get modelPath(): string {
    return this.backend.modelPath;
  }

  isExecutable(): boolean {
    return this.backend.isExecutable();
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    if (this.enableContinuousBatching && this.requestScheduler) {
      return this.requestScheduler.submit(prompt, options);
    }

    const result = await this.backend.complete(prompt, options);
    if (this.enablePrefixCache) {
      void this.computeContextHash(prompt, options);
    }
    return result;
  }

  async *streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    // 多请求连续批处理：backend.streamComplete 直接入 native 调度环，可与其他流并发
    if (this.enableContinuousBatching && this.requestScheduler) {
      // 流式仍走 backend，由 native 调度器多请求交错 decode；submit 用于非流完整结果路径
      yield* this.backend.streamComplete(prompt, options);
      return;
    }

    yield* this.backend.streamComplete(prompt, options);
  }

  metadata(): LoadedNativeModel["metadata"] {
    return this.backend.metadata();
  }

  manifest(): LoadedNativeModel["manifest"] {
    return this.backend.manifest();
  }

  executionBackend(): LoadedNativeModel["executionBackend"] {
    return this.backend.executionBackend();
  }

  servingBackend(): NativeServingBackend["kind"] {
    return this.backend.kind;
  }

  schedulerMetrics() {
    return this.backend.schedulerMetrics();
  }

  /**
   * 获取增强引擎的统计信息
   */
  getEnhancedStats(): EnhancedEngineStats {
    const backendSched = this.backend.schedulerMetrics();
    const requestStats = this.requestScheduler?.getStats();
    const prefixCacheStats = this.prefixCache.getStats();
    const kvCacheStats = this.kvCacheManager.getStats();

    const scheduler: BatchSchedulerStats | undefined = requestStats
      ? {
          totalSubmitted: requestStats.totalSubmitted,
          totalCompleted: requestStats.totalCompleted,
          totalFailed: requestStats.totalFailed,
          totalCancelled: requestStats.totalCancelled,
          peakConcurrency: Math.max(requestStats.peakConcurrency, backendSched.peakActive),
          peakQueue: Math.max(requestStats.peakQueue, backendSched.peakQueued),
          avgLatencyMs: requestStats.avgLatencyMs,
          throughputRequestsPerSec: requestStats.throughputRequestsPerSec,
        }
      : undefined;

    return {
      prefixCache: prefixCacheStats,
      scheduler: scheduler
        ? {
            totalRequests: scheduler.totalSubmitted,
            completedRequests: scheduler.totalCompleted,
            preemptedRequests: scheduler.totalCancelled,
            avgLatencyMs: scheduler.avgLatencyMs,
            avgThroughputTokensPerSec: 0,
            totalTokensProcessed: backendSched.decodeSteps,
            avgQueueWaitMs: 0,
          }
        : {
            totalRequests: backendSched.submitted,
            completedRequests: backendSched.completed,
            preemptedRequests: backendSched.cancelled,
            avgLatencyMs: 0,
            avgThroughputTokensPerSec: 0,
            totalTokensProcessed: backendSched.decodeSteps,
            avgQueueWaitMs: 0,
          },
      requestScheduler: scheduler,
      nativeScheduler: backendSched,
      kvCache: kvCacheStats,
    };
  }

  private computeContextHash(prompt: string, options?: CompletionOptions): string {
    const stableContext = {
      prompt: prompt.slice(0, 2048),
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      stop: options?.stop,
    };
    return computeStableContextHash(stableContext);
  }

  close(): void {
    this.requestScheduler?.stop();
    this.prefixCache.clear();
  }
}

/**
 * 增强引擎统计信息
 */
export type EnhancedEngineStats = {
  prefixCache: {
    totalBlocks: number;
    cachedBlocks: number;
    hitRate: number;
    memoryBytes: number;
    totalRequests: number;
    cacheHits: number;
    cacheMisses: number;
  };
  scheduler?: {
    totalRequests: number;
    completedRequests: number;
    preemptedRequests: number;
    avgLatencyMs: number;
    avgThroughputTokensPerSec: number;
    totalTokensProcessed: number;
    avgQueueWaitMs: number;
  };
  requestScheduler?: BatchSchedulerStats;
  nativeScheduler?: {
    submitted: number;
    completed: number;
    failed: number;
    cancelled: number;
    cycles: number;
    prefills: number;
    decodeSteps: number;
    peakActive: number;
    peakQueued: number;
  };
  kvCache: {
    totalBlocks: number;
    usedBlocks: number;
    utilization: number;
    sharedBlocks: number;
    totalMemoryBytes: number;
    usedMemoryBytes: number;
  };
};
