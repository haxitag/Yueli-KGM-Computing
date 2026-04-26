/**
 * Continuous Batching - 持续批处理
 * 借鉴 vLLM 的核心优化，动态合并请求以最大化 GPU 利用率
 */

import { EventEmitter } from "node:events";

interface BatchRequest {
  id: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  priority: number;
  receivedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  tokensGenerated: number;
  status: "waiting" | "prefilling" | "generating" | "completed" | "cancelled";
  callback: (token: string, isLast: boolean) => void;
}

interface BatchConfig {
  maxBatchSize: number;
  maxWaitingTime: number; // 最大等待时间 (ms)
  maxQueueLength: number;
  prefillPriority: boolean; // 优先完成 prefill
  dynamicSplitting: boolean; // 动态拆分长请求
}

interface BatchStats {
  totalBatches: number;
  avgBatchSize: number;
  avgLatency: number;
  throughput: number; // tokens/sec
  gpuUtilization: number;
}

/**
 * Continuous Batching Scheduler
 * 核心思想：当一个请求在生成 token 时，其他请求可以加入 batch
 */
export class ContinuousBatchingScheduler extends EventEmitter {
  private queue: BatchRequest[] = [];
  private activeRequests: Map<string, BatchRequest> = new Map();
  private config: BatchConfig;
  private stats: BatchStats = {
    totalBatches: 0,
    avgBatchSize: 0,
    avgLatency: 0,
    throughput: 0,
    gpuUtilization: 0,
  };
  private isRunning = false;
  private batchLoopTimer?: NodeJS.Timeout;
  private tokensGenerated = 0;
  private startTime = Date.now();

  constructor(config: Partial<BatchConfig> = {}) {
    super();
    this.config = {
      maxBatchSize: config.maxBatchSize ?? 8,
      maxWaitingTime: config.maxWaitingTime ?? 100, // 100ms 等待窗口
      maxQueueLength: config.maxQueueLength ?? 100,
      prefillPriority: config.prefillPriority ?? true,
      dynamicSplitting: config.dynamicSplitting ?? true,
    };
  }

  /**
   * 提交请求到批处理队列
   */
  async submit(
    params: Omit<BatchRequest, "id" | "receivedAt" | "tokensGenerated" | "status"> & {
      id?: string;
    }
  ): Promise<string> {
    if (this.queue.length >= this.config.maxQueueLength) {
      throw new Error("Queue full");
    }

    const id = params.id ?? `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const request: BatchRequest = {
      ...params,
      id,
      receivedAt: Date.now(),
      tokensGenerated: 0,
      status: "waiting",
    };

    // 优先级插入
    const insertIndex = this.queue.findIndex((r) => r.priority < request.priority);
    if (insertIndex === -1) {
      this.queue.push(request);
    } else {
      this.queue.splice(insertIndex, 0, request);
    }

    this.emit("requestQueued", { id, queueLength: this.queue.length });

    // 触发批处理
    if (!this.isRunning) {
      this.startBatching();
    }

    return id;
  }

  /**
   * 取消请求
   */
  cancel(requestId: string): boolean {
    // 从队列中移除
    const queueIndex = this.queue.findIndex((r) => r.id === requestId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      this.emit("requestCancelled", { id: requestId, from: "queue" });
      return true;
    }

    // 标记活跃请求为取消
    const active = this.activeRequests.get(requestId);
    if (active) {
      active.status = "cancelled";
      this.emit("requestCancelled", { id: requestId, from: "active" });
      return true;
    }

    return false;
  }

  /**
   * 启动批处理循环
   */
  private startBatching(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTime = Date.now();

    this.emit("batchingStarted");

    const batchLoop = async () => {
      if (!this.isRunning) return;

      try {
        await this.processBatch();
      } catch (error) {
        this.emit("batchError", error);
      }

      // 继续循环
      if (this.queue.length > 0 || this.activeRequests.size > 0) {
        this.batchLoopTimer = setTimeout(batchLoop, 10); // 10ms 间隔
      } else {
        this.isRunning = false;
        this.emit("batchingStopped");
      }
    };

    batchLoop();
  }

  /**
   * 处理一个批次的请求
   */
  private async processBatch(): Promise<void> {
    const now = Date.now();

    // 1. 收集可以加入 batch 的请求
    const newRequests: BatchRequest[] = [];
    const remainingQueue: BatchRequest[] = [];

    for (const request of this.queue) {
      // 检查是否可以加入当前 batch
      if (
        this.activeRequests.size + newRequests.length < this.config.maxBatchSize &&
        (now - request.receivedAt >= this.config.maxWaitingTime ||
          this.queue.length > this.config.maxBatchSize)
      ) {
        newRequests.push(request);
      } else {
        remainingQueue.push(request);
      }
    }

    this.queue = remainingQueue;

    // 2. 将新请求加入 active batch
    for (const request of newRequests) {
      request.status = "prefilling";
      this.activeRequests.set(request.id, request);
      this.emit("requestStarted", { id: request.id });
    }

    if (this.activeRequests.size === 0) return;

    // 3. 执行 batch 推理
    // 这里模拟实际的 batch 推理过程
    await this.executeBatch(Array.from(this.activeRequests.values()));

    // 4. 清理完成的请求
    for (const [id, request] of this.activeRequests) {
      if (request.status === "completed" || request.status === "cancelled") {
        this.activeRequests.delete(id);
        if (request.status === "completed") {
          request.completedAt = Date.now();
          this.emit("requestCompleted", {
            id,
            tokensGenerated: request.tokensGenerated,
            latency: request.completedAt - request.receivedAt,
          });
        }
      }
    }

    // 5. 更新统计
    this.updateStats(newRequests.length);
  }

  /**
   * 执行 batch 推理
   */
  private async executeBatch(requests: BatchRequest[]): Promise<void> {
    // 这里实现实际的 batch 推理逻辑
    // 简化为每个请求生成一个 token

    const batchSize = requests.length;
    this.stats.totalBatches++;

    // 并行生成 token
    const generationPromises = requests.map(async (request) => {
      if (request.status === "cancelled") return;

      // 模拟 token 生成延迟
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 生成 token
      const token = this.generateToken(request);
      request.tokensGenerated++;

      // 状态转换
      if (request.status === "prefilling") {
        request.status = "generating";
        request.firstTokenAt = Date.now();
      }

      // 检查是否完成
      const isComplete =
        request.tokensGenerated >= request.maxTokens || token === "<|endoftext|>";

      // 回调
      request.callback(token, isComplete);

      if (isComplete) {
        request.status = "completed";
      }

      this.tokensGenerated++;
    });

    await Promise.all(generationPromises);

    this.emit("batchExecuted", {
      size: batchSize,
      activeRequests: this.activeRequests.size,
    });
  }

  /**
   * 生成单个 token (模拟)
   */
  private generateToken(request: BatchRequest): string {
    // 实际实现会调用模型
    // 这里简化返回随机 token
    const tokens = [" the", " a", " is", " of", " and", " to", " in", "<|endoftext|>"];
    const weights = [0.3, 0.2, 0.15, 0.15, 0.1, 0.05, 0.04, 0.01];

    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < tokens.length; i++) {
      cumulative += weights[i];
      if (rand <= cumulative) {
        return tokens[i];
      }
    }
    return tokens[0];
  }

  /**
   * 动态拆分长请求
   */
  private splitLongRequest(request: BatchRequest): BatchRequest[] {
    if (!this.config.dynamicSplitting) return [request];

    const promptLength = request.prompt.length;
    const avgChunkSize = 2048; // tokens

    if (promptLength <= avgChunkSize * 4) return [request];

    // 拆分成多个子请求
    const chunks: string[] = [];
    const words = request.prompt.split(" ");
    let currentChunk: string[] = [];

    for (const word of words) {
      if (currentChunk.join(" ").length > avgChunkSize) {
        chunks.push(currentChunk.join(" "));
        currentChunk = [];
      }
      currentChunk.push(word);
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(" "));
    }

    // 只创建第一个 chunk 的请求，后续 chunk 链式处理
    return [
      {
        ...request,
        prompt: chunks[0] + "\n[Continued...]",
        maxTokens: Math.min(request.maxTokens, 512), // 减少每 chunk 的 token 数
      },
    ];
  }

  /**
   * 更新统计
   */
  private updateStats(batchSize: number): void {
    const n = this.stats.totalBatches;
    this.stats.avgBatchSize =
      (this.stats.avgBatchSize * (n - 1) + batchSize) / n;

    // 计算吞吐量
    const elapsed = (Date.now() - this.startTime) / 1000;
    this.stats.throughput = this.tokensGenerated / elapsed;

    // 估算 GPU 利用率
    this.stats.gpuUtilization = Math.min(
      100,
      (this.activeRequests.size / this.config.maxBatchSize) * 100
    );
  }

  /**
   * 获取统计信息
   */
  getStats(): BatchStats & {
    queueLength: number;
    activeRequests: number;
    totalTokens: number;
  } {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      activeRequests: this.activeRequests.size,
      totalTokens: this.tokensGenerated,
    };
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): {
    waiting: number;
    prefilling: number;
    generating: number;
    total: number;
  } {
    const waiting = this.queue.length;
    let prefilling = 0;
    let generating = 0;

    for (const req of this.activeRequests.values()) {
      if (req.status === "prefilling") prefilling++;
      if (req.status === "generating") generating++;
    }

    return {
      waiting,
      prefilling,
      generating,
      total: waiting + prefilling + generating,
    };
  }

  /**
   * 调整配置
   */
  updateConfig(config: Partial<BatchConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit("configUpdated", this.config);
  }

  /**
   * 停止批处理
   */
  stop(): void {
    this.isRunning = false;
    if (this.batchLoopTimer) {
      clearTimeout(this.batchLoopTimer);
    }

    // 取消所有请求
    for (const request of this.queue) {
      request.status = "cancelled";
    }
    for (const request of this.activeRequests.values()) {
      request.status = "cancelled";
    }

    this.queue = [];
    this.activeRequests.clear();
    this.emit("stopped");
  }
}

// 全局单例
export const globalContinuousBatching = new ContinuousBatchingScheduler();
