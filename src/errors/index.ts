/**
 * 结构化错误处理系统
 * 为生产级推理引擎提供完善的错误分类、处理和恢复机制
 */

export interface IErrorMetadata {
  /** 错误代码 */
  code: string;
  /** 错误描述 */
  description: string;
  /** 建议恢复操作 */
  recovery?: string;
  /** 是否可重试 */
  retryable: boolean;
  /** 重试等待时间（毫秒） */
  retryDelay?: number;
  /** 严重级别 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 相关模块 */
  module?: string;
  /** 额外上下文 */
  context?: Record<string, unknown>;
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium', 
  HIGH = 'high',
  CRITICAL = 'critical'
}

export enum ErrorCategory {
  INFERENCE = 'inference',
  MEMORY = 'memory',
  GRAPH = 'graph',
  SCHEDULER = 'scheduler',
  NETWORK = 'network',
  AUTH = 'auth',
  VALIDATION = 'validation',
  CONFIG = 'config',
  RESOURCE = 'resource',
  UNKNOWN = 'unknown'
}

export class KgError extends Error {
  public readonly metadata: IErrorMetadata;
  public readonly timestamp: Date;
  public readonly category: ErrorCategory;

  constructor(
    message: string,
    metadata: Partial<IErrorMetadata> & { code: string },
    category: ErrorCategory = ErrorCategory.UNKNOWN
  ) {
    super(message);
    
    // 设置原型链
    Object.setPrototypeOf(this, KgError.prototype);
    
    this.name = 'KgError';
    this.category = category;
    this.timestamp = new Date();
    
    // 完善metadata
    this.metadata = {
      code: metadata.code,
      description: metadata.description || message,
      recovery: metadata.recovery,
      retryable: metadata.retryable ?? true,
      retryDelay: metadata.retryDelay,
      severity: metadata.severity || ErrorSeverity.MEDIUM,
      module: metadata.module,
      context: metadata.context,
    };
  }
  
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      stack: this.stack,
      metadata: this.metadata,
      timestamp: this.timestamp.toISOString(),
      category: this.category,
    };
  }
  
  toString(): string {
    return `[${this.metadata.code}] ${this.message} (${this.category})`;
  }
}

// === 特定错误类型 ===

export class InferenceError extends KgError {
  constructor(
    message: string,
    metadata: Partial<IErrorMetadata> & { code: string }
  ) {
    super(message, {
      ...metadata,
      module: 'inference',
    }, ErrorCategory.INFERENCE);
    this.name = 'InferenceError';
  }
}

export class MemoryError extends KgError {
  constructor(
    message: string,
    metadata: Partial<IErrorMetadata> & { code: string }
  ) {
    super(message, {
      ...metadata,
      module: 'memory',
    }, ErrorCategory.MEMORY);
    this.name = 'MemoryError';
  }
}

export class GraphError extends KgError {
  constructor(
    message: string,
    metadata: Partial<IErrorMetadata> & { code: string }
  ) {
    super(message, {
      ...metadata,
      module: 'graph',
    }, ErrorCategory.GRAPH);
    this.name = 'GraphError';
  }
}

export class NetworkError extends KgError {
  constructor(
    message: string,
    metadata: Partial<IErrorMetadata> & { code: string }
  ) {
    super(message, {
      ...metadata,
      module: 'network',
      retryable: metadata.retryable ?? true,
    }, ErrorCategory.NETWORK);
    this.name = 'NetworkError';
  }
}

export class ResourceError extends KgError {
  constructor(
    message: string,
    metadata: Partial<IErrorMetadata> & { code: string }
  ) {
    super(message, {
      ...metadata,
      module: 'resource',
      retryable: metadata.retryable ?? false,
    }, ErrorCategory.RESOURCE);
    this.name = 'ResourceError';
  }
}

export class ValidationError extends KgError {
  constructor(
    message: string,
    metadata: Partial<IErrorMetadata> & { code: string }
  ) {
    super(message, {
      ...metadata,
      module: 'validation',
      retryable: metadata.retryable ?? false,
    }, ErrorCategory.VALIDATION);
    this.name = 'ValidationError';
  }
}

// === 标准错误定义 ===

export const STANDARD_ERRORS = {
  // 推理错误
  INFERENCE_TIMEOUT: {
    code: 'INF001',
    description: '推理请求超时',
    retryable: true,
    severity: 'medium',
    recovery: '增加超时时间或重试',
  },
  INFERENCE_FAILED: {
    code: 'INF002',
    description: '推理执行失败',
    retryable: true,
    severity: 'high',
    recovery: '检查模型配置或更换模型',
  },
  INFERENCE_CAPACITY_EXCEEDED: {
    code: 'INF003',
    description: '推理容量超出限制',
    retryable: true,
    severity: 'high',
    retryDelay: 5000,
    recovery: '等待容量释放或增加资源配置',
  },
  
  // 内存错误
  MEMORY_OVERFLOW: {
    code: 'MEM001',
    description: '内存溢出',
    retryable: false,
    severity: 'critical',
    recovery: '增加内存或优化内存使用',
  },
  MEMORY_FRAGMENTATION: {
    code: 'MEM002',
    description: '内存碎片化严重',
    retryable: false,
    severity: 'high',
    recovery: '重启服务或优化内存分配策略',
  },
  
  // 网络错误
  NETWORK_TIMEOUT: {
    code: 'NET001',
    description: '网络连接超时',
    retryable: true,
    severity: 'medium',
    retryDelay: 2000,
    recovery: '检查网络连接或重试',
  },
  NETWORK_UNREACHABLE: {
    code: 'NET002',
    description: '网络不可达',
    retryable: true,
    severity: 'high',
    retryDelay: 5000,
    recovery: '检查网络配置或等待网络恢复',
  },
  
  // 资源错误
  RESOURCE_EXHAUSTED: {
    code: 'RES001',
    description: '资源耗尽',
    retryable: false,
    severity: 'critical',
    recovery: '增加资源配置或优化资源使用',
  },
  GPU_OOM: {
    code: 'RES002',
    description: 'GPU内存溢出',
    retryable: false,
    severity: 'critical',
    recovery: '减少批次大小或使用更大的GPU',
  },
  
  // 验证错误
  INVALID_INPUT: {
    code: 'VAL001',
    description: '输入验证失败',
    retryable: false,
    severity: 'low',
    recovery: '检查输入数据格式和要求',
  },
  SCHEMA_VIOLATION: {
    code: 'VAL002',
    description: '数据模式违反',
    retryable: false,
    severity: 'medium',
    recovery: '检查数据结构和约束条件',
  },
};

// === 错误工具函数 ===

export function createError(
  errorDefinition: typeof STANDARD_ERRORS[keyof typeof STANDARD_ERRORS] & { 
    message?: string 
  },
  category: ErrorCategory = ErrorCategory.UNKNOWN,
  context?: Record<string, unknown>
): KgError {
  const message = errorDefinition.message || errorDefinition.description;
  
  return new KgError(message, {
    code: errorDefinition.code,
    description: errorDefinition.description,
    recovery: errorDefinition.recovery,
    retryable: errorDefinition.retryable,
    retryDelay: errorDefinition.retryDelay,
    severity: errorDefinition.severity as any,
    context,
  }, category);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof KgError) {
    return error.metadata.retryable;
  }
  
  // 根据错误类型判断
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();
    
    const retryablePatterns = [
      'timeout',
      'network',
      'temporary',
      'busy',
      'retry',
      'rate limit',
      'throttling',
      'connection',
    ];
    
    return retryablePatterns.some(pattern => 
      message.includes(pattern) || name.includes(pattern)
    );
  }
  
  return false;
}

export function getErrorSeverity(error: unknown): ErrorSeverity {
  if (error instanceof KgError) {
    return error.metadata.severity as ErrorSeverity;
  }
  
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    if (message.includes('fatal') || message.includes('critical')) {
      return ErrorSeverity.CRITICAL;
    } else if (message.includes('error') || message.includes('failed')) {
      return ErrorSeverity.HIGH;
    } else if (message.includes('warning') || message.includes('unavailable')) {
      return ErrorSeverity.MEDIUM;
    }
  }
  
  return ErrorSeverity.LOW;
}

export function formatErrorForLogging(error: unknown): Record<string, unknown> {
  if (error instanceof KgError) {
    return error.toJSON();
  }
  
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      severity: getErrorSeverity(error),
      timestamp: new Date().toISOString(),
    };
  }
  
  return {
    message: String(error),
    severity: ErrorSeverity.MEDIUM,
    timestamp: new Date().toISOString(),
  };
}