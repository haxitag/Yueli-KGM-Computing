/**
 * 流式处理优化器
 * 借鉴Shimmy的批量处理和背压控制策略
 * 减少事件循环压力和网络往返
 */

export interface StreamOptimizerConfig {
  /** 批处理间隔（毫秒） */
  batchInterval: number;
  /** 最大批处理大小 */
  maxBatchSize: number;
  /** 最小批处理大小（达到此数量立即发送） */
  minBatchSize: number;
  /** 背压阈值 */
  backpressureThreshold: number;
  /** 是否启用智能合并 */
  enableSmartMerge: boolean;
}

export interface OptimizedStreamEvent {
  type: "token" | "flush" | "error";
  text: string;
  index: number;
  tokenId?: number;
  isBatch?: boolean;
}

/**
 * 流式数据批处理器
 * 合并多个token减少事件触发频率
 */
export class StreamBatchProcessor {
  private buffer: string[] = [];
  private bufferIndices: number[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private config: StreamOptimizerConfig;
  private isProcessing = false;

  constructor(config: Partial<StreamOptimizerConfig> = {}) {
    this.config = {
      batchInterval: config.batchInterval ?? 16, // 约60fps
      maxBatchSize: config.maxBatchSize ?? 50,
      minBatchSize: config.minBatchSize ?? 5,
      backpressureThreshold: config.backpressureThreshold ?? 100,
      enableSmartMerge: config.enableSmartMerge ?? true,
    };
  }

  /**
   * 处理单个token
   */
  pushToken(text: string, index: number, tokenId?: number): OptimizedStreamEvent | null {
    if (!this.config.enableSmartMerge) {
      return { type: "token", text, index, tokenId };
    }

    this.buffer.push(text);
    this.bufferIndices.push(index);

    // 达到最小批处理大小，立即发送
    if (this.buffer.length >= this.config.minBatchSize) {
      return this.flush();
    }

    // 启动定时器
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
      }, this.config.batchInterval);
    }

    // 达到最大批处理大小，立即刷新
    if (this.buffer.length >= this.config.maxBatchSize) {
      return this.flush();
    }

    return null;
  }

  /**
   * 强制刷新缓冲区
   */
  flush(): OptimizedStreamEvent | null {
    if (this.buffer.length === 0) return null;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const text = this.buffer.join("");
    const index = this.bufferIndices[0] ?? 0;
    const isBatch = this.buffer.length > 1;

    this.buffer = [];
    this.bufferIndices = [];

    return {
      type: "token",
      text,
      index,
      isBatch,
    };
  }

  /**
   * 生成完成事件
   */
  finalize(): OptimizedStreamEvent {
    const finalFlush = this.flush();
    if (finalFlush) {
      return finalFlush;
    }
    return { type: "flush", text: "", index: -1 };
  }

  /**
   * 获取当前缓冲区大小
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}

/**
 * 异步流式优化器
 * 使用生成器模式优化异步流处理
 */
export async function* optimizeStream<T>(
  source: AsyncIterable<T>,
  config: Partial<StreamOptimizerConfig> = {}
): AsyncGenerator<T | T[]> {
  const processor = new StreamBatchProcessor(config);
  const batch: T[] = [];
  let lastYield = Date.now();

  for await (const item of source) {
    batch.push(item);

    const now = Date.now();
    const timeSinceLastYield = now - lastYield;

    // 时间窗口或大小窗口触发
    if (batch.length >= (config.maxBatchSize ?? 10) || timeSinceLastYield >= (config.batchInterval ?? 50)) {
      if (batch.length === 1) {
        yield batch[0];
      } else {
        yield [...batch];
      }
      batch.length = 0;
      lastYield = now;
    }
  }

  // 处理剩余数据
  if (batch.length > 0) {
    if (batch.length === 1) {
      yield batch[0];
    } else {
      yield [...batch];
    }
  }
}

/**
 * 背压感知流
 * 监控消费速度，自动调整生产速度
 */
export class BackpressureAwareStream<T> {
  private queue: T[] = [];
  private consumers = 0;
  private maxQueueSize: number;
  private isPaused = false;
  private resumeCallbacks: (() => void)[] = [];

  constructor(maxQueueSize: number = 100) {
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * 添加数据到队列
   */
  async push(item: T): Promise<boolean> {
    if (this.queue.length >= this.maxQueueSize) {
      // 背压触发，等待消费
      this.isPaused = true;
      await new Promise<void>((resolve) => {
        this.resumeCallbacks.push(resolve);
      });
    }

    this.queue.push(item);

    // 通知消费者
    if (this.resumeCallbacks.length > 0) {
      const callback = this.resumeCallbacks.shift();
      callback?.();
    }

    return !this.isPaused;
  }

  /**
   * 消费数据
   */
  async *consume(): AsyncGenerator<T> {
    this.consumers++;
    try {
      while (true) {
        if (this.queue.length > 0) {
          const item = this.queue.shift();
          if (item !== undefined) {
            // 解除背压
            if (this.queue.length < this.maxQueueSize * 0.8 && this.isPaused) {
              this.isPaused = false;
              const callback = this.resumeCallbacks.shift();
              callback?.();
            }
            yield item;
          }
        } else {
          // 队列为空，短暂等待
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    } finally {
      this.consumers--;
    }
  }

  /**
   * 获取队列状态
   */
  getStatus(): { queueSize: number; isPaused: boolean; consumers: number } {
    return {
      queueSize: this.queue.length,
      isPaused: this.isPaused,
      consumers: this.consumers,
    };
  }
}
