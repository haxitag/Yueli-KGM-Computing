/**
 * Continuous Batching — KGM 控制面多请求调度核
 *
 * 职责：在进程内对多路请求做排队、准入与并发执行调度。
 * - 生产路径：注入真实 `CompletionExecutor`（通常委托 NativeServingBackend / managed worker）
 * - 仿真路径：仅当显式使用 `createSimulatedTokenExecutor`（冷启动/benchmark），不可作线上 SLA
 *
 * 真正的 token 级 continuous decode 批算在 `JsReferenceNativeServingBackend` 调度环内完成；
 * 本模块负责「多请求响应」的准入与并发编排。
 */

import { EventEmitter } from "node:events";
import type { CompletionOptions, CompletionResult } from "../llm/client.js";

export type BatchRequestStatus =
  | "waiting"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type BatchJob = {
  id: string;
  prompt: string;
  options?: CompletionOptions;
  priority: number;
  receivedAt: number;
  startedAt?: number;
  completedAt?: number;
  status: BatchRequestStatus;
  resolve: (result: CompletionResult) => void;
  reject: (error: Error) => void;
};

export type CompletionExecutor = (job: {
  id: string;
  prompt: string;
  options?: CompletionOptions;
  signal?: AbortSignal;
}) => Promise<CompletionResult>;

export type BatchSchedulerConfig = {
  /** 最大同时执行的请求数（多请求并发上限） */
  maxConcurrency: number;
  /** 排队等待的最大请求数 */
  maxQueueLength: number;
  /** 兼容旧名：等同 maxConcurrency */
  maxBatchSize?: number;
  /** 兼容旧字段（毫秒）；>0 时短请求可等待凑批再放行 */
  maxWaitingTime?: number;
  /** 兼容旧字段，忽略语义保留 */
  prefillPriority?: boolean;
  dynamicSplitting?: boolean;
};

export type BatchSchedulerStats = {
  totalSubmitted: number;
  totalCompleted: number;
  totalFailed: number;
  totalCancelled: number;
  peakConcurrency: number;
  peakQueue: number;
  avgLatencyMs: number;
  throughputRequestsPerSec: number;
};

/**
 * 多请求并发调度器：队列 + 有界并发 + 可取消。
 */
export class ContinuousBatchingScheduler extends EventEmitter {
  private queue: BatchJob[] = [];
  private active = new Map<string, BatchJob>();
  private config: Required<
    Pick<BatchSchedulerConfig, "maxConcurrency" | "maxQueueLength" | "maxWaitingTime">
  >;
  private executor: CompletionExecutor;
  private stats: BatchSchedulerStats = {
    totalSubmitted: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalCancelled: 0,
    peakConcurrency: 0,
    peakQueue: 0,
    avgLatencyMs: 0,
    throughputRequestsPerSec: 0,
  };
  private latencySumMs = 0;
  private startedAt = Date.now();
  private drainTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private abortControllers = new Map<string, AbortController>();

  constructor(
    config: Partial<BatchSchedulerConfig> = {},
    executor?: CompletionExecutor,
  ) {
    super();
    const maxConcurrency = Math.max(
      1,
      config.maxConcurrency ?? config.maxBatchSize ?? 8,
    );
    this.config = {
      maxConcurrency,
      maxQueueLength: Math.max(1, config.maxQueueLength ?? 100),
      maxWaitingTime: Math.max(0, config.maxWaitingTime ?? 0),
    };
    this.executor = executor ?? createSimulatedTokenExecutor();
  }

  /** 注入生产执行器（托管 worker / native backend） */
  setExecutor(executor: CompletionExecutor): void {
    this.executor = executor;
  }

  updateConfig(config: Partial<BatchSchedulerConfig>): void {
    if (config.maxConcurrency !== undefined || config.maxBatchSize !== undefined) {
      this.config.maxConcurrency = Math.max(
        1,
        config.maxConcurrency ?? config.maxBatchSize ?? this.config.maxConcurrency,
      );
    }
    if (config.maxQueueLength !== undefined) {
      this.config.maxQueueLength = Math.max(1, config.maxQueueLength);
    }
    if (config.maxWaitingTime !== undefined) {
      this.config.maxWaitingTime = Math.max(0, config.maxWaitingTime);
    }
    this.emit("configUpdated", { ...this.config });
    this.scheduleDrain();
  }

  /**
   * 提交请求；多路并发时由调度器在 maxConcurrency 内并行执行 executor。
   */
  submit(
    prompt: string,
    options?: CompletionOptions,
    extras?: { priority?: number; id?: string },
  ): Promise<CompletionResult> {
    return new Promise<CompletionResult>((resolve, reject) => {
      if (this.queue.length >= this.config.maxQueueLength) {
        reject(new Error(`batch_scheduler_queue_full:${this.config.maxQueueLength}`));
        return;
      }

      const id =
        extras?.id?.trim() ||
        options?.requestId?.trim() ||
        `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const job: BatchJob = {
        id,
        prompt,
        options,
        priority: extras?.priority ?? 0,
        receivedAt: Date.now(),
        status: "waiting",
        resolve,
        reject,
      };

      const insertIndex = this.queue.findIndex((item) => item.priority < job.priority);
      if (insertIndex === -1) {
        this.queue.push(job);
      } else {
        this.queue.splice(insertIndex, 0, job);
      }

      this.stats.totalSubmitted += 1;
      this.stats.peakQueue = Math.max(this.stats.peakQueue, this.queue.length);
      this.emit("requestQueued", { id, queueLength: this.queue.length });
      this.scheduleDrain();
    });
  }

  /** 兼容旧 API：submit + callback 风格 */
  async submitWithCallback(
    params: {
      id?: string;
      prompt: string;
      maxTokens?: number;
      temperature?: number;
      priority?: number;
      callback: (token: string, isLast: boolean) => void;
    },
  ): Promise<string> {
    const id = params.id ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    void this.submit(
      params.prompt,
      {
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      },
      { id, priority: params.priority },
    )
      .then((result) => {
        params.callback(result.text, true);
      })
      .catch((error: Error) => {
        params.callback(`error:${error.message}`, true);
      });
    return id;
  }

  cancel(requestId: string): boolean {
    const queueIndex = this.queue.findIndex((item) => item.id === requestId);
    if (queueIndex !== -1) {
      const [job] = this.queue.splice(queueIndex, 1);
      if (job) {
        job.status = "cancelled";
        this.stats.totalCancelled += 1;
        job.reject(new Error(`batch_scheduler_cancelled:${requestId}`));
        this.emit("requestCancelled", { id: requestId, from: "queue" });
      }
      return true;
    }

    const active = this.active.get(requestId);
    if (active) {
      active.status = "cancelled";
      this.abortControllers.get(requestId)?.abort();
      this.emit("requestCancelled", { id: requestId, from: "active" });
      return true;
    }
    return false;
  }

  getStats(): BatchSchedulerStats & {
    queueLength: number;
    activeRequests: number;
  } {
    const elapsedSec = Math.max(0.001, (Date.now() - this.startedAt) / 1000);
    return {
      ...this.stats,
      throughputRequestsPerSec: this.stats.totalCompleted / elapsedSec,
      queueLength: this.queue.length,
      activeRequests: this.active.size,
    };
  }

  getQueueStatus(): {
    waiting: number;
    running: number;
    total: number;
    maxConcurrency: number;
  } {
    return {
      waiting: this.queue.length,
      running: this.active.size,
      total: this.queue.length + this.active.size,
      maxConcurrency: this.config.maxConcurrency,
    };
  }

  /** 兼容旧 getQueueStatus 字段名 */
  getQueueStatusLegacy(): {
    waiting: number;
    prefilling: number;
    generating: number;
    total: number;
  } {
    const status = this.getQueueStatus();
    return {
      waiting: status.waiting,
      prefilling: 0,
      generating: status.running,
      total: status.total,
    };
  }

  stop(): void {
    this.running = false;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    for (const job of this.queue.splice(0)) {
      job.status = "cancelled";
      this.stats.totalCancelled += 1;
      job.reject(new Error("batch_scheduler_stopped"));
    }
    for (const id of this.abortControllers.keys()) {
      this.abortControllers.get(id)?.abort();
    }
    this.emit("stopped");
  }

  private scheduleDrain(): void {
    if (this.drainTimer) {
      return;
    }
    const waitMs = this.shouldWaitToCoalesce() ? this.config.maxWaitingTime : 0;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drain();
    }, waitMs);
  }

  private shouldWaitToCoalesce(): boolean {
    if (this.config.maxWaitingTime <= 0) {
      return false;
    }
    if (this.active.size > 0) {
      return false;
    }
    if (this.queue.length === 0 || this.queue.length >= this.config.maxConcurrency) {
      return false;
    }
    const oldest = this.queue[0];
    if (!oldest) {
      return false;
    }
    return Date.now() - oldest.receivedAt < this.config.maxWaitingTime;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.scheduleDrain();
      return;
    }
    this.running = true;
    try {
      while (this.active.size < this.config.maxConcurrency && this.queue.length > 0) {
        if (this.shouldWaitToCoalesce()) {
          break;
        }
        const job = this.queue.shift();
        if (!job) {
          break;
        }
        void this.runJob(job);
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0 && this.active.size < this.config.maxConcurrency) {
        this.scheduleDrain();
      }
    }
  }

  private async runJob(job: BatchJob): Promise<void> {
    job.status = "running";
    job.startedAt = Date.now();
    this.active.set(job.id, job);
    this.stats.peakConcurrency = Math.max(this.stats.peakConcurrency, this.active.size);
    this.emit("requestStarted", { id: job.id, active: this.active.size });

    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);

    try {
      const result = await this.executor({
        id: job.id,
        prompt: job.prompt,
        options: job.options,
        signal: controller.signal,
      });
      // cancel() 会 abort controller 并改写 status；以 abort 为准避免 TS 窄化
      if (controller.signal.aborted || this.active.get(job.id)?.status === "cancelled") {
        job.status = "cancelled";
        this.stats.totalCancelled += 1;
        job.reject(new Error(`batch_scheduler_cancelled:${job.id}`));
        return;
      }
      job.status = "completed";
      job.completedAt = Date.now();
      const latency = job.completedAt - job.receivedAt;
      this.stats.totalCompleted += 1;
      this.latencySumMs += latency;
      this.stats.avgLatencyMs = this.latencySumMs / this.stats.totalCompleted;
      job.resolve(result);
      this.emit("requestCompleted", { id: job.id, latencyMs: latency });
    } catch (error) {
      if (controller.signal.aborted) {
        job.status = "cancelled";
        this.stats.totalCancelled += 1;
        job.reject(new Error(`batch_scheduler_cancelled:${job.id}`));
        return;
      }
      job.status = "failed";
      this.stats.totalFailed += 1;
      const err = error instanceof Error ? error : new Error(String(error));
      job.reject(err);
      this.emit("requestFailed", { id: job.id, error: err.message });
    } finally {
      this.active.delete(job.id);
      this.abortControllers.delete(job.id);
      this.scheduleDrain();
    }
  }
}

/** 冷启动 / benchmark 用仿真执行器（不可作生产吞吐承诺） */
export function createSimulatedTokenExecutor(options?: {
  tokensPerRequest?: number;
  delayMsPerToken?: number;
}): CompletionExecutor {
  const tokensPerRequest = Math.max(1, options?.tokensPerRequest ?? 8);
  const delayMsPerToken = Math.max(0, options?.delayMsPerToken ?? 2);
  return async (job) => {
    const maxTokens = Math.max(1, job.options?.maxTokens ?? tokensPerRequest);
    const parts: string[] = [];
    for (let i = 0; i < maxTokens; i += 1) {
      if (job.signal?.aborted) {
        throw new Error("batch_scheduler_aborted");
      }
      if (delayMsPerToken > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMsPerToken));
      }
      parts.push(` t${i}`);
    }
    return {
      text: parts.join("").trim(),
      raw: {
        simulated: true,
        requestId: job.id,
        tokens: maxTokens,
      },
    };
  };
}

/** @deprecated 旧全局单例仍使用仿真 executor；生产请自建并 setExecutor */
export const globalContinuousBatching = new ContinuousBatchingScheduler(
  { maxConcurrency: 8, maxQueueLength: 100 },
  createSimulatedTokenExecutor(),
);

/** 计算本次 tick 可准入的 prefill 数量（供 native 调度复用/单测） */
export function computeAdmitLimit(params: {
  activeCount: number;
  pendingCount: number;
  maxBatchSize: number;
  maxPrefillsPerTick: number;
}): number {
  const capacity = Math.max(0, params.maxBatchSize - params.activeCount);
  return Math.min(params.maxPrefillsPerTick, capacity, params.pendingCount);
}
