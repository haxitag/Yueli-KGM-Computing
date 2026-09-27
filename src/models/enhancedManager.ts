import type { CompletionOptions, CompletionResult, CompletionStreamEvent, LlmClient } from "../llm/client.js";
import type { EnhancedEngineOptions } from "../inference/enhancedEngine.js";
import { EnhancedNativeRuntimeEngine } from "../inference/enhancedEngine.js";
import { generateId } from "../utils/id.js";
import fs from "node:fs";
import path from "node:path";

// 从原ModelManager复用的类型定义
export type ManagedModelRuntime = {
  id: string;
  name: string;
  modelName: string;
  runtime: "native" | "enhanced";
  status: "stopped" | "starting" | "running" | "error";
  artifactId?: string;
  host: string;
  port: number;
  baseUrl: string;
  apiPath: string;
  mode: "chat" | "completions";
  apiKey?: string;
  upstreamModel: string;
  command?: string;
  args?: string[];
  pid?: number;
  maxConcurrentRequests?: number;
  maxQueueSize?: number;
  retryMaxRetries?: number;
  circuitBreakerFailures?: number;
  circuitBreakerCooldownMs?: number;
  healthPath?: string;
  notes: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

export type EnhancedRuntimeStats = {
  runtimeId: string;
  modelName: string;
  prefixCache: {
    hitRate: number;
    memoryBytes: number;
    cacheHits: number;
    cacheMisses: number;
  };
  scheduler: {
    totalRequests: number;
    completedRequests: number;
    avgLatencyMs: number;
    avgThroughputTokensPerSec: number;
    avgQueueWaitMs: number;
  };
  kvCache: {
    utilization: number;
    sharedBlocks: number;
    usedMemoryBytes: number;
  };
};

/**
 * 增强型模型管理器
 * 支持增强推理引擎的所有特性
 */
export class EnhancedModelManager {
  private statePath: string;
  private state: {
    runtimes: ManagedModelRuntime[];
  };
  private enhancedEngines = new Map<string, EnhancedNativeRuntimeEngine>();

  constructor(options?: { statePath?: string }) {
    this.statePath = path.resolve(
      options?.statePath ?? process.env.KGM_MODEL_STATE_PATH ?? "data/models/enhanced-catalog.json"
    );
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    this.state = this.loadState();
  }

  /**
   * 创建增强runtime
   */
  createEnhancedRuntime(
    modelName: string,
    modelPath: string,
    options: EnhancedEngineOptions = {}
  ): ManagedModelRuntime {
    const id = generateId("ert");
    const name = `enhanced-${modelName}`;
    const port = this.getAvailablePort();

    const runtime: ManagedModelRuntime = {
      id,
      name,
      modelName,
      runtime: "enhanced",
      status: "stopped",
      host: "127.0.0.1",
      port,
      baseUrl: `http://127.0.0.1:${port}/enhanced`,
      apiPath: "/v1/chat/completions",
      mode: "chat",
      upstreamModel: modelName,
      maxConcurrentRequests: options.continuousBatchingMaxBatchSize ?? 8,
      maxQueueSize: options.continuousBatchingMaxQueueSize ?? 64,
      notes: [
        `Enhanced runtime with:`,
        `- Prefix Cache: ${options.enablePrefixCache ?? true}`,
        `- Continuous Batching: ${options.enableContinuousBatching ?? true}`,
        `- Paged KV Cache: ${options.kvCacheMode ?? "paged"}`,
      ],
      metadata: {
        engineType: "enhanced",
        modelPath,
        options,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.runtimes.push(runtime);
    this.persist();
    return runtime;
  }

  /**
   * 启动增强runtime
   */
  async startEnhancedRuntime(
    id: string,
    options: EnhancedEngineOptions = {}
  ): Promise<ManagedModelRuntime> {
    const runtime = this.requireRuntime(id);

    if (runtime.status === "running") {
      return runtime;
    }

    runtime.status = "starting";
    runtime.lastError = undefined;
    this.patchRuntime(id, { status: "starting" });

    try {
      const modelPath = runtime.metadata.modelPath as string;
      const engine = new EnhancedNativeRuntimeEngine(modelPath, options);

      this.enhancedEngines.set(id, engine);

      this.patchRuntime(id, {
        status: "running",
        healthStatus: engine.isExecutable() ? "healthy" : "degraded",
        notes: [
          ...runtime.notes,
          `Enhanced engine started successfully`,
          `Backend: ${engine.executionBackend()}`,
          `Serving: ${engine.servingBackend()}`,
        ],
      });

      return this.requireRuntime(id);
    } catch (error) {
      const errorMessage = String(error);
      this.patchRuntime(id, {
        status: "error",
        lastError: errorMessage,
      });
      throw new Error(`failed_to_start_enhanced_runtime:${errorMessage}`);
    }
  }

  /**
   * 停止增强runtime
   */
  stopEnhancedRuntime(id: string): ManagedModelRuntime {
    const runtime = this.requireRuntime(id);
    const engine = this.enhancedEngines.get(id);

    if (engine) {
      engine.close();
      this.enhancedEngines.delete(id);
    }

    this.patchRuntime(id, {
      status: "stopped",
      healthStatus: "unknown",
      lastError: undefined,
    });

    return this.requireRuntime(id);
  }

  /**
   * 使用增强runtime完成推理
   */
  async completeWithEnhancedRuntime(
    modelName: string,
    prompt: string,
    options?: CompletionOptions
  ): Promise<CompletionResult | null> {
    const runtime = this.state.runtimes.find(
      (r) => r.modelName === modelName && r.status === "running"
    );

    if (!runtime || runtime.runtime !== "enhanced") {
      return null;
    }

    const engine = this.enhancedEngines.get(runtime.id);
    if (!engine) {
      throw new Error(`enhanced_engine_not_started:${runtime.id}`);
    }

    return engine.complete(prompt, options);
  }

  /**
   * 使用增强runtime流式完成推理
   */
  streamWithEnhancedRuntime(
    modelName: string,
    prompt: string,
    options?: CompletionOptions
  ): AsyncIterable<CompletionStreamEvent> | null {
    const runtime = this.state.runtimes.find(
      (r) => r.modelName === modelName && r.status === "running"
    );

    if (!runtime || runtime.runtime !== "enhanced") {
      return null;
    }

    const engine = this.enhancedEngines.get(runtime.id);
    if (!engine) {
      return null;
    }

    return engine.streamComplete(prompt, options);
  }

  /**
   * 获取增强runtime的统计信息
   */
  getEnhancedStats(id: string): EnhancedRuntimeStats | undefined {
    const runtime = this.getRuntime(id);
    if (!runtime || runtime.runtime !== "enhanced") {
      return undefined;
    }

    const engine = this.enhancedEngines.get(id);
    if (!engine) {
      return undefined;
    }

    const enhancedStats = engine.getEnhancedStats();

    return {
      runtimeId: id,
      modelName: runtime.modelName,
      prefixCache: {
        hitRate: enhancedStats.prefixCache.hitRate,
        memoryBytes: enhancedStats.prefixCache.memoryBytes,
        cacheHits: enhancedStats.prefixCache.cacheHits,
        cacheMisses: enhancedStats.prefixCache.cacheMisses,
      },
      scheduler: enhancedStats.scheduler
        ? {
            totalRequests: enhancedStats.scheduler.totalRequests,
            completedRequests: enhancedStats.scheduler.completedRequests,
            avgLatencyMs: enhancedStats.scheduler.avgLatencyMs,
            avgThroughputTokensPerSec:
              enhancedStats.scheduler.avgThroughputTokensPerSec,
            avgQueueWaitMs: enhancedStats.scheduler.avgQueueWaitMs,
          }
        : {
            totalRequests: 0,
            completedRequests: 0,
            avgLatencyMs: 0,
            avgThroughputTokensPerSec: 0,
            avgQueueWaitMs: 0,
          },
      kvCache: {
        utilization: enhancedStats.kvCache.utilization,
        sharedBlocks: enhancedStats.kvCache.sharedBlocks,
        usedMemoryBytes: enhancedStats.kvCache.usedMemoryBytes,
      },
    };
  }

  /**
   * 获取Prometheus指标
   */
  getEnhancedPrometheusMetrics(): string {
    const lines: string[] = [];

    lines.push("# HELP kgm_enhanced_prefix_cache_hit_rate Prefix cache hit rate.");
    lines.push("# TYPE kgm_enhanced_prefix_cache_hit_rate gauge");
    lines.push("# HELP kgm_enhanced_prefix_cache_memory_bytes Prefix cache memory usage in bytes.");
    lines.push("# TYPE kgm_enhanced_prefix_cache_memory_bytes gauge");
    lines.push("# HELP kgm_enhanced_scheduler_avg_latency_ms Average scheduler latency in ms.");
    lines.push("# TYPE kgm_enhanced_scheduler_avg_latency_ms gauge");
    lines.push("# HELP kgm_enhanced_kv_cache_utilization KV cache utilization ratio (0-1).");
    lines.push("# TYPE kgm_enhanced_kv_cache_utilization gauge");

    for (const runtime of this.state.runtimes.filter((r) => r.runtime === "enhanced")) {
      const stats = this.getEnhancedStats(runtime.id);
      if (!stats) continue;

      const labels = `runtime_id="${runtime.id}",model="${runtime.modelName}"`;

      lines.push(`kgm_enhanced_prefix_cache_hit_rate{${labels}} ${stats.prefixCache.hitRate}`);
      lines.push(`kgm_enhanced_prefix_cache_memory_bytes{${labels}} ${stats.prefixCache.memoryBytes}`);
      lines.push(`kgm_enhanced_scheduler_avg_latency_ms{${labels}} ${stats.scheduler.avgLatencyMs}`);
      lines.push(`kgm_enhanced_kv_cache_utilization{${labels}} ${stats.kvCache.utilization}`);
    }

    return `${lines.join("\n")}\n`;
  }

  /**
   * 列出所有runtimes
   */
  listRuntimes(): ManagedModelRuntime[] {
    return [...this.state.runtimes];
  }

  /**
   * 获取runtime
   */
  getRuntime(id: string): ManagedModelRuntime | undefined {
    return this.state.runtimes.find((r) => r.id === id);
  }

  /**
   * 删除runtime
   */
  deleteRuntime(id: string): boolean {
    const index = this.state.runtimes.findIndex((r) => r.id === id);
    if (index === -1) return false;

    // 停止引擎
    const engine = this.enhancedEngines.get(id);
    if (engine) {
      engine.close();
      this.enhancedEngines.delete(id);
    }

    this.state.runtimes.splice(index, 1);
    this.persist();
    return true;
  }

  /**
   * 保存状态
   */
  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * 加载状态
   */
  private loadState(): { runtimes: ManagedModelRuntime[] } {
    if (!fs.existsSync(this.statePath)) {
      const initial = { runtimes: [] };
      fs.writeFileSync(this.statePath, JSON.stringify(initial, null, 2));
      return initial;
    }
    const raw = fs.readFileSync(this.statePath, "utf8").trim();
    if (!raw) {
      return { runtimes: [] };
    }
    return JSON.parse(raw) as { runtimes: ManagedModelRuntime[] };
  }

  /**
   * 补丁更新runtime
   */
  private patchRuntime(id: string, patch: Partial<ManagedModelRuntime>): void {
    const runtime = this.getRuntime(id);
    if (!runtime) {
      throw new Error(`runtime_not_found:${id}`);
    }
    Object.assign(runtime, patch, { updatedAt: new Date().toISOString() });
    this.persist();
  }

  /**
   * 获取runtime,不存在则抛出错误
   */
  private requireRuntime(id: string): ManagedModelRuntime {
    const runtime = this.getRuntime(id);
    if (!runtime) {
      throw new Error(`runtime_not_found:${id}`);
    }
    return runtime;
  }

  /**
   * 获取可用端口
   */
  private getAvailablePort(): number {
    const usedPorts = new Set(this.state.runtimes.map((r) => r.port));
    for (let port = 9200; port < 9300; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }
    return 9200;
  }

  /**
   * 关闭管理器
   */
  close(): void {
    for (const [id, engine] of this.enhancedEngines) {
      engine.close();
    }
    this.enhancedEngines.clear();
  }
}
