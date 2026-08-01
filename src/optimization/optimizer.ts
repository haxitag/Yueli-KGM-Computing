/**
 * 性能优化集成模块
 * 统一管理和配置所有性能优化组件
 * 借鉴Shimmy的高性能策略，为Yueli-KGM-Computing提供性能加速
 */

import { ResponseCache, StreamingResponseCache } from "./responseCache.js";
import { StreamBatchProcessor, optimizeStream } from "../utils/streamOptimizer.js";
import { MemoryManager } from "../utils/memoryPool.js";
import { ConnectionPoolManager } from "../utils/connectionPool.js";
import type { CompletionResult, CompletionStreamEvent, CompletionOptions } from "../llm/client.js";

export interface OptimizerConfig {
  /** 是否启用响应缓存 */
  enableResponseCache: boolean;
  /** 缓存配置 */
  cacheConfig: {
    maxSize: number;
    defaultTTL: number;
  };
  /** 是否启用流式优化 */
  enableStreamOptimization: boolean;
  /** 流式优化配置 */
  streamConfig: {
    batchInterval: number;
    maxBatchSize: number;
    minBatchSize: number;
  };
  /** 是否启用连接池 */
  enableConnectionPool: boolean;
  /** 连接池配置 */
  connectionConfig: {
    maxConnections: number;
    idleTimeout: number;
    keepAlive: boolean;
  };
  /** 是否启用内存池 */
  enableMemoryPool: boolean;
  /** 内存池配置 */
  memoryConfig: {
    bufferPoolSize: number;
    preallocate: number;
  };
}

export const DefaultOptimizerConfig: OptimizerConfig = {
  enableResponseCache: true,
  cacheConfig: {
    maxSize: 500,
    defaultTTL: 30 * 60 * 1000, // 30分钟
  },
  enableStreamOptimization: true,
  streamConfig: {
    batchInterval: 16, // 约60fps
    maxBatchSize: 50,
    minBatchSize: 5,
  },
  enableConnectionPool: true,
  connectionConfig: {
    maxConnections: 50,
    idleTimeout: 60000,
    keepAlive: true,
  },
  enableMemoryPool: true,
  memoryConfig: {
    bufferPoolSize: 20,
    preallocate: 10,
  },
};

/**
 * 性能优化管理器
 * 统一管理缓存、流式优化、连接池和内存池
 */
export class Optimizer {
  private config: OptimizerConfig;
  private responseCache?: ResponseCache<CompletionResult>;
  private streamCache?: StreamingResponseCache;
  private connectionPool?: ConnectionPoolManager;
  private memoryManager: MemoryManager;
  private isEnabled: boolean;

  constructor(config: Partial<OptimizerConfig> = {}) {
    this.config = { ...DefaultOptimizerConfig, ...config };
    this.isEnabled = true;
    this.memoryManager = new MemoryManager();

    this.initializeComponents();
  }

  private initializeComponents(): void {
    // 初始化响应缓存
    if (this.config.enableResponseCache) {
      this.responseCache = new ResponseCache<CompletionResult>({
        maxSize: this.config.cacheConfig.maxSize,
        defaultTTL: this.config.cacheConfig.defaultTTL,
        staleWhileRevalidate: true,
      });
    }

    // 初始化流式缓存
    if (this.config.enableStreamOptimization) {
      this.streamCache = new StreamingResponseCache();
    }

    // 初始化连接池
    if (this.config.enableConnectionPool) {
      this.connectionPool = new ConnectionPoolManager({
        maxConnections: this.config.connectionConfig.maxConnections,
        idleTimeout: this.config.connectionConfig.idleTimeout,
        keepAlive: this.config.connectionConfig.keepAlive,
      });
    }
  }

  /**
   * 优化完成请求 - 检查缓存并包装响应
   */
  async optimizeComplete(
    prompt: string,
    options: CompletionOptions | undefined,
    execute: (prompt: string, options?: CompletionOptions) => Promise<CompletionResult>
  ): Promise<CompletionResult> {
    if (!this.isEnabled || !this.responseCache) {
      return execute(prompt, options);
    }

    // 检查缓存（排除流式请求和随机性请求）
    if (!options?.signal && options?.seed === undefined) {
      const cacheKey = this.responseCache.generateKey(prompt, options);
      const cached = this.responseCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // 执行请求
    const result = await execute(prompt, options);

    // 缓存结果
    if (this.responseCache && !options?.signal && options?.seed === undefined) {
      const cacheKey = this.responseCache.generateKey(prompt, options);
      this.responseCache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * 优化流式请求 - 应用批处理和背压控制
   */
  async *optimizeStream(
    prompt: string,
    options: CompletionOptions | undefined,
    execute: (prompt: string, options?: CompletionOptions) => AsyncIterable<CompletionStreamEvent>
  ): AsyncIterable<CompletionStreamEvent> {
    if (!this.isEnabled || !this.config.enableStreamOptimization) {
      yield* execute(prompt, options);
      return;
    }

    const processor = new StreamBatchProcessor({
      batchInterval: this.config.streamConfig.batchInterval,
      maxBatchSize: this.config.streamConfig.maxBatchSize,
      minBatchSize: this.config.streamConfig.minBatchSize,
    });

    for await (const event of execute(prompt, options)) {
      if (event.type === "token") {
        const optimized = processor.pushToken(event.text, event.index, event.tokenId);
        if (optimized) {
          yield {
            type: "token",
            text: optimized.text,
            index: optimized.index,
            tokenId: optimized.tokenId,
          };
        }
      } else {
        // 非token事件（started/finished），先刷新缓冲区
        const flush = processor.flush();
        if (flush && flush.type === "token") {
          yield {
            type: "token",
            text: flush.text,
            index: flush.index,
            tokenId: flush.tokenId,
          };
        }
        yield event;
      }
    }

    // 最后刷新
    const final = processor.flush();
    if (final && final.type === "token") {
      yield {
        type: "token",
        text: final.text,
        index: final.index,
        tokenId: final.tokenId,
      };
    }
  }

  /**
   * 获取HTTP Agent（连接池管理）
   */
  getHttpAgent(baseUrl: string): { agent: unknown; release: () => void } {
    if (!this.connectionPool) {
      return { agent: undefined, release: () => {} };
    }

    const connection = this.connectionPool.getConnection(baseUrl);
    return {
      agent: connection.agent,
      release: () => {
        this.connectionPool?.releaseConnection(baseUrl);
      },
    };
  }

  /**
   * 获取内存管理器
   */
  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }

  /**
   * 获取性能统计
   */
  getStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {
      enabled: this.isEnabled,
    };

    if (this.responseCache) {
      stats.cache = this.responseCache.getStats();
    }

    if (this.connectionPool) {
      stats.connections = this.connectionPool.getStats();
    }

    stats.memory = this.memoryManager.getStats();

    return stats;
  }

  /**
   * 启用/禁用优化
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  /**
   * 清空所有缓存
   */
  clearCache(): void {
    this.responseCache?.clear();
    this.streamCache?.endStream("all");
  }

  /**
   * 定期清理任务
   */
  startMaintenance(): void {
    // 每5分钟清理过期缓存
    setInterval(() => {
      this.responseCache?.purgeExpired();
    }, 5 * 60 * 1000);
  }

  /**
   * 销毁优化器
   */
  destroy(): void {
    this.responseCache?.clear();
    this.connectionPool?.destroy();
    this.memoryManager.cleanup();
  }
}

// 全局单例
let globalOptimizer: Optimizer | null = null;

export function getOptimizer(config?: Partial<OptimizerConfig>): Optimizer {
  if (!globalOptimizer) {
    globalOptimizer = new Optimizer(config);
    globalOptimizer.startMaintenance();
  }
  return globalOptimizer;
}

export function resetOptimizer(): void {
  if (globalOptimizer) {
    globalOptimizer.destroy();
    globalOptimizer = null;
  }
}
