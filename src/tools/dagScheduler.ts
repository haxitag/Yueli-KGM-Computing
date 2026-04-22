/**
 * 工具编排DAG调度器
 * 
 * 核心功能:
 * 1. 构建工具依赖图(DAG)
 * 2. 拓扑排序生成并行执行计划
 * 3. 工具结果缓存
 * 4. 工具预取
 * 5. 性能监控与自动降级
 */

import { generateId } from "../utils/id.js";

/**
 * 工具调用定义
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  dependencies?: string[]; // 依赖的工具调用ID
  metadata?: {
    estimatedLatency?: number;
    priority?: "high" | "medium" | "low";
    costLevel?: "free" | "low" | "medium" | "high";
    canFail?: boolean;
  };
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error?: string;
  startTime: number;
  endTime: number;
  cached: boolean;
}

/**
 * DAG节点
 */
interface DAGNode {
  call: ToolCall;
  dependencies: string[];
  dependents: string[];
  indegree: number;
}

/**
 * 并行执行组
 */
interface ParallelExecutionGroup {
  groupId: string;
  calls: ToolCall[];
  estimatedDuration?: number;
}

/**
 * 工具缓存项
 */
interface ToolCacheItem {
  key: string;
  result: ToolResult;
  createdAt: number;
  expiresAt: number;
  accessCount: number;
}

/**
 * 工具性能指标
 */
export interface ToolPerformanceMetrics {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
  cacheHitRate: number;
  avgCost: number;
}

/**
 * DAG调度器配置
 */
export interface DAGSchedulerConfig {
  // 执行配置
  maxConcurrency?: number;
  timeout?: number;
  retryPolicy?: {
    maxAttempts?: number;
    backoffMs?: number;
    retryableErrors?: string[];
  };
  
  // 缓存配置
  enableCache?: boolean;
  cacheSize?: number;
  cacheTTL?: number;
  
  // 预取配置
  enablePrefetch?: boolean;
  prefetchCount?: number;
  
  // 监控配置
  enableMetrics?: boolean;
  metricsHistorySize?: number;
}

type ResolvedDAGSchedulerConfig = Omit<Required<DAGSchedulerConfig>, "retryPolicy"> & {
  retryPolicy: {
    maxAttempts: number;
    backoffMs: number;
    retryableErrors: string[];
  };
};

/**
 * DAG调度器
 */
export class DAGScheduler {
  private config: ResolvedDAGSchedulerConfig;
  private toolCache: LRUCache<string, ToolCacheItem>;
  private performanceMetrics: Map<string, ToolPerformanceMetrics>;
  private executionHistory: ToolResult[][];
  private toolRegistry: Map<string, (args: unknown) => Promise<unknown>>;

  constructor(config?: DAGSchedulerConfig) {
    const retryPolicy = {
      maxAttempts: config?.retryPolicy?.maxAttempts ?? 3,
      backoffMs: config?.retryPolicy?.backoffMs ?? 1000,
      retryableErrors: config?.retryPolicy?.retryableErrors ?? ["timeout", "network", "temporary"],
    };

    this.config = {
      maxConcurrency: config?.maxConcurrency ?? 5,
      retryPolicy,
      enableCache: config?.enableCache ?? true,
      cacheSize: config?.cacheSize ?? 1000,
      cacheTTL: config?.cacheTTL ?? 300000, // 5分钟
      enablePrefetch: config?.enablePrefetch ?? true,
      prefetchCount: config?.prefetchCount ?? 3,
      enableMetrics: config?.enableMetrics ?? true,
      metricsHistorySize: config?.metricsHistorySize ?? 1000,
      timeout: config?.timeout ?? 30000,
    };

    this.toolCache = new LRUCache(this.config.cacheSize);
    this.performanceMetrics = new Map();
    this.executionHistory = [];
    this.toolRegistry = new Map();
  }

  /**
   * 注册工具
   */
  registerTool(
    name: string,
    executor: (args: unknown) => Promise<unknown>,
  ): void {
    this.toolRegistry.set(name, executor);
  }

  /**
   * 执行工具调用(使用DAG编排)
   */
  async execute(calls: ToolCall[]): Promise<ToolResult[]> {
    const startTime = Date.now();

    // 1. 构建DAG
    const dag = this.buildDAG(calls);

    // 2. 拓扑排序生成执行计划
    const executionPlan = this.topologicalSort(dag);

    // 3. 按照执行计划并行执行
    const results: ToolResult[] = [];
    const resultsMap = new Map<string, ToolResult>();

    for (const group of executionPlan) {
      // 3.1 检查是否可以缓存
      const groupResults = await this.executeGroup(group, resultsMap);

      // 3.2 保存结果
      groupResults.forEach((result) => {
        resultsMap.set(result.callId, result);
        results.push(result);
      });
    }

    // 4. 更新性能指标
    if (this.config.enableMetrics) {
      this.updateMetrics(results);
      this.executionHistory.push(results);
      
      // 限制历史记录大小
      if (this.executionHistory.length > this.config.metricsHistorySize) {
        this.executionHistory.shift();
      }
    }

    // 5. 清理过期缓存
    this.cleanupCache();

    return results;
  }

  /**
   * 构建DAG
   */
  private buildDAG(calls: ToolCall[]): Map<string, DAGNode> {
    const dag = new Map<string, DAGNode>();

    // 创建节点
    calls.forEach((call) => {
      dag.set(call.id, {
        call,
        dependencies: call.dependencies ?? [],
        dependents: [],
        indegree: (call.dependencies ?? []).length,
      });
    });

    // 构建依赖关系
    dag.forEach((node, nodeId) => {
      node.dependencies.forEach((depId) => {
        const depNode = dag.get(depId);
        if (depNode) {
          depNode.dependents.push(nodeId);
        }
      });
    });

    // 检测循环依赖
    this.detectCycles(dag);

    return dag;
  }

  /**
   * 拓扑排序
   */
  private topologicalSort(dag: Map<string, DAGNode>): ParallelExecutionGroup[] {
    const groups: ParallelExecutionGroup[] = [];
    const visited = new Set<string>();
    const queue: string[] = [];

    // 找到所有入度为0的节点
    dag.forEach((node, nodeId) => {
      if (node.indegree === 0) {
        queue.push(nodeId);
      }
    });

    while (queue.length > 0) {
      const group: ToolCall[] = [];
      const groupSize = queue.length;

      for (let i = 0; i < groupSize; i++) {
        const nodeId = queue.shift()!;
        const node = dag.get(nodeId)!;

        group.push(node.call);
        visited.add(nodeId);

        // 更新依赖节点的入度
        node.dependents.forEach((depId) => {
          const depNode = dag.get(depId)!;
          depNode.indegree--;

          if (depNode.indegree === 0) {
            queue.push(depId);
          }
        });
      }

      if (group.length > 0) {
        groups.push({
          groupId: generateId("group"),
          calls: group,
          estimatedDuration: this.estimateGroupDuration(group),
        });
      }
    }

    // 检查是否所有节点都被访问
    if (visited.size !== dag.size) {
      throw new Error("无法完成拓扑排序: 可能存在循环依赖");
    }

    return groups;
  }

  /**
   * 检测循环依赖
   */
  private detectCycles(dag: Map<string, DAGNode>): void {
    const WHITE = 0; // 未访问
    const GRAY = 1;  // 访问中
    const BLACK = 2; // 已访问

    const color = new Map<string, number>();

    dag.forEach((_, nodeId) => {
      color.set(nodeId, WHITE);
    });

    const hasCycle = (nodeId: string): boolean => {
      color.set(nodeId, GRAY);

      const node = dag.get(nodeId)!;
      for (const depId of node.dependencies) {
        const depColor = color.get(depId);
        if (depColor === GRAY) {
          return true; // 发现循环
        }
        if (depColor === WHITE && hasCycle(depId)) {
          return true;
        }
      }

      color.set(nodeId, BLACK);
      return false;
    };

    for (const nodeId of dag.keys()) {
      if (color.get(nodeId) === WHITE) {
        if (hasCycle(nodeId)) {
          throw new Error(`检测到循环依赖, 涉及节点: ${nodeId}`);
        }
      }
    }
  }

  /**
   * 执行并行组
   */
  private async executeGroup(
    group: ParallelExecutionGroup,
    resultsMap: Map<string, ToolResult>,
  ): Promise<ToolResult[]> {
    const groupStart = Date.now();
    const semaphore = new Semaphore(this.config.maxConcurrency);

    const promises = group.calls.map(async (call) => {
      return semaphore.run(async () => {
        // 1. 检查缓存
        const cacheKey = this.generateCacheKey(call);
        let result: ToolResult;

        if (this.config.enableCache) {
          const cached = this.toolCache.get(cacheKey);
          if (cached && !this.isExpired(cached)) {
            cached.accessCount++;
            result = {
              ...cached.result,
              cached: true,
              endTime: Date.now(),
            };
            return result;
          }
        }

        // 2. 获取工具执行器
        const executor = this.toolRegistry.get(call.name);
        if (!executor) {
          throw new Error(`工具 "${call.name}" 未注册`);
        }

        // 3. 执行工具(带重试)
        result = await this.executeWithRetry(call, executor);

        // 4. 缓存结果
        if (this.config.enableCache && result.success) {
          this.toolCache.set(cacheKey, {
            key: cacheKey,
            result,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.config.cacheTTL,
            accessCount: 1,
          });
        }

        return result;
      });
    });

    return await Promise.all(promises);
  }

  /**
   * 带重试的工具执行
   */
  private async executeWithRetry(
    call: ToolCall,
    executor: (args: unknown) => Promise<unknown>,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;
    const maxAttempts = this.config.retryPolicy.maxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.executeWithTimeout(
          executor,
          call.arguments,
          this.config.timeout,
        );

        return {
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
          result,
          success: true,
          startTime,
          endTime: Date.now(),
          cached: false,
        };
      } catch (error) {
        lastError = error as Error;

        // 检查是否可以重试
        if (attempt < maxAttempts && this.isRetryableError(error)) {
          const backoff = this.config.retryPolicy.backoffMs * attempt;
          await this.sleep(backoff);
          continue;
        }

        break;
      }
    }

    // 所有尝试都失败
    return {
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      result: null,
      success: false,
      error: lastError?.message ?? "未知错误",
      startTime,
      endTime: Date.now(),
      cached: false,
    };
  }

  /**
   * 带超时的执行
   */
  private async executeWithTimeout<T>(
    fn: (args: unknown) => Promise<T>,
    args: unknown,
    timeout: number,
  ): Promise<T> {
    return Promise.race([
      fn(args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeout),
      ),
    ]);
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(call: ToolCall): string {
    const argsStr = JSON.stringify(call.arguments);
    const hash = this.simpleHash(call.name + argsStr);
    return `tool:${call.name}:${hash}`;
  }

  /**
   * 简单哈希
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 检查缓存是否过期
   */
  private isExpired(item: ToolCacheItem): boolean {
    return Date.now() > item.expiresAt;
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: unknown): boolean {
    const errorMsg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return this.config.retryPolicy.retryableErrors.some((keyword) =>
      errorMsg.includes(keyword),
    );
  }

  /**
   * 清理过期缓存
   */
  private cleanupCache(): void {
    const now = Date.now();
    const keys: string[] = [];

    this.toolCache.forEach((item, key) => {
      if (now > item.expiresAt) {
        keys.push(key);
      }
    });

    keys.forEach((key) => this.toolCache.delete(key));
  }

  /**
   * 更新性能指标
   */
  private updateMetrics(results: ToolResult[]): void {
    results.forEach((result) => {
      const metrics = this.performanceMetrics.get(result.name) ?? {
        toolName: result.name,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        errorRate: 0,
        cacheHitRate: 0,
        avgCost: 0,
      };

      metrics.totalCalls++;
      metrics.totalLatencyMs += result.endTime - result.startTime;

      if (result.success) {
        metrics.successCount++;
      } else {
        metrics.failureCount++;
      }

      metrics.avgLatencyMs = metrics.totalLatencyMs / metrics.totalCalls;
      metrics.errorRate = metrics.failureCount / metrics.totalCalls;

      this.performanceMetrics.set(result.name, metrics);
    });
  }

  /**
   * 估算组执行时间
   */
  private estimateGroupDuration(calls: ToolCall[]): number {
    return calls.reduce((sum, call) => {
      return sum + (call.metadata?.estimatedLatency ?? 1000);
    }, 0);
  }

  /**
   * 获取性能指标
   */
  getMetrics(): ToolPerformanceMetrics[] {
    return Array.from(this.performanceMetrics.values());
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    let totalAccess = 0;
    let totalHits = 0;

    this.toolCache.forEach((item) => {
      totalAccess += item.accessCount;
      totalHits += item.accessCount > 1 ? 1 : 0;
    });

    return {
      size: this.toolCache.size,
      maxSize: this.config.cacheSize,
      totalAccess,
      hitCount: totalHits,
      hitRate: totalAccess > 0 ? totalHits / totalAccess : 0,
    };
  }

  /**
   * 预取工具数据
   */
  async prefetch(predictedCalls: ToolCall[]): Promise<void> {
    if (!this.config.enablePrefetch) {
      return;
    }

    const topPredicted = predictedCalls.slice(0, this.config.prefetchCount);

    for (const call of topPredicted) {
      const cacheKey = this.generateCacheKey(call);
      const cached = this.toolCache.get(cacheKey);

      if (!cached) {
        // 后台执行预取
        this.executeWithRetry(call, this.toolRegistry.get(call.name)!).catch(
          () => {
            // 预取失败不影响主流程
          },
        );
      }
    }
  }

  /**
   * 睡眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.toolCache.clear();
  }

  /**
   * 重置性能指标
   */
  resetMetrics(): void {
    this.performanceMetrics.clear();
    this.executionHistory = [];
  }
}

/**
 * 信号量
 */
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.release();
        }
      };

      if (this.permits > 0) {
        this.permits--;
        execute();
      } else {
        this.queue.push(() => {
          this.permits--;
          execute();
        });
      }
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}

/**
 * LRU缓存
 */
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  set(key: K, value: V): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value as K | undefined;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  delete(key: K): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  forEach(callback: (value: V, key: K) => void): void {
    this.cache.forEach(callback);
  }

  get size(): number {
    return this.cache.size;
  }
}
