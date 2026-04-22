/**
 * 错误处理系统配置
 */

import type { AlertConfig } from './monitoring.js';

export interface ErrorSystemConfig {
  /** 是否启用错误监控 */
  enableMonitoring: boolean;
  /** 是否启用告警 */
  enableAlerts: boolean;
  /** 告警配置 */
  alerts: AlertConfig[];
  /** 默认重试配置 */
  defaultRetry: {
    maxAttempts: number;
    baseDelay: number;
    maxDelay: number;
    strategy: 'fixed' | 'linear' | 'exponential' | 'jitter';
  };
  /** 服务特定配置 */
  services: Record<string, ServiceErrorConfig>;
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 是否启用远程错误报告 */
  enableRemoteReporting: boolean;
  /** 远程报告URL */
  remoteReportingUrl?: string;
  /** 是否启用性能监控 */
  enablePerformanceTracing: boolean;
  /** 采样率（0-1） */
  samplingRate: number;
}

export interface ServiceErrorConfig {
  /** 服务名称 */
  name: string;
  /** 最大重试次数 */
  maxRetries: number;
  /** 断路器配置 */
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeout: number;
  };
  /** 降级策略 */
  fallbackStrategies: Array<{
    name: string;
    condition: string;
    action: string;
  }>;
  /** 监控指标 */
  metrics: {
    enabled: boolean;
    retentionPeriod?: number;
  };
}

/**
 * 默认配置
 */
export const DEFAULT_ERROR_CONFIG: ErrorSystemConfig = {
  enableMonitoring: true,
  enableAlerts: true,
  alerts: [
    {
      name: 'critical_errors',
      pattern: 'critical|fatal',
      threshold: 1,
      windowMs: 60000,
      severity: 'critical',
      channels: [{ type: 'console', config: {} }],
      cooldownMs: 300000,
      template: '🚨 CRITICAL: {{service}} 服务出现致命错误',
    },
    {
      name: 'high_frequency_errors',
      pattern: '.*',
      threshold: 10,
      windowMs: 60000,
      severity: 'high',
      channels: [{ type: 'console', config: {} }],
      cooldownMs: 600000,
      template: '⚠️ HIGH: {{service}} 错误频率过高 ({{count}} 次/分钟)',
    },
  ],
  defaultRetry: {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    strategy: 'exponential',
  },
  services: {
    inference: {
      name: 'inference',
      maxRetries: 3,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 3,
        resetTimeout: 30000,
      },
      fallbackStrategies: [
        {
          name: 'fallback_to_smaller_model',
          condition: 'model_unavailable',
          action: 'use_fallback_model',
        },
        {
          name: 'reduce_batch_size',
          condition: 'memory_overflow',
          action: 'reduce_batch_by_half',
        },
      ],
      metrics: {
        enabled: true,
        retentionPeriod: 86400000, // 24小时
      },
    },
    memory: {
      name: 'memory',
      maxRetries: 2,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 5,
        resetTimeout: 60000,
      },
      fallbackStrategies: [
        {
          name: 'persist_to_disk',
          condition: 'memory_full',
          action: 'offload_to_storage',
        },
        {
          name: 'reduce_cache_size',
          condition: 'cache_overflow',
          action: 'shrink_cache',
        },
      ],
      metrics: {
        enabled: true,
        retentionPeriod: 86400000,
      },
    },
    network: {
      name: 'network',
      maxRetries: 5,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 10,
        resetTimeout: 120000,
      },
      fallbackStrategies: [
        {
          name: 'switch_endpoint',
          condition: 'endpoint_unreachable',
          action: 'use_backup_endpoint',
        },
        {
          name: 'use_cached_response',
          condition: 'network_failure',
          action: 'return_cached_data',
        },
      ],
      metrics: {
        enabled: true,
        retentionPeriod: 3600000, // 1小时
      },
    },
  },
  logLevel: 'info',
  enableRemoteReporting: false,
  enablePerformanceTracing: true,
  samplingRate: 0.1, // 10%采样率
};

/**
 * 从环境变量加载配置
 */
export function loadConfigFromEnv(): ErrorSystemConfig {
  const config = { ...DEFAULT_ERROR_CONFIG };
  
  // 从环境变量读取配置
  if (process.env.KGM_ERROR_MONITORING_ENABLED) {
    config.enableMonitoring = process.env.KGM_ERROR_MONITORING_ENABLED === 'true';
  }
  
  if (process.env.KGM_ERROR_ALERTS_ENABLED) {
    config.enableAlerts = process.env.KGM_ERROR_ALERTS_ENABLED === 'true';
  }
  
  if (process.env.KGM_ERROR_LOG_LEVEL) {
    const level = process.env.KGM_ERROR_LOG_LEVEL.toLowerCase();
    if (['debug', 'info', 'warn', 'error'].includes(level)) {
      config.logLevel = level as any;
    }
  }
  
  if (process.env.KGM_ERROR_REMOTE_REPORTING_URL) {
    config.enableRemoteReporting = true;
    config.remoteReportingUrl = process.env.KGM_ERROR_REMOTE_REPORTING_URL;
  }
  
  if (process.env.KGM_ERROR_SAMPLING_RATE) {
    const rate = parseFloat(process.env.KGM_ERROR_SAMPLING_RATE);
    if (!isNaN(rate) && rate >= 0 && rate <= 1) {
      config.samplingRate = rate;
    }
  }
  
  return config;
}

/**
 * 验证配置
 */
export function validateConfig(config: ErrorSystemConfig): string[] {
  const errors: string[] = [];
  
  if (config.defaultRetry.maxAttempts < 0) {
    errors.push('defaultRetry.maxAttempts must be >= 0');
  }
  
  if (config.defaultRetry.baseDelay < 0) {
    errors.push('defaultRetry.baseDelay must be >= 0');
  }
  
  if (config.defaultRetry.maxDelay < config.defaultRetry.baseDelay) {
    errors.push('defaultRetry.maxDelay must be >= baseDelay');
  }
  
  if (config.samplingRate < 0 || config.samplingRate > 1) {
    errors.push('samplingRate must be between 0 and 1');
  }
  
  // 验证服务配置
  for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
    if (serviceConfig.maxRetries < 0) {
      errors.push(`services.${serviceName}.maxRetries must be >= 0`);
    }
    
    if (serviceConfig.circuitBreaker.failureThreshold < 1) {
      errors.push(`services.${serviceName}.circuitBreaker.failureThreshold must be >= 1`);
    }
    
    if (serviceConfig.circuitBreaker.resetTimeout < 1000) {
      errors.push(`services.${serviceName}.circuitBreaker.resetTimeout must be >= 1000ms`);
    }
  }
  
  // 验证告警配置
  for (let i = 0; i < config.alerts.length; i++) {
    const alert = config.alerts[i];
    
    if (alert.threshold < 1) {
      errors.push(`alerts[${i}].threshold must be >= 1`);
    }
    
    if (alert.windowMs < 1000) {
      errors.push(`alerts[${i}].windowMs must be >= 1000ms`);
    }
    
    if (alert.cooldownMs < alert.windowMs) {
      errors.push(`alerts[${i}].cooldownMs must be >= windowMs`);
    }
  }
  
  return errors;
}

/**
 * 配置管理器
 */
export class ErrorConfigManager {
  private static instance: ErrorConfigManager;
  private config: ErrorSystemConfig;
  
  private constructor(config?: ErrorSystemConfig) {
    this.config = config || loadConfigFromEnv();
    
    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      console.warn('Error configuration validation warnings:', errors);
    }
  }
  
  static getInstance(config?: ErrorSystemConfig): ErrorConfigManager {
    if (!ErrorConfigManager.instance) {
      ErrorConfigManager.instance = new ErrorConfigManager(config);
    }
    return ErrorConfigManager.instance;
  }
  
  getConfig(): ErrorSystemConfig {
    return { ...this.config };
  }
  
  updateConfig(updates: Partial<ErrorSystemConfig>): void {
    const newConfig = { ...this.config, ...updates };
    const errors = validateConfig(newConfig);
    
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join(', ')}`);
    }
    
    this.config = newConfig;
  }
  
  getServiceConfig(serviceName: string): ServiceErrorConfig | undefined {
    return this.config.services[serviceName];
  }
  
  addServiceConfig(serviceName: string, config: ServiceErrorConfig): void {
    this.config.services[serviceName] = config;
  }
  
  removeServiceConfig(serviceName: string): void {
    delete this.config.services[serviceName];
  }
  
  shouldSample(): boolean {
    return Math.random() < this.config.samplingRate;
  }
}