import type { CompletionOptions, CompletionResult } from "../llm/client.js";
import type { KvBlock } from "./types.js";

/**
 * 请求状态
 */
export enum RequestState {
  PENDING = "pending",
  PREFILLING = "prefilling",
  DECODING = "decoding",
  COMPLETED = "completed",
  PREEMPTED = "preempted",
  ERROR = "error",
}

/**
 * 推理请求
 */
export type InferenceRequest = {
  id: string;
  prompt: string;
  options?: CompletionOptions;
  state: RequestState;
  tokensProcessed: number;
  priority: number;
  enqueuedAt: number;
  resolve: (result: CompletionResult) => void;
  reject: (error: Error) => void;
  kvBlocks: KvBlock[];
  contextHash?: string;
  preemptedBy?: string;
  error?: Error;
};

/**
 * 批次执行结果
 */
export type BatchExecuteResult = {
  id: string;
  token?: string;
  finished: boolean;
  kvBlocks?: KvBlock[];
};

/**
 * 连续批处理调度器
 */
export class ContinuousBatchScheduler {
  private batch = new Map<string, InferenceRequest>();
  private queue: InferenceRequest[] = [];
  private maxBatchSize: number;
  private maxQueueSize: number;
  private isRunning = false;
  private preemptionThreshold: number;
  private minRequestTokens: number;
  private stats: BatchSchedulerStats = {
    totalRequests: 0,
    completedRequests: 0,
    preemptedRequests: 0,
    avgLatencyMs: 0,
    avgThroughputTokensPerSec: 0,
    totalTokensProcessed: 0,
    avgQueueWaitMs: 0,
  };
  private executionBackend?: {
    prefillBatch(requests: InferenceRequest[]): Promise<void>;
    decodeBatch(requests: InferenceRequest[]): Promise<BatchExecuteResult[]>;
  };

  constructor(options: {
    maxBatchSize?: number;
    maxQueueSize?: number;
    preemptionThreshold?: number;
    minRequestTokens?: number;
  } = {}) {
    this.maxBatchSize = options.maxBatchSize ?? 8;
    this.maxQueueSize = options.maxQueueSize ?? 64;
    this.preemptionThreshold = options.preemptionThreshold ?? 100;
    this.minRequestTokens = options.minRequestTokens ?? 20;
  }

  /**
   * 设置执行后端
   */
  setExecutionBackend(backend: {
    prefillBatch(requests: InferenceRequest[]): Promise<void>;
    decodeBatch(requests: InferenceRequest[]): Promise<BatchExecuteResult[]>;
  }): void {
    this.executionBackend = backend;
  }

  /**
   * 提交推理请求
   */
  async submit(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    return new Promise((resolve, reject) => {
      const request: InferenceRequest = {
        id: this.generateId(),
        prompt,
        options,
        state: RequestState.PENDING,
        tokensProcessed: 0,
        priority: this.computePriority(prompt, options),
        enqueuedAt: Date.now(),
        resolve,
        reject,
        kvBlocks: [],
      };

      if (this.queue.length >= this.maxQueueSize) {
        reject(new Error(`queue_full: ${this.maxQueueSize}`));
        return;
      }

      this.stats.totalRequests++;
      this.queue.push(request);
      this.sortQueue();
    });
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleLoop().catch((error) => {
      console.error("Scheduler loop error:", error);
      this.isRunning = false;
    });
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * 获取统计信息
   */
  getStats(): BatchSchedulerStats {
    return { ...this.stats };
  }

  /**
   * 调度循环
   */
  private async scheduleLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.scheduleTick();
      } catch (error) {
        console.error("Schedule tick error:", error);
        await this.delay(10);
      }
    }
  }

  /**
   * 单次调度tick
   */
  private async scheduleTick(): Promise<void> {
    // 1. 尝试从队列中添加新请求到批次
    this.fillBatch();

    // 2. 如果批次为空,等待
    if (this.batch.size === 0) {
      await this.delay(10);
      return;
    }

    // 3. 执行批次推理
    await this.executeBatch();

    // 4. 清理完成的请求
    this.cleanupCompletedRequests();
  }

  /**
   * 填充批次
   */
  private fillBatch(): void {
    while (this.batch.size < this.maxBatchSize && this.queue.length > 0) {
      const request = this.queue.shift();

      if (!request) break;

      // 检查是否需要抢占
      if (this.batch.size >= this.maxBatchSize) {
        this.preemptLongestRequest();
      }

      request.state = RequestState.PREFILLING;
      this.batch.set(request.id, request);

      // 更新队列等待时间
      const queueWaitMs = Date.now() - request.enqueuedAt;
      this.updateQueueWaitStats(queueWaitMs);
    }
  }

  /**
   * 抢占最长请求
   */
  private preemptLongestRequest(): boolean {
    let longestId: string | null = null;
    let maxTokens = this.minRequestTokens;

    for (const [id, req] of this.batch) {
      if (req.state === RequestState.DECODING && req.tokensProcessed > maxTokens) {
        maxTokens = req.tokensProcessed;
        longestId = id;
      }
    }

    if (longestId) {
      const request = this.batch.get(longestId);
      if (request) {
        request.state = RequestState.PREEMPTED;
        request.preemptedBy = "scheduler";
        // 放回队列,降低优先级
        request.priority += 1000;
        request.kvBlocks = []; // 清空KV块,重新处理
        this.queue.push(request);
        this.sortQueue();
        this.batch.delete(longestId);
        this.stats.preemptedRequests++;
        return true;
      }
    }

    return false;
  }

  /**
   * 执行批次推理
   */
  private async executeBatch(): Promise<void> {
    if (!this.executionBackend) {
      throw new Error("execution_backend_not_set");
    }

    const requests = Array.from(this.batch.values());

    // 将批次分为prefill和decode
    const prefills = requests.filter((r) => r.state === RequestState.PREFILLING);
    const decodes = requests.filter((r) => r.state === RequestState.DECODING);

    // 1. 执行prefill
    if (prefills.length > 0) {
      try {
        await this.executionBackend.prefillBatch(prefills);
        // Prefill完成后,转入decode状态
        for (const req of prefills) {
          req.state = RequestState.DECODING;
        }
      } catch (error) {
        // Prefill失败,标记为错误
        for (const req of prefills) {
          req.state = RequestState.ERROR;
          req.error = error instanceof Error ? error : new Error(String(error));
          req.reject(req.error);
        }
        return;
      }
    }

    // 2. 执行decode (多轮)
    if (decodes.length === 0) return;

    const maxDecodeSteps = 512;
    for (let step = 0; step < maxDecodeSteps; step++) {
      const decodeRequests = Array.from(this.batch.values()).filter((r) => r.state === RequestState.DECODING);

      if (decodeRequests.length === 0) break;

      try {
        const results = await this.executionBackend.decodeBatch(decodeRequests);

        // 处理结果
        for (let i = 0; i < decodeRequests.length; i++) {
          const request = decodeRequests[i];
          const result = results[i];

          request.tokensProcessed++;
          this.stats.totalTokensProcessed++;

          // 检查是否完成
          const maxTokens = request.options?.maxTokens ?? 512;
          if (result.finished || request.tokensProcessed >= maxTokens) {
            request.state = RequestState.COMPLETED;

            const completionResult: CompletionResult = {
              text: this.buildResultText(request, result),
              raw: {
                requestId: request.id,
                tokensProcessed: request.tokensProcessed,
                kvBlocks: result.kvBlocks,
              },
            };

            request.resolve(completionResult);
            this.stats.completedRequests++;
          }
        }
      } catch (error) {
        // Decode失败,标记为错误
        for (const req of decodeRequests) {
          req.state = RequestState.ERROR;
          req.error = error instanceof Error ? error : new Error(String(error));
          req.reject(req.error);
        }
        break;
      }
    }
  }

  /**
   * 清理完成的请求
   */
  private cleanupCompletedRequests(): void {
    for (const [id, request] of this.batch) {
      if (request.state === RequestState.COMPLETED || request.state === RequestState.ERROR) {
        const latency = Date.now() - request.enqueuedAt;
        this.updateLatencyStats(latency);
        this.batch.delete(id);
      }
    }
  }

  /**
   * 计算请求优先级 (LIFO)
   */
  private computePriority(prompt: string, options?: CompletionOptions): number {
    // 短prompt优先
    const estimatedTokens = this.estimateTokens(prompt);
    // 最大tokens越小,优先级越高
    const maxTokens = options?.maxTokens ?? 512;
    return estimatedTokens + maxTokens;
  }

  /**
   * 估算token数量
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * 更新延迟统计
   */
  private updateLatencyStats(latencyMs: number): void {
    const count = this.stats.completedRequests;
    if (count <= 1) {
      this.stats.avgLatencyMs = latencyMs;
    } else {
      this.stats.avgLatencyMs = this.stats.avgLatencyMs + (latencyMs - this.stats.avgLatencyMs) / count;
    }

    // 更新吞吐量
    if (latencyMs > 0) {
      const throughput = this.stats.totalTokensProcessed / (latencyMs / 1000);
      this.stats.avgThroughputTokensPerSec =
        this.stats.avgThroughputTokensPerSec + (throughput - this.stats.avgThroughputTokensPerSec) / count;
    }
  }

  /**
   * 更新队列等待统计
   */
  private updateQueueWaitStats(queueWaitMs: number): void {
    const count = this.stats.totalRequests;
    if (count <= 1) {
      this.stats.avgQueueWaitMs = queueWaitMs;
    } else {
      this.stats.avgQueueWaitMs = this.stats.avgQueueWaitMs + (queueWaitMs - this.stats.avgQueueWaitMs) / count;
    }
  }

  /**
   * 排序队列 (LIFO: 短请求优先)
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 构建结果文本
   */
  private buildResultText(request: InferenceRequest, result: BatchExecuteResult): string {
    // 这里应该累积所有decode步骤的token
    // 简化实现,返回空字符串
    return "";
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * 调度器统计
 */
export type BatchSchedulerStats = {
  totalRequests: number;
  completedRequests: number;
  preemptedRequests: number;
  avgLatencyMs: number;
  avgThroughputTokensPerSec: number;
  totalTokensProcessed: number;
  avgQueueWaitMs: number;
};
