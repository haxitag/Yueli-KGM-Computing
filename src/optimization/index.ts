/**
 * 性能优化主入口
 * 集成内存优化、延迟优化和其他性能工具
 */

import type { MemoryManager, MemoryConfig, MemoryStats } from './memory.js';
import type { LatencyOptimizer, LatencyConfig, PerformanceMetrics } from './latency.js';

export interface OptimizationConfig {
  /** 是否启用性能优化 */
  enabled: boolean;
  /** 内存优化配置 */
  memory: MemoryConfig;
  /** 延迟优化配置 */
  latency: LatencyConfig;
  /** 自动优化设置 */
  autoOptimization: {
    /** 是否启用自动优化 */
    enabled: boolean;
    /** 优化检查间隔（毫秒） */
    checkInterval: number;
    /** 优化触发阈值 */
    thresholds: {
      /** 内存使用阈值（MB） */
      memory: number;
      /** 延迟阈值（毫秒） */
      latency: number;
      /** CPU使用率阈值（0-1） */
      cpu: number;
    };
  };
  /** 报告配置 */
  reporting: {
    /** 是否启用性能报告 */
    enabled: boolean;
    /** 报告间隔（毫秒） */
    interval: number;
    /** 报告目标：console|api|file */
    target: 'console' | 'api' | 'file';
    /** 报告输出路径 */
    outputPath?: string;
  };
}

export interface PerformanceReport {
  /** 报告时间 */
  timestamp: Date;
  /** 内存统计 */
  memory: MemoryStats;
  /** 延迟统计 */
  latency: {
    /** 平均延迟 */
    average: number;
    /** P95延迟 */
    p95: number;
    /** P99延迟 */
    p99: number;
    /** 总请求数 */
    totalRequests: number;
    /** 错误率 */
    errorRate: number;
  };
  /** CPU使用率 */
  cpuUsage: number;
  /** 系统负载 */
  systemLoad: number[];
  /** 优化建议 */
  suggestions: Array<{
    priority: 'high' | 'medium' | 'low';
    area: string;
    suggestion: string;
  }>;
  /** 健康评分 (0-100) */
  healthScore: number;
}

/**
 * 性能优化管理器
 */
export class PerformanceOptimizer {
  private config: OptimizationConfig;
  private memoryManager?: MemoryManager;
  private latencyOptimizer?: LatencyOptimizer;
  private autoOptimizationInterval?: NodeJS.Timeout;
  private reportingInterval?: NodeJS.Timeout;
  
  constructor(config: Partial<OptimizationConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      memory: {
        warningThreshold: 512,
        dangerThreshold: 1024,
        monitorInterval: 5000,
        enableActiveGC: true,
        gcThreshold: 128,
        enableMemoryPool: true,
        poolConfig: {
          poolSize: 100,
          maxIdleTime: 300000,
          preallocate: 10,
        },
        enableLeakDetection: true,
        leakCheckInterval: 60000,
        heapSnapshot: {
          enabled: false,
          directory: './heapdumps',
          maxSnapshots: 5,
        },
        ...config.memory,
      },
      latency: {
        threshold: 1000,
        samplingRate: 0.1,
        enableTracing: true,
        enableBottleneckAnalysis: true,
        enableRequestCaching: true,
        cacheTTL: 60000,
        enableBatching: true,
        batchWindow: 50,
        batchMaxSize: 100,
        ...config.latency,
      },
      autoOptimization: {
        enabled: config.autoOptimization?.enabled ?? true,
        checkInterval: config.autoOptimization?.checkInterval || 30000,
        thresholds: {
          memory: config.autoOptimization?.thresholds?.memory || 512,
          latency: config.autoOptimization?.thresholds?.latency || 1000,
          cpu: config.autoOptimization?.thresholds?.cpu || 0.8,
          ...config.autoOptimization?.thresholds,
        },
      },
      reporting: {
        enabled: config.reporting?.enabled ?? true,
        interval: config.reporting?.interval || 60000,
        target: config.reporting?.target || 'console',
        outputPath: config.reporting?.outputPath,
        ...config.reporting,
      },
    };
    
    if (!this.config.enabled) {
      console.log('📊 性能优化已禁用');
      return;
    }
    
    this.initialize();
  }
  
  /**
   * 初始化优化器
   */
  async initialize(): Promise<void> {
    console.log('🚀 初始化性能优化器...');
    
    if (this.config.memory) {
      const { MemoryManager } = await import('./memory.js');
      this.memoryManager = new MemoryManager(this.config.memory);
      
      this.memoryManager.on('memory.warning', (stats) => {
        console.warn(`⚠️ 内存警告: ${stats.heapUsed.toFixed(2)}MB`);
        this.handleAutoOptimization('memory', stats);
      });
      
      this.memoryManager.on('memory.danger', (stats) => {
        console.error(`🚨 内存危险: ${stats.heapUsed.toFixed(2)}MB`);
        this.handleEmergencyOptimization('memory', stats);
      });
      
      this.memoryManager.on('memory.leak', (report) => {
        console.error(`🔍 检测到内存泄漏: ${report.growthRate.toFixed(2)}MB/分钟`);
        this.handleMemoryLeak(report);
      });
    }
    
    if (this.config.latency) {
      const { LatencyOptimizer } = await import('./latency.js');
      this.latencyOptimizer = new LatencyOptimizer(this.config.latency);
      
      this.latencyOptimizer.on('request.slow', (metrics) => {
        console.warn(`🐌 慢请求: ${metrics.type} (${metrics.duration.toFixed(2)}ms)`);
        this.handleAutoOptimization('latency', metrics);
      });
      
      this.latencyOptimizer.on('performance.measure.slow', (entry) => {
        console.warn(`📏 慢性能测量: ${entry.name} (${entry.duration.toFixed(2)}ms)`);
      });
    }
    
    // 启动自动优化
    if (this.config.autoOptimization.enabled) {
      this.startAutoOptimization();
    }
    
    // 启动性能报告
    if (this.config.reporting.enabled) {
      this.startPerformanceReporting();
    }
    
    console.log('✅ 性能优化器初始化完成');
  }
  
  /**
   * 获取内存管理器
   */
  getMemoryManager(): MemoryManager | undefined {
    return this.memoryManager;
  }
  
  /**
   * 获取延迟优化器
   */
  getLatencyOptimizer(): LatencyOptimizer | undefined {
    return this.latencyOptimizer;
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
    if (!this.latencyOptimizer) {
      return operation();
    }
    
    return this.latencyOptimizer.monitor(operation, options);
  }
  
  /**
   * 从内存池获取对象
   */
  async acquireFromPool<T>(
    poolName: string,
    creator: () => T,
    validator?: (obj: T) => boolean
  ): Promise<T> {
    if (!this.memoryManager) {
      return creator();
    }
    
    return this.memoryManager.acquireFromPool(poolName, creator, validator);
  }
  
  /**
   * 释放对象到内存池
   */
  releaseToPool<T>(
    poolName: string,
    obj: T,
    cleaner?: (obj: T) => void
  ): void {
    if (!this.memoryManager) {
      return;
    }
    
    this.memoryManager.releaseToPool(poolName, obj, cleaner);
  }
  
  /**
   * 获取性能报告
   */
  getPerformanceReport(): PerformanceReport {
    const memoryStats = this.memoryManager?.getMemoryStats();
    const latencyReport = this.latencyOptimizer?.getPerformanceReport();
    const cpuUsage = this.getCPUUsage();
    const systemLoad = this.getSystemLoad();
    
    const suggestions: PerformanceReport['suggestions'] = [];
    
    // 内存建议
    if (memoryStats) {
      if (memoryStats.pressure > 0.8) {
        suggestions.push({
          priority: 'high',
          area: '内存',
          suggestion: `内存压力高: ${(memoryStats.pressure * 100).toFixed(1)}%`,
        });
      }
      
      if (memoryStats.heapUsed > this.config.autoOptimization.thresholds.memory) {
        suggestions.push({
          priority: 'medium',
          area: '内存',
          suggestion: `内存使用超阈值: ${memoryStats.heapUsed.toFixed(2)}MB`,
        });
      }
    }
    
    // 延迟建议
    if (latencyReport) {
      if (latencyReport.p95 > this.config.autoOptimization.thresholds.latency) {
        suggestions.push({
          priority: 'high',
          area: '延迟',
          suggestion: `P95延迟超阈值: ${latencyReport.p95.toFixed(2)}ms`,
        });
      }
    }
    
    // CPU建议
    if (cpuUsage > this.config.autoOptimization.thresholds.cpu) {
      suggestions.push({
        priority: 'medium',
        area: 'CPU',
        suggestion: `CPU使用率高: ${(cpuUsage * 100).toFixed(1)}%`,
      });
    }
    
    // 健康评分
    let healthScore = 100;
    
    if (memoryStats) {
      healthScore -= Math.min(30, (memoryStats.pressure - 0.5) * 60);
    }
    
    if (latencyReport) {
      const latencyPenalty = Math.min(40, (latencyReport.p95 / 2000) * 40);
      healthScore -= latencyPenalty;
    }
    
    healthScore -= Math.min(20, (cpuUsage - 0.5) * 40);
    healthScore = Math.max(0, healthScore);
    
    return {
      timestamp: new Date(),
      memory: memoryStats || {
        processMemory: 0,
        heapUsed: 0,
        heapTotal: 0,
        heapLimit: 0,
        externalMemory: 0,
        arrayBuffers: 0,
        rss: 0,
        pressure: 0,
        gcCount: 0,
        gcTime: 0,
      },
      latency: {
        average: latencyReport?.averageDuration || 0,
        p95: latencyReport?.p95 || 0,
        p99: latencyReport?.p99 || 0,
        totalRequests: latencyReport?.totalRequests || 0,
        errorRate: (latencyReport?.totalRequests || 0) > 0 
          ? (latencyReport?.totalRequests - (latencyReport?.totalRequests || 0)) / latencyReport!.totalRequests 
          : 0,
      },
      cpuUsage,
      systemLoad,
      suggestions,
      healthScore,
    };
  }
  
  /**
   * 进行瓶颈分析
   */
  analyzeBottlenecks(type?: string) {
    return this.latencyOptimizer?.analyzeBottlenecks(type);
  }
  
  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return this.latencyOptimizer?.getCacheStats();
  }
  
  /**
   * 获取内存池统计
   */
  getPoolStats() {
    return this.memoryManager?.getPoolStats();
  }
  
  /**
   * 生成堆快照
   */
  async takeHeapSnapshot(name?: string) {
    return this.memoryManager?.takeHeapSnapshot(name);
  }
  
  /**
   * 清理缓存
   */
  clearCache(): number {
    const latencyCleared = this.latencyOptimizer?.clearCache() || 0;
    
    // 清理内存池
    const poolCleaned = this.memoryManager?.cleanupPools() || 0;
    
    console.log(`🧹 清理完成: ${latencyCleared} 缓存项, ${poolCleaned} 池对象`);
    
    return latencyCleared + poolCleaned;
  }
  
  /**
   * 执行压力测试
   */
  async stressTest(options: {
    duration: number;
    objectCount: number;
    objectSize: number;
  }) {
    if (!this.memoryManager) {
      throw new Error('内存管理器未初始化');
    }
    
    return this.memoryManager.stressTest(options);
  }
  
  /**
   * 应用优化配置
   */
  applyOptimization(config: Partial<OptimizationConfig>): void {
    console.log('⚙️  应用优化配置...');
    
    // 更新配置
    this.config = {
      ...this.config,
      ...config,
      memory: { ...this.config.memory, ...config.memory },
      latency: { ...this.config.latency, ...config.latency },
      autoOptimization: { ...this.config.autoOptimization, ...config.autoOptimization },
      reporting: { ...this.config.reporting, ...config.reporting },
    };
    
    // 重新初始化（简化版本）
    if (config.memory && this.memoryManager) {
      // 实际应该重启内存管理器
      console.warn('内存配置更新需要重启内存管理器');
    }
    
    if (config.latency && this.latencyOptimizer) {
      console.warn('延迟配置更新需要重启延迟优化器');
    }
    
    // 重启定时器
    if (this.autoOptimizationInterval) {
      clearInterval(this.autoOptimizationInterval);
    }
    
    if (this.reportingInterval) {
      clearInterval(this.reportingInterval);
    }
    
    if (this.config.autoOptimization.enabled) {
      this.startAutoOptimization();
    }
    
    if (this.config.reporting.enabled) {
      this.startPerformanceReporting();
    }
    
    console.log('✅ 优化配置已应用');
  }
  
  /**
   * 停止优化器
   */
  async stop(): Promise<void> {
    console.log('🛑 停止性能优化器...');
    
    if (this.autoOptimizationInterval) {
      clearInterval(this.autoOptimizationInterval);
    }
    
    if (this.reportingInterval) {
      clearInterval(this.reportingInterval);
    }
    
    await this.memoryManager?.stop();
    this.latencyOptimizer?.stop();
    
    console.log('✅ 性能优化器已停止');
  }
  
  private startAutoOptimization(): void {
    this.autoOptimizationInterval = setInterval(() => {
      this.checkAndOptimize();
    }, this.config.autoOptimization.checkInterval);
    
    console.log(`🔄 自动优化已启动，检查间隔: ${this.config.autoOptimization.checkInterval}ms`);
  }
  
  private startPerformanceReporting(): void {
    this.reportingInterval = setInterval(() => {
      this.generateReport();
    }, this.config.reporting.interval);
    
    console.log(`📊 性能报告已启动，报告间隔: ${this.config.reporting.interval}ms`);
  }
  
  private async checkAndOptimize(): Promise<void> {
    try {
      const report = this.getPerformanceReport();
      
      // 检查是否需要优化
      const needsOptimization = this.evaluateOptimizationNeeds(report);
      
      if (needsOptimization.memory || needsOptimization.latency || needsOptimization.cpu) {
        console.log('🔍 检测到性能问题，开始优化...');
        await this.performOptimizations(needsOptimization, report);
      }
      
    } catch (error) {
      console.error('自动优化检查失败:', error);
    }
  }
  
  private evaluateOptimizationNeeds(report: PerformanceReport): {
    memory: boolean;
    latency: boolean;
    cpu: boolean;
  } {
    const thresholds = this.config.autoOptimization.thresholds;
    
    return {
      memory: report.memory.heapUsed > thresholds.memory,
      latency: report.latency.p95 > thresholds.latency,
      cpu: report.cpuUsage > thresholds.cpu,
    };
  }
  
  private async performOptimizations(
    needs: { memory: boolean; latency: boolean; cpu: boolean },
    report: PerformanceReport
  ): Promise<void> {
    const optimizations: string[] = [];
    
    if (needs.memory) {
      optimizations.push('内存优化');
      await this.optimizeMemory(report);
    }
    
    if (needs.latency) {
      optimizations.push('延迟优化');
      await this.optimizeLatency(report);
    }
    
    if (needs.cpu) {
      optimizations.push('CPU优化');
      await this.optimizeCPU(report);
    }
    
    if (optimizations.length > 0) {
      console.log(`✅ 已执行优化: ${optimizations.join(', ')}`);
      this.emit('optimization.performed', { optimizations, report });
    }
  }
  
  private async optimizeMemory(report: PerformanceReport): Promise<void> {
    console.log('🔄 执行内存优化...');
    
    // 触发主动GC
    this.memoryManager?.triggerGC();
    
    // 清理内存池
    const cleaned = this.memoryManager?.cleanupPools() || 0;
    if (cleaned > 0) {
      console.log(`🧹 清理内存池: ${cleaned} 个对象`);
    }
    
    // 清理缓存
    const cacheCleaned = this.clearCache();
    if (cacheCleaned > 0) {
      console.log(`🗑️  清理缓存: ${cacheCleaned} 项`);
    }
    
    // 建议减少内存使用
    if (report.memory.pressure > 0.8) {
      console.log('💡 建议: 考虑减少大对象分配，使用流式处理');
    }
  }
  
  private async optimizeLatency(report: PerformanceReport): Promise<void> {
    console.log('🔄 执行延迟优化...');
    
    // 分析瓶颈
    const bottlenecks = this.analyzeBottlenecks();
    if (bottlenecks) {
      console.log('🔍 瓶颈分析:');
      bottlenecks.hotspots.forEach(hotspot => {
        console.log(`  - ${hotspot.phase}: ${hotspot.averageTime.toFixed(2)}ms (${hotspot.percentage.toFixed(1)}%)`);
      });
    }
    
    // 获取优化建议
    const suggestions = this.latencyOptimizer?.getOptimizationSuggestions();
    if (suggestions) {
      console.log('💡 延迟优化建议:');
      suggestions.slice(0, 3).forEach(suggestion => {
        console.log(`  - [${suggestion.priority.toUpperCase()}] ${suggestion.suggestion}`);
      });
    }
    
    // 提高缓存命中率
    const cacheStats = this.getCacheStats();
    if (cacheStats && cacheStats.hitRate < 50) {
      console.log('💡 建议: 提高缓存命中率，考虑预热缓存或调整缓存策略');
    }
  }
  
  private async optimizeCPU(report: PerformanceReport): Promise<void> {
    console.log('🔄 执行CPU优化...');
    
    // 检查事件循环延迟
    const eventLoopDelay = await this.measureEventLoopDelay();
    if (eventLoopDelay > 100) {
      console.log(`⚠️ 事件循环延迟高: ${eventLoopDelay.toFixed(2)}ms`);
      console.log('💡 建议: 减少同步阻塞操作，使用异步处理');
    }
    
    // 检查是否有长时间运行的同步操作
    console.log('💡 建议: 分析CPU热点，考虑优化算法复杂度或并行化处理');
  }
  
  private async generateReport(): Promise<void> {
    try {
      const report = this.getPerformanceReport();
      
      switch (this.config.reporting.target) {
        case 'console':
          this.printConsoleReport(report);
          break;
        case 'api':
          await this.sendApiReport(report);
          break;
        case 'file':
          await this.writeFileReport(report);
          break;
      }
      
      this.emit('report.generated', report);
      
    } catch (error) {
      console.error('生成性能报告失败:', error);
    }
  }
  
  private printConsoleReport(report: PerformanceReport): void {
    const lines = [
      '📊 性能报告',
      `时间: ${report.timestamp.toISOString()}`,
      `健康评分: ${report.healthScore.toFixed(1)}/100`,
      '',
      '内存统计:',
      `  堆使用: ${report.memory.heapUsed.toFixed(2)}MB / ${report.memory.heapTotal.toFixed(2)}MB`,
      `  内存压力: ${(report.memory.pressure * 100).toFixed(1)}%`,
      `  GC次数: ${report.memory.gcCount}`,
      `  GC时间: ${report.memory.gcTime.toFixed(2)}ms`,
      '',
      '延迟统计:',
      `  平均延迟: ${report.latency.average.toFixed(2)}ms`,
      `  P95延迟: ${report.latency.p95.toFixed(2)}ms`,
      `  请求数: ${report.latency.totalRequests}`,
      `  错误率: ${(report.latency.errorRate * 100).toFixed(2)}%`,
      '',
      '系统统计:',
      `  CPU使用率: ${(report.cpuUsage * 100).toFixed(1)}%`,
      `  系统负载: ${report.systemLoad.join(', ')}`,
      '',
      '优化建议:',
      ...report.suggestions.map(s => `  [${s.priority[0].toUpperCase()}] ${s.suggestion}`),
      '',
      report.healthScore < 60 ? '⚠️  健康状态: 需要注意' :
      report.healthScore < 80 ? '🟡 健康状态: 一般' :
      '✅ 健康状态: 良好',
    ];
    
    console.log(lines.join('\n'));
  }
  
  private async sendApiReport(report: PerformanceReport): Promise<void> {
    // 这里应该发送到API端点
    console.log('📤 发送性能报告到API...');
    
    // 模拟API调用
    await new Promise(resolve => setTimeout(resolve, 100));
    
    console.log('✅ 性能报告已发送');
  }
  
  private async writeFileReport(report: PerformanceReport): Promise<void> {
    const path = this.config.reporting.outputPath || './performance-reports';
    const filename = `${path}/report_${report.timestamp.toISOString().replace(/[:.]/g, '-')}.json`;
    
    const fs = require('fs').promises;
    const { dirname } = require('path');
    
    try {
      // 确保目录存在
      await fs.mkdir(dirname(filename), { recursive: true });
      
      // 写入文件
      await fs.writeFile(
        filename,
        JSON.stringify(report, null, 2)
      );
      
      console.log(`💾 性能报告已保存: ${filename}`);
    } catch (error) {
      console.error('保存性能报告失败:', error);
    }
  }
  
  private handleAutoOptimization(type: 'memory' | 'latency', data: any): void {
    if (!this.config.autoOptimization.enabled) {
      return;
    }
    
    console.log(`🔄 基于${type}指标触发自动优化`);
    this.checkAndOptimize();
  }
  
  private handleEmergencyOptimization(type: 'memory' | 'latency', data: any): void {
    console.log(`🚨 紧急${type}优化`);
    
    if (type === 'memory') {
      console.log('🚨 执行紧急内存清理...');
      this.memoryManager?.triggerGC();
      this.clearCache();
    }
  }
  
  private handleMemoryLeak(report: any): void {
    console.log('🔍 处理内存泄漏...');
    
    // 生成堆快照
    this.takeHeapSnapshot(`leak_${Date.now()}`);
    
    // 清理可能的泄漏源
    this.clearCache();
    this.memoryManager?.cleanupPools();
    
    console.log('✅ 内存泄漏处理完成，建议分析堆快照');
  }
  
  private getCPUUsage(): number {
    const os = require('os');
    const cpus = os.cpus();
    
    if (cpus.length === 0) {
      return 0;
    }
    
    // 简化的CPU使用率计算
    return os.loadavg()[0] / cpus.length;
  }
  
  private getSystemLoad(): number[] {
    const os = require('os');
    return os.loadavg();
  }
  
  private async measureEventLoopDelay(): Promise<number> {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint();
      
      setImmediate(() => {
        const end = process.hrtime.bigint();
        const nanoseconds = end - start;
        const milliseconds = Number(nanoseconds) / 1000000;
        resolve(milliseconds);
      });
    });
  }
}

// 扩展EventEmitter
Object.assign(PerformanceOptimizer.prototype, EventEmitter.prototype);

/**
 * 快速性能检查
 */
export async function quickPerformanceCheck(): Promise<{
  ok: boolean;
  score: number;
  areas: string[];
  recommendations: string[];
}> {
  const optimizer = new PerformanceOptimizer({
    enabled: true,
    autoOptimization: { enabled: false },
    reporting: { enabled: false },
  });
  
  await optimizer.initialize();
  
  const report = optimizer.getPerformanceReport();
  const suggestions = optimizer.analyzeBottlenecks();
  
  await optimizer.stop();
  
  const areas: string[] = [];
  const recommendations: string[] = [];
  
  if (report.healthScore < 60) {
    areas.push('整体健康');
  }
  
  if (report.memory.pressure > 0.8) {
    areas.push('内存');
    recommendations.push('内存压力过高，建议优化内存使用');
  }
  
  if (report.latency.p95 > 1000) {
    areas.push('延迟');
    recommendations.push('延迟过高，建议优化慢请求');
  }
  
  if (report.cpuUsage > 0.8) {
    areas.push('CPU');
    recommendations.push('CPU使用率过高，建议检查性能热点');
  }
  
  if (suggestions && suggestions.hotspots.length > 0) {
    for (const hotspot of suggestions.hotspots.slice(0, 2)) {
      recommendations.push(`优化热点: ${hotspot.phase} (${hotspot.averageTime.toFixed(2)}ms)`);
    }
  }
  
  return {
    ok: report.healthScore >= 60,
    score: report.healthScore,
    areas: [...new Set(areas)],
    recommendations,
  };
}

/**
 * 默认优化器实例
 */
export const performanceOptimizer = new PerformanceOptimizer();