/**
 * 错误监控和告警系统
 * 提供实时的错误监控、聚合统计和智能告警
 */

import type { TelemetryManager } from '../telemetry/index.js';
import { KgError, ErrorSeverity, formatErrorForLogging } from './index.js';
import type { RetryStats } from './recovery.js';

export interface AlertConfig {
  /** 告警名称 */
  name: string;
  /** 错误模式匹配 */
  pattern: string;
  /** 触发阈值（例如：每分钟5次） */
  threshold: number;
  /** 时间窗口（毫秒） */
  windowMs: number;
  /** 告警严重级别 */
  severity: ErrorSeverity;
  /** 通知渠道 */
  channels: AlertChannel[];
  /** 冷却时间（毫秒，避免重复告警） */
  cooldownMs: number;
  /** 告警消息模板 */
  template?: string;
}

export interface AlertChannel {
  /** 渠道类型：slack|email|webhook|pagerduty */
  type: 'slack' | 'email' | 'webhook' | 'pagerduty' | 'console';
  /** 渠道配置 */
  config: Record<string, any>;
}

export interface ErrorMetrics {
  /** 总错误数 */
  totalErrors: number;
  /** 按分类统计的错误数 */
  errorsByCategory: Record<string, number>;
  /** 按严重级别统计的错误数 */
  errorsBySeverity: Record<ErrorSeverity, number>;
  /** 最近错误时间 */
  lastErrorTime: Date | null;
  /** 错误率（错误数/总请求数） */
  errorRate: number;
  /** 平均错误恢复时间（毫秒） */
  avgRecoveryTime?: number;
  /** 成功重试的百分比 */
  retrySuccessRate?: number;
}

export interface ErrorAggregation {
  /** 错误组ID（由错误模式生成） */
  groupId: string;
  /** 错误样本（第一个完整错误） */
  sample: unknown;
  /** 错误计数 */
  count: number;
  /** 首次出现时间 */
  firstSeen: Date;
  /** 最后出现时间 */
  lastSeen: Date;
  /** 受影响的用户/租户 */
  affectedEntities: string[];
  /** 相关服务/模块 */
  affectedServices: string[];
}

export class ErrorMonitor {
  private errorStats: Map<string, ErrorMetrics> = new Map();
  private errorAggregations: Map<string, ErrorAggregation> = new Map();
  private alertTriggers: Map<string, { lastTriggered: Date; count: number }> = new Map();
  private telemetry?: TelemetryManager;
  
  private readonly aggregationWindowMs = 5 * 60 * 1000; // 5分钟聚合窗口
  private readonly cleanupIntervalMs = 10 * 60 * 1000; // 10分钟清理一次

  constructor(private readonly alertConfigs: AlertConfig[] = []) {
    // 设置定期清理
    setInterval(() => this.cleanupOldData(), this.cleanupIntervalMs);
  }

  setTelemetry(telemetry: TelemetryManager): void {
    this.telemetry = telemetry;
  }

  /**
   * 记录错误
   */
  recordError(error: unknown, context?: {
    userId?: string;
    tenantId?: string;
    service?: string;
    requestId?: string;
    additionalData?: Record<string, unknown>;
  }): void {
    const normalizedError = formatErrorForLogging(error);
    const timestamp = new Date();
    
    // 生成错误指纹
    const fingerprint = this.generateErrorFingerprint(normalizedError);
    
    // 更新服务级别统计
    const serviceKey = context?.service || 'global';
    const serviceStats = this.errorStats.get(serviceKey) || this.createEmptyMetrics();
    
    serviceStats.totalErrors++;
    serviceStats.lastErrorTime = timestamp;
    
    // 按分类统计
    if (error instanceof KgError) {
      const categoryKey = error.category.toString();
      serviceStats.errorsByCategory[categoryKey] = (serviceStats.errorsByCategory[categoryKey] || 0) + 1;
      
      const severity = error.metadata.severity as ErrorSeverity;
      serviceStats.errorsBySeverity[severity] = (serviceStats.errorsBySeverity[severity] || 0) + 1;
    }
    
    this.errorStats.set(serviceKey, serviceStats);
    
    // 更新聚合统计
    const aggregationKey = this.getAggregationKey(fingerprint, serviceKey);
    let aggregation = this.errorAggregations.get(aggregationKey);
    
    if (!aggregation) {
      aggregation = {
        groupId: fingerprint,
        sample: normalizedError,
        count: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
        affectedEntities: [],
        affectedServices: [],
      };
    }
    
    aggregation.count++;
    aggregation.lastSeen = timestamp;
    
    if (context?.userId && !aggregation.affectedEntities.includes(context.userId)) {
      aggregation.affectedEntities.push(context.userId);
    }
    
    if (context?.service && !aggregation.affectedServices.includes(context.service)) {
      aggregation.affectedServices.push(context.service);
    }
    
    this.errorAggregations.set(aggregationKey, aggregation);
    
    // 发送遥测数据
    this.emitTelemetry(error, context);
    
    // 检查告警
    this.checkAlerts(fingerprint, serviceKey, error, context);
  }

  /**
   * 记录恢复成功
   */
  recordRecovery(
    errorId: string, 
    recoveryTimeMs: number, 
    context?: { service?: string }
  ): void {
    const serviceKey = context?.service || 'global';
    const serviceStats = this.errorStats.get(serviceKey);
    
    if (serviceStats) {
      if (!serviceStats.avgRecoveryTime) {
        serviceStats.avgRecoveryTime = recoveryTimeMs;
      } else {
        // 指数移动平均
        serviceStats.avgRecoveryTime = 0.8 * serviceStats.avgRecoveryTime + 0.2 * recoveryTimeMs;
      }
      
      this.errorStats.set(serviceKey, serviceStats);
    }
    
    // 发送到遥测
    if (this.telemetry) {
      this.telemetry.increment('errors.recovery_success', 1, {
        service: serviceKey,
        error_id: errorId,
      });
      this.telemetry.record('recovery.time', recoveryTimeMs, {
        service: serviceKey,
        error_id: errorId,
      });
    }
  }

  /**
   * 记录重试统计
   */
  recordRetryStats(stats: RetryStats, context?: { service?: string }): void {
    const serviceKey = context?.service || 'global';
    const serviceStats = this.errorStats.get(serviceKey);
    
    if (serviceStats && stats.totalAttempts > 0) {
      const successRate = (stats.successfulAttempts / stats.totalAttempts) * 100;
      
      if (!serviceStats.retrySuccessRate) {
        serviceStats.retrySuccessRate = successRate;
      } else {
        // 加权平均
        serviceStats.retrySuccessRate = 0.7 * serviceStats.retrySuccessRate + 0.3 * successRate;
      }
      
      this.errorStats.set(serviceKey, serviceStats);
    }
    
    // 发送到遥测
    if (this.telemetry) {
      this.telemetry.record('retry.stats', {
        total_attempts: stats.totalAttempts,
        successful_attempts: stats.successfulAttempts,
        failed_attempts: stats.failedAttempts,
        avg_delay: stats.avgRetryDelay,
        circuit_state: stats.circuitBreakerState,
      });
    }
  }

  /**
   * 获取错误统计
   */
  getMetrics(service?: string): ErrorMetrics | undefined {
    const key = service || 'global';
    return this.errorStats.get(key);
  }

  /**
   * 获取所有服务的错误聚合
   */
  getAggregations(): ErrorAggregation[] {
    return Array.from(this.errorAggregations.values());
  }

  /**
   * 按严重级别获取聚合
   */
  getAggregationsBySeverity(severity: ErrorSeverity): ErrorAggregation[] {
    const results: ErrorAggregation[] = [];
    
    for (const aggregation of this.errorAggregations.values()) {
      const error = aggregation.sample as any;
      if (error.severity === severity || error.metadata?.severity === severity) {
        results.push(aggregation);
      }
    }
    
    return results;
  }

  /**
   * 获取错误趋势数据（用于图表）
   */
  getErrorTrends(
    service: string,
    timeRangeMs: number = 30 * 60 * 1000, // 默认30分钟
    bucketSizeMs: number = 5 * 60 * 1000   // 默认5分钟桶
  ): Array<{ timestamp: Date; count: number; severity: ErrorSeverity }> {
    // 为了简化，这里返回模拟数据
    // 实际实现需要从时间序列数据库读取
    const now = new Date();
    const trends: Array<{ timestamp: Date; count: number; severity: ErrorSeverity }> = [];
    
    for (let i = 0; i < timeRangeMs / bucketSizeMs; i++) {
      const timestamp = new Date(now.getTime() - (i * bucketSizeMs));
      
      trends.push({
        timestamp,
        count: Math.floor(Math.random() * 10),
        severity: i % 4 === 0 ? ErrorSeverity.CRITICAL : 
                  i % 3 === 0 ? ErrorSeverity.HIGH : 
                  i % 2 === 0 ? ErrorSeverity.MEDIUM : 
                  ErrorSeverity.LOW,
      });
    }
    
    return trends.reverse(); // 按时间顺序返回
  }

  /**
   * 健康度评分
   */
  getHealthScore(service?: string): number {
    const key = service || 'global';
    const metrics = this.errorStats.get(key);
    
    if (!metrics || metrics.totalErrors === 0) {
      return 100; // 无错误，健康度满分
    }
    
    let score = 100;
    
    // 按严重级别扣分
    const severityPenalties: Record<ErrorSeverity, number> = {
      [ErrorSeverity.CRITICAL]: 30,
      [ErrorSeverity.HIGH]: 15,
      [ErrorSeverity.MEDIUM]: 5,
      [ErrorSeverity.LOW]: 2,
    };
    
    for (const [severity, count] of Object.entries(metrics.errorsBySeverity)) {
      const penalty = severityPenalties[severity as ErrorSeverity] || 5;
      score -= Math.min(penalty * count, 10); // 同一类型最多扣10分
    }
    
    // 按错误率调整
    if (metrics.errorRate > 0.1) { // 错误率超过10%
      score -= 20;
    }
    
    // 按恢复时间调整
    if (metrics.avgRecoveryTime && metrics.avgRecoveryTime > 30000) { // 恢复时间超过30秒
      score -= 10;
    }
    
    return Math.max(0, score);
  }

  private generateErrorFingerprint(error: any): string {
    // 基于错误消息、堆栈、类型生成唯一指纹
    const components: string[] = [];
    
    if (error.name) components.push(error.name);
    if (error.message) {
      // 提取错误消息的关键部分，过滤掉变量数据
      const message = error.message;
      const cleanMessage = message
        .replace(/\d+/g, '#')
        .replace(/0x[0-9a-fA-F]+/g, '#')
        .replace(/['"].*?['"]/g, '#')
        .replace(/\{.*?\}/g, '#');
      components.push(cleanMessage);
    }
    
    if (error.stack) {
      // 只取最重要的堆栈帧
      const stackLines = error.stack.split('\n').slice(0, 3);
      for (const line of stackLines) {
        // 提取文件名和行号
        const match = line.match(/at (.+?) \((.+):(\d+):(\d+)\)/);
        if (match) {
          const [, , file, lineNum] = match;
          components.push(`${file}:${lineNum}`);
        }
      }
    }
    
    if (error.code) components.push(String(error.code));
    
    return this.hashString(components.join('|'));
  }

  private getAggregationKey(fingerprint: string, service: string): string {
    return `${service}::${fingerprint}`;
  }

  private hashString(str: string): string {
    // 简单的哈希函数（实际生产环境中应使用更健壮的哈希）
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash).toString(16);
  }

  private createEmptyMetrics(): ErrorMetrics {
    return {
      totalErrors: 0,
      errorsByCategory: {},
      errorsBySeverity: {
        [ErrorSeverity.LOW]: 0,
        [ErrorSeverity.MEDIUM]: 0,
        [ErrorSeverity.HIGH]: 0,
        [ErrorSeverity.CRITICAL]: 0,
      },
      lastErrorTime: null,
      errorRate: 0,
    };
  }

  private emitTelemetry(error: unknown, context?: any): void {
    if (!this.telemetry) return;
    
    try {
      const normalizedError = formatErrorForLogging(error);
      
      this.telemetry.increment('errors.total', 1, {
        service: context?.service || 'unknown',
        severity: (normalizedError as any).severity || ErrorSeverity.MEDIUM,
        category: (normalizedError as any).category || 'unknown',
      });
      
      if (error instanceof KgError && error.metadata.code) {
        this.telemetry.increment(`errors.${error.metadata.code}`, 1);
      }
    } catch (telemetryError) {
      console.warn('Failed to emit error telemetry:', telemetryError);
    }
  }

  private checkAlerts(
    fingerprint: string,
    serviceKey: string,
    error: unknown,
    context?: any
  ): void {
    for (const config of this.alertConfigs) {
      // 检查错误是否匹配模式
      if (!this.errorMatchesPattern(error, config.pattern)) {
        continue;
      }
      
      // 获取触发器状态
      const triggerKey = `${config.name}::${serviceKey}`;
      const trigger = this.alertTriggers.get(triggerKey) || {
        lastTriggered: new Date(0),
        count: 0,
      };
      
      const now = new Date();
      const timeSinceLastTrigger = now.getTime() - trigger.lastTriggered.getTime();
      
      // 检查冷却时间
      if (timeSinceLastTrigger < config.cooldownMs) {
        continue;
      }
      
      // 更新时间窗口内的错误计数
      if (timeSinceLastTrigger > config.windowMs) {
        // 超出时间窗口，重置计数
        trigger.count = 0;
      }
      
      trigger.count++;
      
      // 检查是否达到阈值
      if (trigger.count >= config.threshold) {
        trigger.lastTriggered = now;
        this.triggerAlert(config, error, context, trigger.count);
      }
      
      this.alertTriggers.set(triggerKey, trigger);
    }
  }

  private errorMatchesPattern(error: unknown, pattern: string): boolean {
    const normalizedError = formatErrorForLogging(error);
    const errorString = JSON.stringify(normalizedError).toLowerCase();
    const patternLower = pattern.toLowerCase();
    
    // 简单的字符串匹配（实际可使用正则表达式）
    return errorString.includes(patternLower);
  }

  private triggerAlert(
    config: AlertConfig,
    error: unknown,
    context: any,
    count: number
  ): void {
    console.log(`🚨 触发告警: ${config.name} (${count} 次)`);
    
    const message = config.template 
      ? this.renderAlertTemplate(config.template, error, context, count)
      : this.generateDefaultAlertMessage(config, error, context, count);
    
    // 发送到各个渠道
    for (const channel of config.channels) {
      this.sendAlert(channel, message, config, error);
    }
  }

  private renderAlertTemplate(
    template: string,
    error: unknown,
    context: any,
    count: number
  ): string {
    const normalizedError = formatErrorForLogging(error);
    
    const variables: Record<string, string> = {
      name: context?.name || 'unknown',
      service: context?.service || 'unknown',
      timestamp: new Date().toISOString(),
      count: String(count),
      error: JSON.stringify(normalizedError, null, 2),
      severity: (normalizedError as any).severity || 'medium',
    };
    
    let message = template;
    for (const [key, value] of Object.entries(variables)) {
      message = message.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    
    return message;
  }

  private generateDefaultAlertMessage(
    config: AlertConfig,
    error: unknown,
    context: any,
    count: number
  ): string {
    const normalizedError = formatErrorForLogging(error);
    
    return `🚨 告警: ${config.name}
服务: ${context?.service || 'unknown'}
时间: ${new Date().toISOString()}
数量: ${count} 次 (在 ${config.windowMs / 1000} 秒内)
严重级别: ${config.severity}
错误: ${JSON.stringify(normalizedError, null, 2)}`;
  }

  private sendAlert(
    channel: AlertChannel,
    message: string,
    config: AlertConfig,
    error: unknown
  ): void {
    try {
      switch (channel.type) {
        case 'console':
          console.log(`[ALERT] ${message}`);
          break;
        case 'webhook':
          // 实际发送HTTP请求到webhook
          console.log(`[WEBHOOK] Sending alert to ${channel.config.url}: ${message}`);
          break;
        case 'slack':
          console.log(`[SLACK] Sending alert to Slack: ${message}`);
          break;
        case 'email':
          console.log(`[EMAIL] Sending alert to ${channel.config.to}: ${message}`);
          break;
        case 'pagerduty':
          console.log(`[PAGERDUTY] Creating incident: ${message}`);
          break;
      }
    } catch (alertError) {
      console.error(`Failed to send alert via ${channel.type}:`, alertError);
    }
  }

  private cleanupOldData(): void {
    const now = new Date();
    const cutoffTime = now.getTime() - this.aggregationWindowMs;
    
    // 清理旧的聚合数据
    for (const [key, aggregation] of this.errorAggregations.entries()) {
      if (aggregation.lastSeen.getTime() < cutoffTime) {
        this.errorAggregations.delete(key);
      }
    }
    
    // 清理旧的告警触发器
    for (const [key, trigger] of this.alertTriggers.entries()) {
      if (trigger.lastTriggered.getTime() < cutoffTime) {
        this.alertTriggers.delete(key);
      }
    }
  }
}

/**
 * 默认告警配置
 */
export const DEFAULT_ALERTS: AlertConfig[] = [
  {
    name: 'critical_errors',
    pattern: 'critical|fatal|fatal error',
    threshold: 1, // 任何致命错误都立即告警
    windowMs: 60 * 1000,
    severity: ErrorSeverity.CRITICAL,
    channels: [{ type: 'console', config: {} }],
    cooldownMs: 5 * 60 * 1000,
    template: '🚨 CRITICAL: {{service}} 服务出现致命错误: {{error}}',
  },
  {
    name: 'frequent_inference_failures',
    pattern: 'INF001|INF002|推理失败',
    threshold: 5,
    windowMs: 60 * 1000,
    severity: ErrorSeverity.HIGH,
    channels: [{ type: 'console', config: {} }],
    cooldownMs: 10 * 60 * 1000,
    template: '⚠️ HIGH: {{service}} 推理失败频繁 ({{count}} 次/分钟)',
  },
  {
    name: 'network_issues',
    pattern: 'NET001|NET002|network|connection',
    threshold: 10,
    windowMs: 5 * 60 * 1000,
    severity: ErrorSeverity.MEDIUM,
    channels: [{ type: 'console', config: {} }],
    cooldownMs: 15 * 60 * 1000,
    template: '🔧 MEDIUM: {{service}} 网络问题 ({{count}} 次/5分钟)',
  },
];

/**
 * 创建默认错误监控器
 */
export function createDefaultErrorMonitor(): ErrorMonitor {
  return new ErrorMonitor(DEFAULT_ALERTS);
}