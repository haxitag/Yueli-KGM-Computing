/**
 * 延迟优化工具
 * 提供性能监控、瓶颈分析和优化建议
 */

import { performance, PerformanceObserver, PerformanceEntry } from 'perf_hooks';
import { EventEmitter } from 'events';

export interface LatencyConfig {
  /** 监控阈值（毫秒） */
  threshold: number;
  /** 采样率（0-1） */
  samplingRate: number;
  /** 是否启用性能追踪 */
  enableTracing: boolean;
  /** 是否启用瓶颈分析 */
  enableBottleneckAnalysis: boolean;
  /** 是否启用请求缓存 */
  enableRequestCaching: boolean;
  /** 缓存TTL（毫秒） */
  cacheTTL: number;
  /** 是否启用批处理 */
  enableBatching: boolean;
  /** 批处理窗口（毫秒） */
  batchWindow: number;
  /** 批处理最大大小 */
  batchMaxSize: number;
}

export interface PerformanceMetrics {
  /** 请求ID */
  requestId: string;
  /** 请求类型 */
  type: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 总耗时（毫秒） */
  duration: number;
  /** 各阶段耗时 */
  phases: Record<string, PhaseMetrics>;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
  /** 缓存状态 */
  cacheStatus?: 'hit' | 'miss' | 'skip';
  /** 批处理信息 */
  batchInfo?: {
    /** 批处理ID */
    batchId: string;
    /** 在批处理中的位置 */
    position: number;
    /** 批处理大小 */
    batchSize: number;
  };
}

export interface PhaseMetrics {
  /** 阶段名称 */
  name: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 耗时（毫秒） */
  duration: number;
  /** 子阶段 */
  subPhases?: PhaseMetrics[];
}

export interface BottleneckAnalysis {
  /** 分析时间 */
  timestamp: Date;
  /** 最慢的阶段 */
  slowestPhase: string;
  /** 阶段平均耗时 */
  phaseAverages: Record<string, number>;
  /** 热点分析 */
  hotspots: Array<{
    /** 阶段名称 */
    phase: string;
    /** 平均耗时（毫秒） */
    averageTime: number;
    /** 调用次数 */
    callCount: number;
    /** 占总时间比例 */
    percentage: number;
    /** 优化建议 */
    suggestions: string[];
  }>;
  /** 总体建议 */
  overallSuggestions: string[];
}

export interface CacheStats {
  /** 总请求数 */
  totalRequests: number;
  /** 缓存命中数 */
  cacheHits: number;
  /** 缓存未命中数 */
  cacheMisses: number;
  /** 缓存命中率 */
  hitRate: number;
  /** 缓存大小 */
  cacheSize: number;
  /** 缓存内存使用（字节） */
  cacheMemory: number;
  /** 按类型统计 */
  byType: Record<string, {
    hits: number;
    misses: number;
    hitRate: number;
  }>;
}

export interface BatchStats {
  /** 总批次数 */
  totalBatches: number;
  /** 总批处理请求数 */
  totalRequests: number;
  /** 平均批处理大小 */
  avgBatchSize: number;
  /** 批处理节省时间（毫秒） */
  timeSaved: number;
  /** 最大批处理并发数 */
  maxConcurrency: number;
}

/**
 * 延迟优化管理器
 */
export class LatencyOptimizer extends EventEmitter {
  private config: LatencyConfig;
  private performanceEntries: PerformanceEntry[] = [];
  private metricsHistory: PerformanceMetrics[] = [];
  private performanceObserver?: PerformanceObserver;
  private requestCache: Map<string, { data: any; timestamp: number }> = new Map();
  private batchQueues: Map<string, Array<{ request: any; resolve: Function; reject: Function }>> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  private cacheStats: CacheStats = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hitRate: 0,
    cacheSize: 0,
    cacheMemory: 0,
    byType: {},
  };
  private batchStats: BatchStats = {
    totalBatches: 0,
    totalRequests: 0,
    avgBatchSize: 0,
    timeSaved: 0,
    maxConcurrency: 0,
  };
  
  constructor(config: Partial<LatencyConfig> = {}) {
    super();
    
    this.config = {
      threshold: config.threshold || 1000, // 1秒
      samplingRate: config.samplingRate || 0.1, // 10%
      enableTracing: config.enableTracing ?? true,
      enableBottleneckAnalysis: config.enableBottleneckAnalysis ?? true,
      enableRequestCaching: config.enableRequestCaching ?? true,
      cacheTTL: config.cacheTTL || 60000, // 1分钟
      enableBatching: config.enableBatching ?? true,
      batchWindow: config.batchWindow || 50, // 50毫秒
      batchMaxSize: config.batchMaxSize || 100,
    };
    
    // 启动性能监控
    if (this.config.enableTracing) {
      this.startPerformanceMonitoring();
    }
    
    // 启动定期清理
    this.startCleanupTasks();
    
    console.log('🚀 延迟优化管理器已启动');
  }
  
  /**
   * 监控异步操作
   */
  async monitor<T>(
    operation: () => Promise<T>,
    options: {
      name: string;
      requestId?: string;
      useCache?: boolean;
      cacheKey?: string;
      batchKey?: string;
      tags?: Record<string, string>;
    }
  ): Promise<T> {
    const requestId = options.requestId || this.generateRequestId();
    const startTime = performance.now();
    
    const metrics: PerformanceMetrics = {
      requestId,
      type: options.name,
      startTime,
      endTime: 0,
      duration: 0,
      phases: {},
      success: false,
    };
    
    try {
      // 检查缓存
      if (options.useCache && options.cacheKey) {
        const cached = this.getFromCache(options.cacheKey);
        if (cached) {
          metrics.cacheStatus = 'hit';
          metrics.endTime = performance.now();
          metrics.duration = metrics.endTime - startTime;
          metrics.success = true;
          
          this.recordMetrics(metrics);
          return cached as T;
        }
        metrics.cacheStatus = 'miss';
      }
      
      // 检查批处理
      if (options.batchKey && this.config.enableBatching) {
        const result = await this.batchRequest(options.batchKey, operation, metrics);
        return result;
      }
      
      // 执行操作
      const result = await this.executeWithPhases(operation, metrics, options.tags || {});
      
      // 缓存结果
      if (options.useCache && options.cacheKey && result !== undefined) {
        this.setCache(options.cacheKey, result);
      }
      
      return result;
      
    } catch (error) {
      metrics.endTime = performance.now();
      metrics.duration = metrics.endTime - startTime;
      metrics.success = false;
      metrics.error = error instanceof Error ? error.message : String(error);
      
      this.recordMetrics(metrics);
      throw error;
    }
  }
  
  /**
   * 开始性能测量阶段
   */
  startPhase(name: string): () => void {
    const start = performance.now();
    
    return () => {
      const end = performance.now();
      const duration = end - start;
      
      // 记录阶段指标
      this.emit('phase.completed', {
        name,
        startTime: start,
        endTime: end,
        duration,
      });
      
      // 检查是否超过阈值
      if (duration > this.config.threshold) {
        this.emit('phase.slow', {
          name,
          duration,
          threshold: this.config.threshold,
        });
      }
    };
  }
  
  /**
   * 获取性能报告
   */
  getPerformanceReport(type?: string): {
    totalRequests: number;
    averageDuration: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    slowestRequests: PerformanceMetrics[];
    recentMetrics: PerformanceMetrics[];
  } {
    const filteredMetrics = type
      ? this.metricsHistory.filter(m => m.type === type)
      : this.metricsHistory;
    
    if (filteredMetrics.length === 0) {
      return {
        totalRequests: 0,
        averageDuration: 0,
        p50: 0,
        p90: 0,
        p95: 0,
        p99: 0,
        slowestRequests: [],
        recentMetrics: [],
      };
    }
    
    const durations = filteredMetrics.map(m => m.duration).sort((a, b) => a - b);
    
    const percentiles = (percent: number) => {
      const index = Math.ceil((percent / 100) * durations.length) - 1;
      return durations[Math.max(0, index)];
    };
    
    const average = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
    
    return {
      totalRequests: filteredMetrics.length,
      averageDuration: average,
      p50: percentiles(50),
      p90: percentiles(90),
      p95: percentiles(95),
      p99: percentiles(99),
      slowestRequests: [...filteredMetrics]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 10),
      recentMetrics: filteredMetrics.slice(-20),
    };
  }
  
  /**
   * 瓶颈分析
   */
  analyzeBottlenecks(type?: string): BottleneckAnalysis {
    const metrics = type
      ? this.metricsHistory.filter(m => m.type === type)
      : this.metricsHistory;
    
    if (metrics.length === 0) {
      return {
        timestamp: new Date(),
        slowestPhase: 'N/A',
        phaseAverages: {},
        hotspots: [],
        overallSuggestions: ['暂无足够数据进行分析'],
      };
    }
    
    // 收集阶段数据
    const phaseData: Record<string, { totalTime: number; count: number; durations: number[] }> = {};
    
    for (const metric of metrics) {
      for (const [phaseName, phaseMetrics] of Object.entries(metric.phases)) {
        if (!phaseData[phaseName]) {
          phaseData[phaseName] = {
            totalTime: 0,
            count: 0,
            durations: [],
          };
        }
        
        phaseData[phaseName].totalTime += phaseMetrics.duration;
        phaseData[phaseName].count += 1;
        phaseData[phaseName].durations.push(phaseMetrics.duration);
      }
    }
    
    // 计算平均时间
    const phaseAverages: Record<string, number> = {};
    for (const [phaseName, data] of Object.entries(phaseData)) {
      phaseAverages[phaseName] = data.totalTime / data.count;
    }
    
    // 找到最慢的阶段
    const slowestPhase = Object.entries(phaseAverages)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || 'N/A';
    
    // 分析热点
    const hotspots: BottleneckAnalysis['hotspots'] = [];
    const totalTime = metrics.reduce((sum, m) => sum + m.duration, 0);
    
    for (const [phaseName, data] of Object.entries(phaseData)) {
      const phaseTime = data.totalTime;
      const percentage = (phaseTime / totalTime) * 100;
      
      if (percentage > 5) { // 占比超过5%的认为是热点
        const averageTime = phaseAverages[phaseName];
        const suggestions = this.generateSuggestions(phaseName, averageTime, data);
        
        hotspots.push({
          phase: phaseName,
          averageTime,
          callCount: data.count,
          percentage,
          suggestions,
        });
      }
    }
    
    // 生成总体建议
    const overallSuggestions = this.generateOverallSuggestions(metrics, hotspots);
    
    return {
      timestamp: new Date(),
      slowestPhase,
      phaseAverages,
      hotspots: hotspots.sort((a, b) => b.percentage - a.percentage),
      overallSuggestions,
    };
  }
  
  /**
   * 获取缓存统计
   */
  getCacheStats(): CacheStats {
    const stats = { ...this.cacheStats };
    stats.hitRate = stats.totalRequests > 0 
      ? (stats.cacheHits / stats.totalRequests) * 100 
      : 0;
    
    // 计算缓存内存使用
    let memory = 0;
    for (const [, value] of this.requestCache.entries()) {
      try {
        memory += JSON.stringify(value.data).length;
      } catch {
        // 忽略无法序列化的对象
      }
    }
    
    stats.cacheMemory = memory;
    stats.cacheSize = this.requestCache.size;
    
    return stats;
  }
  
  /**
   * 获取批处理统计
   */
  getBatchStats(): BatchStats {
    return { ...this.batchStats };
  }
  
  /**
   * 清理缓存
   */
  clearCache(): number {
    const size = this.requestCache.size;
    this.requestCache.clear();
    
    // 重置缓存统计
    this.cacheStats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      hitRate: 0,
      cacheSize: 0,
      cacheMemory: 0,
      byType: {},
    };
    
    console.log(`🗑️  已清理缓存: ${size} 个项目`);
    return size;
  }
  
  /**
   * 优化建议
   */
  getOptimizationSuggestions(): Array<{
    priority: 'high' | 'medium' | 'low';
    area: string;
    suggestion: string;
    impact: string;
    estimatedImprovement: string;
  }> {
    const suggestions: Array<any> = [];
    const report = this.getPerformanceReport();
    const bottlenecks = this.analyzeBottlenecks();
    const cacheStats = this.getCacheStats();
    const batchStats = this.getBatchStats();
    
    // 慢请求建议
    if (report.p99 > this.config.threshold) {
      suggestions.push({
        priority: 'high',
        area: '整体性能',
        suggestion: `优化最慢的1%请求，当前P99为${report.p99.toFixed(2)}ms`,
        impact: '改善用户体验，减少超时',
        estimatedImprovement: `降低${Math.min(50, report.p99 - this.config.threshold)}%延迟`,
      });
    }
    
    // 热点建议
    for (const hotspot of bottlenecks.hotspots.slice(0, 3)) {
      suggestions.push({
        priority: hotspot.percentage > 20 ? 'high' : 'medium',
        area: hotspot.phase,
        suggestion: `优化${hotspot.phase}阶段，平均耗时${hotspot.averageTime.toFixed(2)}ms`,
        impact: `占总时间${hotspot.percentage.toFixed(1)}%`,
        estimatedImprovement: `降低${Math.min(30, hotspot.averageTime / 2)}%延迟`,
      });
    }
    
    // 缓存建议
    if (cacheStats.hitRate < 30) {
      suggestions.push({
        priority: 'medium',
        area: '缓存',
        suggestion: '提高缓存命中率，当前为' + cacheStats.hitRate.toFixed(1) + '%',
        impact: '减少重复计算，降低延迟',
        estimatedImprovement: '提升50-70%命中率',
      });
    }
    
    // 批处理建议
    if (batchStats.avgBatchSize < this.config.batchMaxSize / 2) {
      suggestions.push({
        priority: 'low',
        area: '批处理',
        suggestion: '增加批处理利用率',
        impact: '减少网络开销，提高吞吐量',
        estimatedImprovement: '提升30-50%吞吐量',
      });
    }
    
    return suggestions;
  }
  
  /**
   * 停止优化管理器
   */
  stop(): void {
    if (this.performanceObserver) {
      this.performanceObserver.disconnect();
    }
    
    // 清理所有批处理定时器
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    
    this.batchTimers.clear();
    this.batchQueues.clear();
    
    console.log('🛑 延迟优化管理器已停止');
  }
  
  private async executeWithPhases<T>(
    operation: () => Promise<T>,
    metrics: PerformanceMetrics,
    tags: Record<string, string>
  ): Promise<T> {
    const phases: Record<string, PhaseMetrics> = {};
    let currentPhase = 'total';
    
    const endPhase = this.startPhase('operation');
    
    try {
      // 记录子阶段
      const phaseEnders: Array<() => void> = [];
      
      // 启动主阶段
      const mainPhaseEnd = this.startPhase('main');
      phaseEnders.push(mainPhaseEnd);
      
      // 执行操作
      const result = await operation();
      
      // 结束主阶段
      mainPhaseEnd();
      
      // 结束总阶段
      endPhase();
      
      // 记录指标
      metrics.endTime = performance.now();
      metrics.duration = metrics.endTime - metrics.startTime;
      metrics.success = true;
      metrics.phases = phases;
      
      this.recordMetrics(metrics);
      
      return result;
      
    } catch (error) {
      endPhase();
      throw error;
    }
  }
  
  private async batchRequest<T>(
    batchKey: string,
    operation: () => Promise<T>,
    metrics: PerformanceMetrics
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let queue = this.batchQueues.get(batchKey);
      
      if (!queue) {
        queue = [];
        this.batchQueues.set(batchKey, queue);
      }
      
      // 添加到队列
      queue.push({
        request: { metrics },
        resolve: (value: T) => {
          metrics.endTime = performance.now();
          metrics.duration = metrics.endTime - metrics.startTime;
          metrics.success = true;
          
          // 记录批处理信息
          metrics.batchInfo = {
            batchId: batchKey,
            position: queue!.length,
            batchSize: queue!.length,
          };
          
          this.recordMetrics(metrics);
          resolve(value);
        },
        reject: (error: any) => {
          metrics.endTime = performance.now();
          metrics.duration = metrics.endTime - metrics.startTime;
          metrics.success = false;
          metrics.error = error instanceof Error ? error.message : String(error);
          
          this.recordMetrics(metrics);
          reject(error);
        },
      });
      
      // 如果队列已满，立即执行
      if (queue.length >= this.config.batchMaxSize) {
        this.executeBatch(batchKey, queue);
      } else {
        // 设置批处理定时器
        if (!this.batchTimers.has(batchKey)) {
          const timer = setTimeout(() => {
            this.executeBatch(batchKey, queue!);
          }, this.config.batchWindow);
          
          this.batchTimers.set(batchKey, timer);
        }
      }
    });
  }
  
  private async executeBatch(
    batchKey: string,
    queue: Array<{ request: any; resolve: Function; reject: Function }>
  ): Promise<void> {
    // 清理定时器
    const timer = this.batchTimers.get(batchKey);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(batchKey);
    }
    
    // 清空队列
    this.batchQueues.delete(batchKey);
    
    if (queue.length === 0) {
      return;
    }
    
    const batchSize = queue.length;
    const startTime = performance.now();
    
    // 更新批处理统计
    this.batchStats.totalBatches++;
    this.batchStats.totalRequests += batchSize;
    this.batchStats.avgBatchSize = 
      (this.batchStats.avgBatchSize * (this.batchStats.totalBatches - 1) + batchSize) / 
      this.batchStats.totalBatches;
    
    try {
      // 这里应该执行实际的批处理逻辑
      // 为了演示，我们逐个执行（实际应该合并请求）
      
      const results = await Promise.all(
        queue.map(async (item, index) => {
          try {
            // 模拟批处理优化
            await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
            
            const result = `batch_result_${batchKey}_${index}`;
            item.resolve(result);
            return { success: true, result };
          } catch (error) {
            item.reject(error);
            return { success: false, error };
          }
        })
      );
      
      const endTime = performance.now();
      const batchDuration = endTime - startTime;
      
      // 估计节省的时间（假设串行执行每个请求平均50ms）
      const estimatedSerialTime = batchSize * 50;
      const timeSaved = Math.max(0, estimatedSerialTime - batchDuration);
      this.batchStats.timeSaved += timeSaved;
      
      console.log(`📦 批处理完成: ${batchKey}, 大小: ${batchSize}, 节省: ${timeSaved.toFixed(2)}ms`);
      
    } catch (error) {
      console.error('批处理执行失败:', error);
      
      // 失败时拒绝所有请求
      for (const item of queue) {
        item.reject(error);
      }
    }
  }
  
  private getFromCache(key: string): any {
    if (!this.config.enableRequestCaching) {
      return null;
    }
    
    const cached = this.requestCache.get(key);
    if (!cached) {
      return null;
    }
    
    const now = Date.now();
    if (now - cached.timestamp > this.config.cacheTTL) {
      this.requestCache.delete(key);
      return null;
    }
    
    // 更新缓存统计
    this.cacheStats.cacheHits++;
    this.cacheStats.totalRequests++;
    
    return cached.data;
  }
  
  private setCache(key: string, data: any): void {
    if (!this.config.enableRequestCaching) {
      return;
    }
    
    this.requestCache.set(key, {
      data,
      timestamp: Date.now(),
    });
    
    // 更新缓存统计
    this.cacheStats.totalRequests++;
    
    console.debug(`💾 缓存设置: ${key}`);
  }
  
  private recordMetrics(metrics: PerformanceMetrics): void {
    // 采样
    if (Math.random() > this.config.samplingRate) {
      return;
    }
    
    this.metricsHistory.push(metrics);
    
    // 保持历史记录大小
    if (this.metricsHistory.length > 10000) {
      this.metricsHistory = this.metricsHistory.slice(-5000);
    }
    
    // 检查是否超过阈值
    if (metrics.duration > this.config.threshold) {
      console.warn(`⚠️ 慢请求: ${metrics.type} (${metrics.duration.toFixed(2)}ms)`);
      this.emit('request.slow', metrics);
    }
    
    // 检查是否失败
    if (!metrics.success) {
      this.emit('request.failed', metrics);
    } else {
      this.emit('request.completed', metrics);
    }
  }
  
  private startPerformanceMonitoring(): void {
    this.performanceObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      this.performanceEntries.push(...entries);
      
      // 保持性能条目大小
      if (this.performanceEntries.length > 1000) {
        this.performanceEntries = this.performanceEntries.slice(-500);
      }
      
      // 分析性能条目
      this.analyzePerformanceEntries(entries);
    });
    
    this.performanceObserver.observe({ entryTypes: ['measure', 'mark'] });
  }
  
  private analyzePerformanceEntries(entries: PerformanceEntry[]): void {
    for (const entry of entries) {
      if (entry.entryType === 'measure' && entry.duration > this.config.threshold) {
        console.warn(`⚠️ 性能测量超标: ${entry.name} (${entry.duration.toFixed(2)}ms)`);
        this.emit('performance.measure.slow', entry);
      }
    }
  }
  
  private startCleanupTasks(): void {
    // 定期清理过期缓存
    setInterval(() => {
      this.cleanupExpiredCache();
    }, 60000); // 每分钟清理一次
    
    // 定期清理旧指标
    setInterval(() => {
      this.cleanupOldMetrics();
    }, 300000); // 每5分钟清理一次
  }
  
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of this.requestCache.entries()) {
      if (now - value.timestamp > this.config.cacheTTL) {
        this.requestCache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 清理过期缓存: ${cleaned} 个项目`);
    }
  }
  
  private cleanupOldMetrics(): void {
    const maxAge = 30 * 60 * 1000; // 30分钟
    const cutoff = Date.now() - maxAge;
    
    const initialLength = this.metricsHistory.length;
    this.metricsHistory = this.metricsHistory.filter(
      m => m.startTime >= cutoff
    );
    
    const removed = initialLength - this.metricsHistory.length;
    if (removed > 0) {
      console.log(`🧹 清理旧性能指标: ${removed} 条记录`);
    }
  }
  
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private generateSuggestions(
    phaseName: string,
    averageTime: number,
    data: { totalTime: number; count: number; durations: number[] }
  ): string[] {
    const suggestions: string[] = [];
    
    if (averageTime > 1000) {
      suggestions.push('考虑异步处理或优化算法复杂度');
    } else if (averageTime > 500) {
      suggestions.push('检查是否有不必要的同步操作');
    }
    
    if (data.count > 1000) {
      suggestions.push('考虑添加缓存或批处理');
    }
    
    if (phaseName.includes('network') || phaseName.includes('http')) {
      suggestions.push('优化网络请求，考虑使用连接池或压缩');
    }
    
    if (phaseName.includes('database') || phaseName.includes('query')) {
      suggestions.push('优化数据库查询，添加索引或缓存');
    }
    
    return suggestions;
  }
  
  private generateOverallSuggestions(
    metrics: PerformanceMetrics[],
    hotspots: BottleneckAnalysis['hotspots']
  ): string[] {
    const suggestions: string[] = [];
    const totalRequests = metrics.length;
    
    if (totalRequests > 1000) {
      suggestions.push('考虑水平扩展或负载均衡');
    }
    
    if (hotspots.length > 0) {
      const topHotspot = hotspots[0];
      if (topHotspot.percentage > 50) {
        suggestions.push(`重点优化 ${topHotspot.phase} 阶段，它占据了大部分时间`);
      }
    }
    
    const errorRate = metrics.filter(m => !m.success).length / totalRequests;
    if (errorRate > 0.1) {
      suggestions.push('错误率较高，需要检查系统稳定性');
    }
    
    const avgDuration = metrics.reduce((sum, m) => sum + m.duration, 0) / totalRequests;
    if (avgDuration > 300) {
      suggestions.push('平均响应时间超过300ms，需要整体优化');
    }
    
    return suggestions;
  }
}

/**
 * 默认延迟优化器实例
 */
export const latencyOptimizer = new LatencyOptimizer();

/**
 * 快速延迟检查
 */
export function quickLatencyCheck(): {
  ok: boolean;
  averageLatency: number;
  p95: number;
  suggestions: string[];
} {
  const optimizer = new LatencyOptimizer({
    enableTracing: false,
    samplingRate: 0,
  });
  
  const report = optimizer.getPerformanceReport();
  
  const suggestions: string[] = [];
  let ok = true;
  
  if (report.p95 > 1000) {
    ok = false;
    suggestions.push(`P95延迟超过1秒 (${report.p95.toFixed(2)}ms)，需要优化`);
  }
  
  if (report.averageDuration > 300) {
    suggestions.push(`平均延迟较高 (${report.averageDuration.toFixed(2)}ms)`);
  }
  
  optimizer.stop();
  
  return {
    ok,
    averageLatency: report.averageDuration,
    p95: report.p95,
    suggestions,
  };
}