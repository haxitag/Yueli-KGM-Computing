/**
 * TypeScript SDK 错误处理
 * 遵循KGM Computing SDK规范v1.0.0
 */

/**
 * KGM SDK错误基类
 */
export class KGMError extends Error {
  /** 错误代码 */
  code: string;
  /** HTTP状态码 */
  status: number;
  /** 错误详情 */
  details?: any;
  /** 请求ID */
  request_id?: string;
  /** 原始错误 */
  original_error?: Error;
  /** 错误时间戳 */
  timestamp: Date;

  constructor(
    message: string,
    options: {
      code: string;
      status?: number;
      details?: any;
      request_id?: string;
      original_error?: Error;
    }
  ) {
    super(message);
    
    this.name = 'KGMError';
    this.code = options.code;
    this.status = options.status || 500;
    this.details = options.details;
    this.request_id = options.request_id;
    this.original_error = options.original_error;
    this.timestamp = new Date();
    
    // 保持原型链
    Object.setPrototypeOf(this, KGMError.prototype);
    
    // 捕获堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, KGMError);
    }
  }

  /**
   * 转换为JSON格式
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      details: this.details,
      request_id: this.request_id,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
    };
  }

  /**
   * 转换为字符串
   */
  toString() {
    return `[${this.code}] ${this.message}`;
  }
}

/**
 * API错误基类
 */
export class APIError extends KGMError {
  constructor(
    message: string,
    options: {
      code: string;
      status: number;
      details?: any;
      request_id?: string;
      original_error?: Error;
    }
  ) {
    super(message, options);
    this.name = 'APIError';
  }
}

/**
 * 客户端错误基类
 */
export class ClientError extends KGMError {
  constructor(
    message: string,
    options: {
      code: string;
      details?: any;
      request_id?: string;
      original_error?: Error;
    }
  ) {
    super(message, {
      ...options,
      status: 400, // 客户端错误通常为400
    });
    this.name = 'ClientError';
  }
}

/**
 * 模型错误基类
 */
export class ModelError extends KGMError {
  constructor(
    message: string,
    options: {
      code: string;
      details?: any;
      request_id?: string;
      original_error?: Error;
    }
  ) {
    super(message, {
      ...options,
      status: 422, // 模型错误通常为422
    });
    this.name = 'ModelError';
  }
}

// ==================== 具体的API错误 ====================

/** 认证错误 (401) */
export class AuthenticationError extends APIError {
  constructor(
    message: string = 'Authentication failed',
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'AUTH_ERROR',
      status: 401,
      ...options,
    });
    this.name = 'AuthenticationError';
  }
}

/** 授权错误 (403) */
export class AuthorizationError extends APIError {
  constructor(
    message: string = 'Authorization failed',
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'AUTHZ_ERROR',
      status: 403,
      ...options,
    });
    this.name = 'AuthorizationError';
  }
}

/** 限流错误 (429) */
export class RateLimitError extends APIError {
  /** 重试等待时间（秒） */
  retry_after?: number;

  constructor(
    message: string = 'Rate limit exceeded',
    options: {
      retry_after?: number;
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'RATE_LIMIT_ERROR',
      status: 429,
      ...options,
    });
    this.name = 'RateLimitError';
    this.retry_after = options.retry_after;
  }
}

/** 服务器错误 (500) */
export class ServerError extends APIError {
  constructor(
    message: string = 'Internal server error',
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'SERVER_ERROR',
      status: 500,
      ...options,
    });
    this.name = 'ServerError';
  }
}

/** 服务不可用错误 (503) */
export class ServiceUnavailableError extends APIError {
  /** 服务恢复时间（毫秒） */
  retry_in?: number;

  constructor(
    message: string = 'Service unavailable',
    options: {
      retry_in?: number;
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      ...options,
    });
    this.name = 'ServiceUnavailableError';
    this.retry_in = options.retry_in;
  }
}

// ==================== 具体的客户端错误 ====================

/** 验证错误 */
export class ValidationError extends ClientError {
  /** 验证错误字段 */
  field?: string;

  constructor(
    message: string = 'Validation failed',
    options: {
      field?: string;
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'VALIDATION_ERROR',
      ...options,
    });
    this.name = 'ValidationError';
    this.field = options.field;
  }
}

/** 超时错误 */
export class TimeoutError extends ClientError {
  constructor(
    message: string = 'Request timeout',
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'TIMEOUT_ERROR',
      ...options,
    });
    this.name = 'TimeoutError';
  }
}

/** 网络错误 */
export class NetworkError extends ClientError {
  constructor(
    message: string = 'Network error',
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'NETWORK_ERROR',
      ...options,
    });
    this.name = 'NetworkError';
  }
}

/** 配置错误 */
export class ConfigurationError extends ClientError {
  constructor(
    message: string = 'Configuration error',
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'CONFIG_ERROR',
      ...options,
    });
    this.name = 'ConfigurationError';
  }
}

// ==================== 具体的模型错误 ====================

/** 模型未找到错误 */
export class ModelNotFoundError extends ModelError {
  constructor(
    model: string,
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(`Model '${model}' not found`, {
      code: 'MODEL_NOT_FOUND',
      ...options,
    });
    this.name = 'ModelNotFoundError';
  }
}

/** 模型不可用错误 */
export class ModelUnavailableError extends ModelError {
  constructor(
    model: string,
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(`Model '${model}' is unavailable`, {
      code: 'MODEL_UNAVAILABLE',
      ...options,
    });
    this.name = 'ModelUnavailableError';
  }
}

/** 推理错误 */
export class InferenceError extends ModelError {
  constructor(
    message: string = 'Inference failed',
    options: {
      details?: any;
      request_id?: string;
      original_error?: Error;
    } = {}
  ) {
    super(message, {
      code: 'INFERENCE_ERROR',
      ...options,
    });
    this.name = 'InferenceError';
  }
}

// ==================== 错误工具函数 ====================

/**
 * 根据HTTP状态码创建对应的API错误
 */
export function createErrorFromStatusCode(
  status: number,
  message: string,
  options: {
    details?: any;
    request_id?: string;
    original_error?: Error;
    retry_after?: number;
  } = {}
): APIError {
  switch (status) {
    case 400:
      return new ValidationError(message, options);
    case 401:
      return new AuthenticationError(message, options);
    case 403:
      return new AuthorizationError(message, options);
    case 404:
      return new ModelNotFoundError('unknown', { ...options, details: message });
    case 422:
      return new InferenceError(message, options);
    case 429:
      return new RateLimitError(message, { ...options, retry_after: options.retry_after });
    case 500:
      return new ServerError(message, options);
    case 503:
      return new ServiceUnavailableError(message, { ...options, retry_in: options.retry_after });
    default:
      if (status >= 400 && status < 500) {
        return new ClientError(message, { ...options, code: `CLIENT_${status}` });
      } else if (status >= 500 && status < 600) {
        return new ServerError(message, options);
      } else {
        return new APIError(message, {
          code: 'UNKNOWN_ERROR',
          status,
          ...options,
        });
      }
  }
}

/**
 * 从错误对象创建KGM错误
 */
export function createErrorFromError(
  error: Error | any,
  options: {
    code?: string;
    status?: number;
    request_id?: string;
    message?: string;
  } = {}
): KGMError {
  // 如果已经是KGM错误，直接返回
  if (error instanceof KGMError) {
    return error;
  }

  // 从原始错误中提取信息
  let message = options.message || error.message || 'Unknown error';
  let code = options.code || 'UNKNOWN_ERROR';
  let status = options.status || 500;

  // 根据错误类型推断错误类别
  if (error.name === 'TypeError' || error.name === 'RangeError') {
    code = 'VALIDATION_ERROR';
    status = 400;
  } else if (error.name === 'NetworkError' || error.message?.includes('network')) {
    code = 'NETWORK_ERROR';
    status = 400;
  } else if (error.message?.includes('timeout') || error.name === 'TimeoutError') {
    code = 'TIMEOUT_ERROR';
    status = 400;
  }

  return new KGMError(message, {
    code,
    status,
    request_id: options.request_id,
    original_error: error instanceof Error ? error : undefined,
  });
}

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error: KGMError | Error): boolean {
  if (error instanceof KGMError) {
    // 限流错误通常可重试
    if (error instanceof RateLimitError) {
      return true;
    }
    
    // 网络错误可重试
    if (error instanceof NetworkError) {
      return true;
    }
    
    // 超时错误通常可重试
    if (error instanceof TimeoutError) {
      return true;
    }
    
    // 服务不可用可重试
    if (error instanceof ServiceUnavailableError) {
      return true;
    }
    
    // 临时性服务器错误可重试
    if (error instanceof ServerError) {
      return true;
    }
    
    // 500-599的错误通常可重试
    if (error.status >= 500 && error.status < 600) {
      return true;
    }
    
    // 429错误（限流）通常可重试
    if (error.status === 429) {
      return true;
    }
  }
  
  // 非KGM错误，检查是否为网络相关的原生错误
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const retryablePatterns = [
      'network',
      'timeout',
      'connection',
      'socket',
      'temporary',
      'retry',
    ];
    
    return retryablePatterns.some(pattern => message.includes(pattern));
  }
  
  return false;
}

/**
 * 获取错误的重试延迟时间
 */
export function getRetryDelay(error: KGMError, attempt: number): number {
  // 基础延迟
  let delay = 1000; // 1秒基础延迟
  
  // 指数退避
  delay *= Math.pow(2, attempt - 1);
  
  // 根据错误类型调整
  if (error instanceof RateLimitError && error.retry_after) {
    delay = Math.max(delay, error.retry_after * 1000);
  }
  
  if (error instanceof ServiceUnavailableError && error.retry_in) {
    delay = Math.max(delay, error.retry_in);
  }
  
  // 增加随机抖动
  const jitter = delay * 0.2 * Math.random();
  delay += jitter;
  
  // 最大延迟不超过30秒
  return Math.min(delay, 30000);
}

/**
 * 错误码映射表
 */
export const ERROR_CODES = {
  // API错误
  AUTH_ERROR: '认证失败',
  AUTHZ_ERROR: '授权失败',
  RATE_LIMIT_ERROR: '请求频率超限',
  SERVER_ERROR: '服务器内部错误',
  SERVICE_UNAVAILABLE: '服务不可用',
  
  // 客户端错误
  VALIDATION_ERROR: '参数验证失败',
  TIMEOUT_ERROR: '请求超时',
  NETWORK_ERROR: '网络错误',
  CONFIG_ERROR: '配置错误',
  
  // 模型错误
  MODEL_NOT_FOUND: '模型不存在',
  MODEL_UNAVAILABLE: '模型不可用',
  INFERENCE_ERROR: '推理失败',
  
  // 其他错误
  UNKNOWN_ERROR: '未知错误',
};

/**
 * 获取错误的可读描述
 */
export function getErrorDescription(error: KGMError): string {
  return ERROR_CODES[error.code as keyof typeof ERROR_CODES] || error.message;
}
