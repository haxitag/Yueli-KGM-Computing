/**
 * 先进的错误恢复和重试系统
 * 提供智能重试、降级策略和故障恢复机制
 */

import { KgError, isRetryableError, ErrorSeverity } from './index.js';

export interface RetryConfig {
  /** 最大重试次数 */
  maxAttempts: number;
  /** 基础退避时间（毫秒） */
  baseDelay: number;
  /** 最大退避时间（毫秒） */
  maxDelay: number;
  /** 退避策略：fixed|linear|exponential|jitter */
  strategy: 'fixed' | 'linear' | 'exponential' | 'jitter';
  /** 退避系数（指数策略使用） */
  factor?: number;
  /** 是否启用断路器模式 */
  circuitBreaker?: boolean;
  /** 断路器开启阈值 */
  failureThreshold?: number;
  /** 断路器半开超时（毫秒） */
  resetTimeout?: number;
}

export interface RecoveryStrategy {
  /** 降级函数列表，按优先级顺序 */
  fallbackFunctions: Array<(...args: any[]) => Promise<any>>;
  /** 启用自动降级 */
  enableAutoFallback: boolean;
  /** 启用断路器 */
  enableCircuitBreaker: boolean;
  /** 错误过滤器：返回false时不进行重试 */
  errorFilter?: (error: unknown) => boolean;
}

export interface RetryStats {
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  totalRetryTime: number;
  avgRetryDelay: number;
  circuitBreakerState: 'closed' | 'open' | 'half_open';
  lastFailure?: {
    timestamp: Date;
    error: string;
  };
}

/**
 * 断路器状态机
 */
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half_open' = 'closed';
  private failureCount = 0;
  private lastFailureTime?: Date;
  private successCount = 0;

  constructor(
    private readonly config: {
      failureThreshold: number;
      resetTimeout: number;
      halfOpenSuccessThreshold: number;
    }
  ) {}

  canExecute(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      const now = new Date();
      const timeSinceFailure = this.lastFailureTime 
        ? now.getTime() - this.lastFailureTime.getTime() 
        : Infinity;
      
      if (timeSinceFailure > this.config.resetTimeout) {
        this.state = 'half_open';
        return true;
      }
      
      return false;
    }

    if (this.state === 'half_open') {
      return true;
    }

    return false;
  }

  onSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenSuccessThreshold) {
        this.reset();
      }
    } else {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.state === 'half_open') {
      this.state = 'open';
      this.successCount = 0;
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
  }

  getState(): typeof this.state {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/**
 * 智能重试管理器
 */
export class RetryManager {
  private circuitBreaker?: CircuitBreaker;
  private stats: RetryStats = {
    totalAttempts: 0,
    successfulAttempts: 0,
    failedAttempts: 0,
    totalRetryTime: 0,
    avgRetryDelay: 0,
    circuitBreakerState: 'closed',
  };

  constructor(
    private readonly config: RetryConfig = {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      strategy: 'exponential',
      factor: 2,
      circuitBreaker: true,
      failureThreshold: 5,
      resetTimeout: 60000,
    }
  ) {
    if (config.circuitBreaker) {
      this.circuitBreaker = new CircuitBreaker({
        failureThreshold: config.failureThreshold || 5,
        resetTimeout: config.resetTimeout || 60000,
        halfOpenSuccessThreshold: 2,
      });
    }
  }

  private calculateDelay(attempt: number): number {
    const base = this.config.baseDelay;
    
    switch (this.config.strategy) {
      case 'fixed':
        return base;
        
      case 'linear':
        return base * attempt;
        
      case 'exponential': {
        const factor = this.config.factor || 2;
        const delay = base * Math.pow(factor, attempt - 1);
        return Math.min(delay, this.config.maxDelay);
      }
        
      case 'jitter': {
        const delay = this.calculateDelay(attempt);
        const jitter = delay * 0.3 * Math.random();
        const finalDelay = delay + jitter;
        return Math.min(finalDelay, this.config.maxDelay);
      }
        
      default:
        return base;
    }
  }

  private async delay(ms: number): Promise<void> {
    this.stats.totalRetryTime += ms;
    this.stats.avgRetryDelay = this.stats.totalRetryTime / this.stats.totalAttempts;
    
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 执行带重试的函数
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    options?: {
      context?: string;
      shouldRetry?: (error: unknown) => boolean;
      onRetry?: (attempt: number, error: unknown, delay: number) => void;
      onFailed?: (finalError: unknown, attempts: number) => void;
    }
  ): Promise<T> {
    const context = options?.context || 'unknown';
    
    // 检查断路器
    if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
      throw new KgError(`断路器开启，拒绝执行: ${context}`, {
        code: 'CIRCUIT_BREAKER_OPEN',
        description: `断路器处于开启状态，拒绝执行 ${context}`,
        retryable: false,
        severity: ErrorSeverity.HIGH,
        recovery: '等待断路器恢复或检查后端服务',
      });
    }

    let lastError: unknown;
    let attempt = 1;

    while (attempt <= this.config.maxAttempts) {
      try {
        this.stats.totalAttempts++;
        
        const result = await fn();
        
        this.stats.successfulAttempts++;
        if (this.circuitBreaker) {
          this.circuitBreaker.onSuccess();
          this.stats.circuitBreakerState = this.circuitBreaker.getState();
        }
        
        return result;
      } catch (error) {
        lastError = error;
        attempt++;
        
        // 更新失败统计
        this.stats.failedAttempts++;
        if (this.circuitBreaker) {
          this.circuitBreaker.onFailure();
          this.stats.circuitBreakerState = this.circuitBreaker.getState();
          this.stats.lastFailure = {
            timestamp: new Date(),
            error: error instanceof Error ? error.message : String(error),
          };
        }

        // 检查是否需要重试
        const shouldRetry = options?.shouldRetry?.(error) ?? isRetryableError(error);
        
        if (attempt > this.config.maxAttempts || !shouldRetry) {
          break;
        }

        // 计算退避时间
        const delay = this.calculateDelay(attempt - 1);
        
        // 调用重试回调
        options?.onRetry?.(attempt - 1, error, delay);
        
        // 等待并重试
        await this.delay(delay);
      }
    }

    // 所有重试都失败
    const finalError = lastError instanceof Error 
      ? lastError 
      : new Error(String(lastError));
    
    // 调用失败回调
    options?.onFailed?.(finalError, attempt - 1);
    
    // 如果是我们的错误类型，直接抛出，否则包装
    if (finalError instanceof KgError) {
      throw finalError;
    }
    
    throw new KgError(`操作失败: ${context}`, {
      code: 'OPERATION_FAILED',
      description: `在 ${attempt - 1} 次尝试后，${context} 操作失败`,
      retryable: false,
      severity: ErrorSeverity.HIGH,
      context: {
        originalError: finalError.message,
        attempts: attempt - 1,
      },
    });
  }

  /**
   * 执行带降级策略的函数
   */
  async executeWithFallback<T>(
    primaryFn: () => Promise<T>,
    fallbackFns: Array<() => Promise<T>>,
    options?: {
      context?: string;
      onFallback?: (level: number, error: unknown) => void;
    }
  ): Promise<T> {
    const fns = [primaryFn, ...fallbackFns];
    
    for (let i = 0; i < fns.length; i++) {
      try {
        const result = await this.executeWithRetry(fns[i], {
          context: `${options?.context || 'operation'} (level ${i})`,
        });
        
        // 如果使用了降级，记录日志
        if (i > 0) {
          options?.onFallback?.(i, undefined);
        }
        
        return result;
      } catch (error) {
        // 如果是最后一个降级函数也失败了
        if (i === fns.length - 1) {
          throw error;
        }
        
        // 切换到下一个降级函数
        options?.onFallback?.(i, error);
      }
    }
    
    // 理论上不会执行到这里，但为了类型安全
    throw new KgError('所有降级策略均失败', {
      code: 'ALL_FALLBACKS_FAILED',
      description: `${options?.context || '操作'} 的所有降级策略均失败`,
      retryable: false,
      severity: ErrorSeverity.CRITICAL,
    });
  }

  /**
   * 执行批量带重试
   */
  async executeBatchWithRetry<T>(
    items: T[],
    processor: (item: T, index: number) => Promise<void>,
    options?: {
      maxConcurrent?: number;
      onItemSuccess?: (item: T, index: number) => void;
      onItemError?: (item: T, index: number, error: unknown) => void;
    }
  ): Promise<void> {
    const maxConcurrent = options?.maxConcurrent || 5;
    const queue: Array<{item: T; index: number}> = [];
    
    // 填充队列
    for (let i = 0; i < items.length; i++) {
      queue.push({ item: items[i], index: i });
    }

    const workers: Promise<void>[] = [];
    
    for (let i = 0; i < maxConcurrent; i++) {
      const worker = async () => {
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) break;
          
          try {
            await this.executeWithRetry(
              () => processor(task.item, task.index),
              { context: `Batch processing item ${task.index}` }
            );
            
            options?.onItemSuccess?.(task.item, task.index);
          } catch (error) {
            options?.onItemError?.(task.item, task.index, error);
          }
        }
      };
      
      workers.push(worker());
    }
    
    await Promise.all(workers);
  }

  getStats(): RetryStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalAttempts: 0,
      successfulAttempts: 0,
      failedAttempts: 0,
      totalRetryTime: 0,
      avgRetryDelay: 0,
      circuitBreakerState: this.stats.circuitBreakerState,
    };
  }

  getCircuitBreakerMetrics() {
    return this.circuitBreaker?.getMetrics() || null;
  }
}

/**
 * 预配置的重试管理器工厂
 */
export class RetryManagerFactory {
  private static managers = new Map<string, RetryManager>();

  static createStandardRetryManager(name: string): RetryManager {
    if (this.managers.has(name)) {
      return this.managers.get(name)!;
    }

    const configs: Record<string, RetryConfig> = {
      inference: {
        maxAttempts: 3,
        baseDelay: 2000,
        maxDelay: 30000,
        strategy: 'exponential',
        factor: 2,
        circuitBreaker: true,
        failureThreshold: 3,
        resetTimeout: 30000,
      },
      network: {
        maxAttempts: 5,
        baseDelay: 1000,
        maxDelay: 60000,
        strategy: 'exponential',
        factor: 3,
        circuitBreaker: true,
        failureThreshold: 5,
        resetTimeout: 60000,
      },
      database: {
        maxAttempts: 3,
        baseDelay: 3000,
        maxDelay: 45000,
        strategy: 'jitter',
        factor: 2,
        circuitBreaker: true,
        failureThreshold: 2,
        resetTimeout: 30000,
      },
      api: {
        maxAttempts: 3,
        baseDelay: 1500,
        maxDelay: 20000,
        strategy: 'linear',
        factor: 2,
        circuitBreaker: true,
        failureThreshold: 4,
        resetTimeout: 45000,
      },
    };

    const config = configs[name] || configs.inference;
    const manager = new RetryManager(config);
    this.managers.set(name, manager);
    
    return manager;
  }

  static getRetryManager(name: string): RetryManager | undefined {
    return this.managers.get(name);
  }
}