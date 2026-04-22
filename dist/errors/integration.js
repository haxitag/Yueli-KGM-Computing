/**
 * 错误处理系统集成模块
 * 提供与现有系统集成的工具函数和装饰器
 */
import { KgError, isRetryableError, ErrorSeverity, STANDARD_ERRORS } from './index.js';
import { RetryManagerFactory } from './recovery.js';
/**
 * 全局错误处理器
 */
export class GlobalErrorHandler {
    static instance;
    retryManagers = new Map();
    errorMonitor;
    constructor() { }
    static getInstance() {
        if (!GlobalErrorHandler.instance) {
            GlobalErrorHandler.instance = new GlobalErrorHandler();
        }
        return GlobalErrorHandler.instance;
    }
    setErrorMonitor(monitor) {
        this.errorMonitor = monitor;
    }
    getRetryManager(service) {
        if (!this.retryManagers.has(service)) {
            this.retryManagers.set(service, RetryManagerFactory.createStandardRetryManager(service));
        }
        return this.retryManagers.get(service);
    }
    /**
     * 安全的异步执行包装器
     */
    async safeExecute(fn, options = {}) {
        const startTime = Date.now();
        let recoveryTime;
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
        }
        catch (error) {
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
                    options.onRecovery?.(fallbackResult, error);
                    return fallbackResult;
                }
                catch (fallbackError) {
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
    async safeExecuteBatch(items, processor, options = {}) {
        const results = [];
        for (let i = 0; i < items.length; i++) {
            try {
                const result = await this.safeExecute(() => processor(items[i], i), options);
                results.push(result);
            }
            catch (error) {
                results.push(undefined);
                options.onItemError?.(items[i], i, error);
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
    withErrorBoundary(fn, options = {}) {
        return async (...args) => {
            return this.safeExecute(() => fn(...args), options);
        };
    }
    /**
     * 记录恢复成功
     */
    recordRecovery(error, recoveryTime, service) {
        if (this.errorMonitor) {
            const errorId = error instanceof Error ? error.name : 'unknown';
            this.errorMonitor.recordRecovery(errorId, recoveryTime, { service });
        }
    }
    /**
     * 记录错误
     */
    recordError(error, context) {
        if (this.errorMonitor) {
            this.errorMonitor.recordError(error, context);
        }
    }
    /**
     * 包装错误
     */
    wrapError(error, options) {
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
            }
            else if (message.includes('timeout')) {
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
        return new KgError(error instanceof Error ? error.message : String(error), {
            code: 'UNKNOWN_ERROR',
            description: '未知错误',
            retryable: false,
            severity: ErrorSeverity.HIGH,
            context: options.context,
        });
    }
}
/**
 * 装饰器工厂：为方法添加错误处理
 */
export function withErrorHandling(options = {}) {
    return function (target, propertyKey, descriptor) {
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args) {
            const instanceName = target.constructor.name;
            const handler = GlobalErrorHandler.getInstance();
            return handler.safeExecute(() => originalMethod.apply(this, args), {
                ...options,
                service: options.service || instanceName,
                context: {
                    ...options.context,
                    method: String(propertyKey),
                    className: instanceName,
                },
            });
        };
        return descriptor;
    };
}
/**
 * 错误处理中间件（Express风格）
 */
export function errorHandlerMiddleware(options = {}) {
    const handler = GlobalErrorHandler.getInstance();
    return async (error, req, res, next) => {
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
        }
        else {
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
function getStatusCodeFromError(error) {
    const severity = error.metadata.severity;
    const code = error.metadata.code;
    if (code.startsWith('VAL')) {
        return 400; // 验证错误
    }
    else if (code.startsWith('AUTH')) {
        return 401; // 认证错误
    }
    else if (code.startsWith('FORBIDDEN')) {
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
    safe(promise, options) {
        const handler = GlobalErrorHandler.getInstance();
        return new Promise(async (resolve) => {
            try {
                const result = await promise;
                resolve(result);
            }
            catch (error) {
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
    retry(fn, options = {}) {
        const handler = GlobalErrorHandler.getInstance();
        return handler.getRetryManager('utils').executeWithRetry(fn, {
            context: 'retry',
            onRetry: options.onRetry,
        });
    },
    /**
     * 创建标准错误
     */
    createError(type, message, context) {
        const definition = STANDARD_ERRORS[type];
        return new KgError(message || definition.description, {
            code: definition.code,
            description: definition.description,
            retryable: definition.retryable,
            severity: definition.severity,
            recovery: definition.recovery,
            context,
        });
    },
    /**
     * 验证并抛出错误
     */
    assert(condition, error, context) {
        if (!condition) {
            if (typeof error === 'string') {
                throw this.createError('INVALID_INPUT', error, context);
            }
            else {
                throw error;
            }
        }
    },
};
/**
 * 导出全局实例
 */
export const globalErrorHandler = GlobalErrorHandler.getInstance();
