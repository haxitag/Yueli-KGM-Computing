/**
 * 错误处理系统集成模块
 * 提供与现有系统集成的工具函数和装饰器
 */

import { KgError, isRetryableError, ErrorSeverity, STANDARD_ERRORS } from './index.js';
import { RetryManager, RetryManagerFactory } from './recovery.js';
import { ErrorMonitor } from './monitoring.js';

/**
 * 错误处理选项
 */
export interface ErrorHandlingOptions {
  /** 是否重试 */
  retry?: boolean;
  /** 重试次数 */
  retryCount?: number;
  /** 降级函数 */
  fallback?: (...args: any[]) => Promise<any>;
  /** 上下文信息 */
  context?: Record<string, unknown>;
  /** 服务名称 */
  service?: string;
  /** 记录错误 */
  logError?: boolean;
  /** 抛出原始错误（不包装） */
  throwRaw?: boolean;
  /** 恢复回调 */
  onRecovery?: (result: any, error?: Error) => void;
}

/**
 * 全局错误处理器
 */
export class GlobalErrorHandler {
  private static instance: GlobalErrorHandler;
  private retryManagers = new Map<string, RetryManager>();
  private errorMonitor?: ErrorMonitor;
  
  private constructor() {}
  
  static getInstance(): GlobalErrorHandler {
    if (!GlobalErrorHandler.instance) {
      GlobalErrorHandler.instance = new GlobalErrorHandler();
    }
    return GlobalErrorHandler.instance;
  }
  
  setErrorMonitor(monitor: ErrorMonitor): void {
    this.errorMonitor = monitor;
  }
  
  getRetryManager(service: string): RetryManager {
    if (!this.retryManagers.has(service)) {
      this.retryManagers.set(service, RetryManagerFactory.createStandardRetryManager(service));
    }
    return this.retryManagers.get(service)!;
  }
  
  /**
   * 安全的异步执行包装器
   */
  async safeExecute<T>(
    fn: () => Promise<T>,
    options: ErrorHandlingOptions = {}
  ): Promise<T> {
    const startTime = Date.now();
    let recoveryTime: number | undefined;
    
    try {
      if (options.retry && options.retryCount && options.retryCount > 0) {
        const service = options.service || 'unknown';
        const manager = this.getRetryManager(service);
        
        const result = await manager.executeWithRetry(fn, {
          context: options.service,
          shouldRetry: isRetryableError,
          onRetry: (attempt, error, delay) => {
            this.recordError(error, {
              service: options.service,
              context: { ...options.context, attempt, delay, retry: true },
            });
          },
          onFailed: (error, attempts) => {
            recoveryTime = Date.now() - startTime;
            this.recordRecovery(error, recoveryTime, options.service);
          },
        });
        
        return result;
      }
      
      const result = await fn();
      return result;
    } catch (error) {
      recoveryTime = Date.now() - startTime;
      this.recordRecovery(error, recoveryTime, options.service);
      
      // 记录错误
      this.recordError(error, {
        service: options.service,
        context: options.context,
      });
      
      // 如果提供了降级函数
      if (options.fallback) {
        try {
          const fallbackResult = await options.fallback();
          options.onRecovery?.(fallbackResult, error as Error);
          return fallbackResult as T;
        } catch (fallbackError) {
          // 降级也失败
          this.recordError(fallbackError, {
            service: options.service,
            context: { ...options.context, isFallback: true },
          });
          
          throw this.wrapError(fallbackError, options);
        }
      }
      
      throw this.wrapError(error, options);
    }
  }
  
  /**
   * 批量安全执行
   */
  async safeExecuteBatch<T, R>(
    items: T[],
    processor: (item: T, index: number) => Promise<R>,
    options: ErrorHandlingOptions & {
      continueOnError?: boolean;
      onItemError?: (item: T, index: number, error: Error) => void;
    } = {}
  ): Promise<Array<R | undefined>> {
    const results: Array<R | undefined> = [];
    
    for (let i = 0; i < items.length; i++) {
      try {
        const result = await this.safeExecute(
          () => processor(items[i], i),
          options
        );
        results.push(result);
      } catch (error) {
        results.push(undefined);
        
        options.onItemError?.(items[i], i, error as Error);
        
        if (!options.continueOnError) {
          throw error;
        }
      }
    }
    
    return results;
  }
  
  /**
   * 错误边界（React风格的错误捕获）
   */
  withErrorBoundary<TArgs extends any[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: ErrorHandlingOptions = {}
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      return this.safeExecute(() => fn(...args), options);
    };
  }
  
  /**
   * 记录恢复成功
   */
  private recordRecovery(
    error: unknown,
    recoveryTime: number,
    service?: string
  ): void {
    if (this.errorMonitor) {
      const errorId = error instanceof Error ? error.name : 'unknown';
      this.errorMonitor.recordRecovery(errorId, recoveryTime, { service });
    }
  }
  
  /**
   * 记录错误
   */
  private recordError(
    error: unknown,
    context?: {
      service?: string;
      context?: Record<string, unknown>;
    }
  ): void {
    if (this.errorMonitor) {
      this.errorMonitor.recordError(error, context);
    }
  }
  
  /**
   * 包装错误
   */
  private wrapError(error: unknown, options: ErrorHandlingOptions): Error {
    if (options.throwRaw && error instanceof Error) {
      return error;
    }
    
    if (error instanceof KgError) {
      return error;
    }
    
    // 标准化错误类型
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      
      if (message.includes('network') || message.includes('connection')) {
        return new KgError(error.message, {
          code: 'NETWORK_ERROR',
          description: '网络连接错误',
          retryable: true,
          severity: ErrorSeverity.MEDIUM,
          context: options.context,
        });
      } else if (message.includes('timeout')) {
        return new KgError(error.message, {
          code: 'TIMEOUT_ERROR',
          description: '操作超时',
          retryable: true,
          severity: ErrorSeverity.MEDIUM,
          context: options.context,
        });
      }
    }
    
    // 默认包装
    return new KgError(
      error instanceof Error ? error.message : String(error),
      {
        code: 'UNKNOWN_ERROR',
        description: '未知错误',
        retryable: false,
        severity: ErrorSeverity.HIGH,
        context: options.context,
      }
    );
  }
}

/**
 * 装饰器工厂：为方法添加错误处理
 */
export function withErrorHandling(
  options: ErrorHandlingOptions = {}
): MethodDecorator {
  return function (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const instanceName = target.constructor.name;
      const handler = GlobalErrorHandler.getInstance();
      
      return handler.safeExecute(
        () => originalMethod.apply(this, args),
        {
          ...options,
          service: options.service || instanceName,
          context: {
            ...options.context,
            method: String(propertyKey),
            className: instanceName,
          },
        }
      );
    };
    
    return descriptor;
  };
}

/**
 * 错误处理中间件（Express风格）
 */
export function errorHandlerMiddleware(
  options: ErrorHandlingOptions = {}
): (error: Error, req: any, res: any, next: any) => void {
  const handler = GlobalErrorHandler.getInstance();
  
  return async (error: Error, req: any, res: any, next: any) => {
    // 记录错误
    handler.recordError(error, {
      service: options.service || 'http',
      context: {
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      },
    });
    
    // 根据错误类型返回响应
    if (error instanceof KgError) {
      const statusCode = getStatusCodeFromError(error);
      const response = {
        success: false,
        error: {
          code: error.metadata.code,
          message: error.message,
          severity: error.metadata.severity,
          recovery: error.metadata.recovery,
        },
        timestamp: new Date().toISOString(),
      };
      
      res.status(statusCode).json(response);
    } else {
      // 未知错误类型
      const response = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          severity: 'critical',
          recovery: 'Please contact support',
        },
        timestamp: new Date().toISOString(),
      };
      
      res.status(500).json(response);
    }
  };
}

/**
 * 从错误获取HTTP状态码
 */
function getStatusCodeFromError(error: KgError): number {
  const severity = error.metadata.severity;
  const code = error.metadata.code;
  
  if (code.startsWith('VAL')) {
    return 400; // 验证错误
  } else if (code.startsWith('AUTH')) {
    return 401; // 认证错误
  } else if (code.startsWith('FORBIDDEN')) {
    return 403; // 禁止访问
  }
  
  switch (severity) {
    case 'critical':
    case 'high':
      return 500;
    case 'medium':
      return 503; // 服务不可用，可以重试
    case 'low':
      return 400;
    default:
      return 500;
  }
}

/**
 * 快速工具函数
 */
export const ErrorUtils = {
  /**
   * 安全的Promise包装
   */
  safe<T>(promise: Promise<T>, options?: {
    defaultValue?: T;
    context?: Record<string, unknown>;
    log?: boolean;
  }): Promise<T | undefined> {
    const handler = GlobalErrorHandler.getInstance();
    
    return new Promise(async (resolve) => {
      try {
        const result = await promise;
        resolve(result);
      } catch (error) {
        handler.recordError(error, {
          service: 'utils',
          context: options?.context,
        });
        
        resolve(options?.defaultValue);
      }
    });
  },
  
  /**
   * 延迟重试
   */
  retry<T>(
    fn: () => Promise<T>,
    options: {
      maxAttempts?: number;
      delay?: number;
      factor?: number;
      onRetry?: (attempt: number, error: Error) => void;
    } = {}
  ): Promise<T> {
    const handler = GlobalErrorHandler.getInstance();
    
    return handler.getRetryManager('utils').executeWithRetry(fn, {
      context: 'retry',
      onRetry: options.onRetry,
    });
  },
  
  /**
   * 创建标准错误
   */
  createError(
    type: keyof typeof STANDARD_ERRORS,
    message?: string,
    context?: Record<string, unknown>
  ): KgError {
    const definition = STANDARD_ERRORS[type];
    
    return new KgError(message || definition.description, {
      code: definition.code,
      description: definition.description,
      retryable: definition.retryable,
      severity: definition.severity as ErrorSeverity,
      recovery: definition.recovery,
      context,
    });
  },
  
  /**
   * 验证并抛出错误
   */
  assert(
    condition: any,
    error: KgError | string,
    context?: Record<string, unknown>
  ): asserts condition {
    if (!condition) {
      if (typeof error === 'string') {
        throw this.createError('INVALID_INPUT' as any, error, context);
      } else {
        throw error;
      }
    }
  },
};

/**
 * 导出全局实例
 */
export const globalErrorHandler = GlobalErrorHandler.getInstance();