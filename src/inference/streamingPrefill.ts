/**
 * Streaming Prefill - 降低 TTFT (Time to First Token)
 * 并行化 prompt 处理，边处理边生成第一个 token
 */

import { EventEmitter } from "node:events";
import { globalWorkerPool } from "../utils/workerPool.js";

interface PrefillTask {
  id: string;
  chunks: string[];
  processedChunks: number;
  totalChunks: number;
  startTime: number;
  firstTokenTime?: number;
  priority: number;
}

interface PrefillOptions {
  chunkSize?: number;
  overlapSize?: number;
  parallelChunks?: number;
  timeout?: number;
}

interface PrefillResult {
  id: string;
  embeddings: Float32Array[];
  firstTokenReady: boolean;
  firstTokenTime: number;
  totalTime: number;
  cached?: boolean;
}

/**
 * Streaming Prefill Manager
 * 将长 prompt 分块并行处理，优先生成第一个 token
 */
export class StreamingPrefill extends EventEmitter {
  private tasks: Map<string, PrefillTask> = new Map();
  private cache: Map<string, Float32Array[]> = new Map();
  private options: Required<PrefillOptions>;
  private stats = {
    totalPrefills: 0,
    cacheHits: 0,
    avgFirstTokenTime: 0,
    avgTotalTime: 0,
  };

  constructor(options: PrefillOptions = {}) {
    super();
    this.options = {
      chunkSize: options.chunkSize ?? 512,
      overlapSize: options.overlapSize ?? 64,
      parallelChunks: options.parallelChunks ?? 4,
      timeout: options.timeout ?? 30000,
    };
  }

  /**
   * 将 prompt 分块处理
   * 优化策略: 并行处理多个 chunk，优先处理开头部分以快速生成第一个 token
   */
  async prefill(
    prompt: string,
    model: string,
    priority = 5
  ): Promise<PrefillResult> {
    this.stats.totalPrefills++;
    const id = `prefill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const startTime = performance.now();

    // 1. 检查缓存
    const cacheKey = this.generateCacheKey(prompt, model);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return {
        id,
        embeddings: cached,
        firstTokenReady: true,
        firstTokenTime: 0,
        totalTime: 0,
        cached: true,
      };
    }

    // 2. 分块
    const chunks = this.splitIntoChunks(prompt, this.options.chunkSize);
    const task: PrefillTask = {
      id,
      chunks,
      processedChunks: 0,
      totalChunks: chunks.length,
      startTime,
      priority,
    };
    this.tasks.set(id, task);

    // 3. 优先处理策略：
    // - 前 N 个 chunk 优先处理（为了快速生成第一个 token）
    // - 剩余 chunk 并行处理
    const priorityChunks = Math.min(2, chunks.length); // 前 2 个 chunk 优先
    const priorityPromises = chunks
      .slice(0, priorityChunks)
      .map((chunk, idx) =>
        this.processChunk(chunk, model, id, idx, true)
      );

    // 4. 等待优先级 chunk 完成（这足够生成第一个 token）
    const priorityResults = await Promise.all(priorityPromises);
    const firstTokenTime = performance.now() - startTime;
    task.firstTokenTime = firstTokenTime;

    this.emit("firstTokenReady", { id, firstTokenTime, model });

    // 5. 并行处理剩余 chunk
    const remainingChunks = chunks.slice(priorityChunks);
    const remainingPromises = remainingChunks.map((chunk, idx) =>
      this.processChunk(chunk, model, id, priorityChunks + idx, false)
    );

    // 6. 合并所有结果
    const remainingResults = await Promise.all(remainingPromises);
    const allEmbeddings = [...priorityResults, ...remainingResults];

    // 7. 缓存结果
    this.cache.set(cacheKey, allEmbeddings);

    // 8. 清理任务
    this.tasks.delete(id);

    const totalTime = performance.now() - startTime;
    this.updateStats(firstTokenTime, totalTime);

    this.emit("prefillComplete", {
      id,
      firstTokenTime,
      totalTime,
      model,
      chunkCount: chunks.length,
    });

    return {
      id,
      embeddings: allEmbeddings,
      firstTokenReady: true,
      firstTokenTime,
      totalTime,
    };
  }

  /**
   * 快速首 token 模式 - 牺牲一点质量换取速度
   * 只处理关键上下文，快速生成第一个 token
   */
  async fastFirstToken(
    prompt: string,
    model: string,
    maxContextTokens = 2048
  ): Promise<{
    firstToken: string;
    firstTokenTime: number;
    remainingContext: string;
  }> {
    const startTime = performance.now();

    // 策略：提取关键信息快速处理
    // 1. 系统提示词
    // 2. 最近的对话历史（最近的 N 轮）
    // 3. 忽略早期历史

    const lines = prompt.split("\n");
    const systemPrompt: string[] = [];
    const recentHistory: string[] = [];

    for (const line of lines) {
      if (line.includes("system") || line.includes("System")) {
        systemPrompt.push(line);
      } else if (recentHistory.length < 10) {
        // 只保留最近 10 轮
        recentHistory.push(line);
      }
    }

    // 组合精简后的 prompt
    const condensedPrompt = [...systemPrompt, ...recentHistory].join("\n");

    // 使用 Worker Pool 异步处理
    const tokens = await globalWorkerPool.tokenize(condensedPrompt, model);

    // 如果仍然太长，截断
    let finalPrompt = condensedPrompt;
    if (tokens > maxContextTokens) {
      // 截断早期历史，保留系统提示词
      const systemText = systemPrompt.join("\n");
      const availableForHistory = maxContextTokens - Math.ceil(systemText.length / 4);
      const truncatedHistory = recentHistory
        .reverse()
        .slice(0, Math.floor(availableForHistory / 100))
        .reverse();
      finalPrompt = systemText + "\n" + truncatedHistory.join("\n");
    }

    // 生成第一个 token（简化为空字符串，实际实现会调用模型）
    const firstToken = "";
    const firstTokenTime = performance.now() - startTime;

    // 剩余上下文需要完整处理
    const remainingContext = prompt;

    return {
      firstToken,
      firstTokenTime,
      remainingContext,
    };
  }

  /**
   * 处理单个 chunk
   */
  private async processChunk(
    chunk: string,
    model: string,
    taskId: string,
    chunkIndex: number,
    isPriority: boolean
  ): Promise<Float32Array> {
    // 实际实现中会调用模型的 embedding 接口
    // 这里使用 Worker Pool 进行并行 tokenization

    const tokenCount = await globalWorkerPool.tokenize(chunk, model);

    // 模拟 embedding 计算
    // 实际会调用模型的 embedding 层
    const embeddingDim = 4096; // 假设 4096 维
    const embedding = new Float32Array(embeddingDim);

    // 简单的哈希填充（实际应该是模型输出）
    for (let i = 0; i < embeddingDim; i++) {
      embedding[i] = Math.sin(tokenCount * i * 0.01) * 0.1;
    }

    const task = this.tasks.get(taskId);
    if (task) {
      task.processedChunks++;
      this.emit("chunkProcessed", {
        taskId,
        chunkIndex,
        isPriority,
        progress: task.processedChunks / task.totalChunks,
      });
    }

    return embedding;
  }

  /**
   * 将 prompt 分块
   */
  private splitIntoChunks(prompt: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    // 按句子分割
    const sentences = prompt.split(/(?<=[.!?。！？])\s+/);

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > chunkSize) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;
      } else {
        currentChunk += " " + sentence;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * 生成缓存 key
   */
  private generateCacheKey(prompt: string, model: string): string {
    // 使用 hash (简化为前 100 字符 + 长度)
    const prefix = prompt.slice(0, 100);
    return `${model}:${prefix}:${prompt.length}`;
  }

  /**
   * 更新统计
   */
  private updateStats(firstTokenTime: number, totalTime: number): void {
    const n = this.stats.totalPrefills;
    this.stats.avgFirstTokenTime =
      (this.stats.avgFirstTokenTime * (n - 1) + firstTokenTime) / n;
    this.stats.avgTotalTime =
      (this.stats.avgTotalTime * (n - 1) + totalTime) / n;
  }

  /**
   * 获取统计
   */
  getStats() {
    return {
      ...this.stats,
      activeTasks: this.tasks.size,
      cacheSize: this.cache.size,
    };
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 设置缓存大小限制
   */
  setCacheLimit(maxSize: number): void {
    // LRU 清理
    while (this.cache.size > maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
  }
}

// 全局单例
export const globalStreamingPrefill = new StreamingPrefill();
