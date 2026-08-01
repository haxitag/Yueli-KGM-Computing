import type { ModelRecord } from "./registry.js";
import { generateId } from "../utils/id.js";
import type { LlmClient, CompletionOptions, CompletionResult } from "../llm/client.js";
import type { ConfigStore } from "../core/configStore.js";

export type PerformanceMetric = {
  /** 响应时间（毫秒） */
  responseTimeMs: number;
  /** token吞吐量（tokens/秒） */
  throughputTokensPerSecond: number;
  /** 错误率（0-1） */
  errorRate: number;
  /** 成本（美元） */
  cost: number;
  /** 准确率（0-1） */
  accuracy: number;
  /** 有用性评分（0-1） */
  usefulness: number;
  /** 创新性评分（0-1） */
  creativity: number;
  /** 一致性评分（0-1） */
  consistency: number;
};

export type PerformanceRecord = {
  /** 记录ID */
  id: string;
  /** 模型名称 */
  modelName: string;
  /** 指标 */
  metrics: PerformanceMetric;
  /** 任务类型 */
  taskType: string;
  /** 评估时间 */
  timestamp: string;
  /** 输入提示 */
  inputPrompt: string;
  /** 模型输出 */
  modelOutput: string;
  /** 人工评估（可选） */
  humanRating?: number;
  /** 评估上下文 */
  evaluationContext?: string;
};

export type PerformanceBenchmark = {
  /** 基准测试ID */
  id: string;
  /** 基准测试名称 */
  name: string;
  /** 基准测试描述 */
  description: string;
  /** 测试任务类型 */
  taskType: string;
  /** 测试输入 */
  inputs: string[];
  /** 期望输出（可选，用于准确率评估） */
  expectedOutputs?: string[];
  /** 基准测试创建时间 */
  createdAt: string;
};

export type EvaluationResult = {
  /** 评估结果ID */
  id: string;
  /** 模型名称 */
  modelName: string;
  /** 基准测试ID */
  benchmarkId: string;
  /** 整体评分（0-1） */
  overallScore: number;
  /** 详细指标 */
  metrics: PerformanceMetric;
  /** 评估时间 */
  timestamp: string;
  /** 评估备注 */
  notes?: string;
};

export type AutoEvaluationConfig = {
  /** 是否启用自动评估 */
  enabled: boolean;
  /** 评估频率（分钟） */
  evaluationIntervalMinutes: number;
  /** 最小评估间隔（毫秒） */
  minEvaluationIntervalMs: number;
  /** 自动评估的基准测试ID列表 */
  benchmarkIds: string[];
  /** 评估时使用的任务类型 */
  taskTypes: string[];
  /** 评估样本数量 */
  sampleSize: number;
  /** 是否保存详细日志 */
  saveDetailedLogs: boolean;
};

export type ScoringStrategy = {
  name: string;
  scoreAccuracy?(output: string, expected: string | undefined): number | Promise<number>;
  scoreUsefulness?(output: string, taskType: string): number | Promise<number>;
  scoreCreativity?(output: string, taskType: string): number | Promise<number>;
  scoreConsistency?(outputs: string[]): number | Promise<number>;
};

export type BenchmarkExecutorConfig = {
  llmClient: LlmClient;
  configStore?: ConfigStore;
  scoringStrategy?: ScoringStrategy;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export type ModelInvocationResult = {
  output: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  raw: unknown;
};

export interface BenchmarkExecutor {
  invokeModel(modelName: string, prompt: string, options?: CompletionOptions): Promise<ModelInvocationResult>;
  scoreOutput(output: string, taskType: string, expectedOutput?: string): Promise<PerformanceMetric>;
}

export class RealBenchmarkExecutor implements BenchmarkExecutor {
  private llmClient: LlmClient;
  private configStore?: ConfigStore;
  private scoringStrategy: ScoringStrategy;
  private maxTokens: number;
  private temperature: number;
  private timeoutMs: number;

  constructor(config: BenchmarkExecutorConfig) {
    this.llmClient = config.llmClient;
    this.configStore = config.configStore;
    this.scoringStrategy = config.scoringStrategy ?? this.defaultScoringStrategy();
    this.maxTokens = config.maxTokens ?? 1024;
    this.temperature = config.temperature ?? 0.7;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  async invokeModel(modelName: string, prompt: string, options?: CompletionOptions): Promise<ModelInvocationResult> {
    const startTime = Date.now();
    const config = this.configStore?.get();
    const modelConfig = config?.llm;
    const costPerToken = this.estimateCost(modelName, modelConfig);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const result = await this.llmClient.complete(prompt, {
        ...options,
        model: options?.model ?? modelName,
        maxTokens: options?.maxTokens ?? this.maxTokens,
        temperature: options?.temperature ?? this.temperature,
        signal: controller.signal,
      });

      const endTime = Date.now();
      const latencyMs = endTime - startTime;
      const { promptTokens, completionTokens, totalTokens } = this.estimateTokens(result.text, prompt);

      return {
        output: result.text,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        cost: (promptTokens * costPerToken.input + completionTokens * costPerToken.output) / 1000,
        raw: result.raw,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async scoreOutput(output: string, taskType: string, expectedOutput?: string): Promise<PerformanceMetric> {
    const strategy = this.scoringStrategy;

    let accuracy = 0;
    let usefulness = 0.5;
    let creativity = 0.5;
    let consistency = 1;

    if (strategy.scoreAccuracy && expectedOutput) {
      accuracy = await strategy.scoreAccuracy(output, expectedOutput);
    } else if (expectedOutput) {
      accuracy = this.calculateAccuracy(output, expectedOutput);
    }

    if (strategy.scoreUsefulness) {
      usefulness = await strategy.scoreUsefulness(output, taskType);
    }

    if (strategy.scoreCreativity) {
      creativity = await strategy.scoreCreativity(output, taskType);
    }

    if (strategy.scoreConsistency) {
      consistency = await strategy.scoreConsistency([output]);
    }

    return {
      responseTimeMs: 0,
      throughputTokensPerSecond: 0,
      errorRate: 0,
      cost: 0,
      accuracy,
      usefulness,
      creativity,
      consistency,
    };
  }

  private defaultScoringStrategy(): ScoringStrategy {
    return {
      name: "default",
      scoreAccuracy: (output: string, expected?: string) => {
        if (!expected) return 0;
        return this.calculateAccuracy(output, expected);
      },
      scoreUsefulness: (output: string, _taskType: string) => {
        const length = output.length;
        if (length < 10) return 0.1;
        if (length < 50) return 0.3;
        if (length < 200) return 0.6;
        if (length < 500) return 0.8;
        return 0.9;
      },
      scoreCreativity: (output: string, _taskType: string) => {
        const uniqueWords = new Set(output.split(/\s+/)).size;
        const totalWords = output.split(/\s+/).length;
        const diversity = totalWords > 0 ? uniqueWords / totalWords : 0;
        const hasEmoji = /[\u{1F300}-\u{1F9FF}]/u.test(output);
        const hasSpecialChars = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(output);
        return Math.min(1, diversity * 1.2 + (hasEmoji ? 0.1 : 0) + (hasSpecialChars ? 0.1 : 0));
      },
      scoreConsistency: (outputs: string[]) => {
        if (outputs.length < 2) return 1;
        return 1 - this.levenshteinDistance(outputs[0], outputs[1]) / Math.max(outputs[0].length, outputs[1].length);
      },
    };
  }

  private estimateCost(modelName: string, config?: { model?: string; provider?: string }): { input: number; output: number } {
    const modelLower = (modelName ?? "").toLowerCase();
    const providerLower = (config?.provider ?? "").toLowerCase();

    if (modelLower.includes("gpt-4o") || modelLower.includes("gpt-4-turbo")) {
      return { input: 0.005, output: 0.015 };
    }
    if (modelLower.includes("gpt-4") || modelLower.includes("gpt-4o-mini")) {
      return { input: 0.01, output: 0.03 };
    }
    if (modelLower.includes("gpt-3.5")) {
      return { input: 0.0005, output: 0.0015 };
    }
    if (modelLower.includes("claude-3-5-sonnet") || modelLower.includes("claude-3-5")) {
      return { input: 0.003, output: 0.015 };
    }
    if (modelLower.includes("claude-3-opus")) {
      return { input: 0.015, output: 0.075 };
    }
    if (modelLower.includes("claude-3-haiku")) {
      return { input: 0.00025, output: 0.00125 };
    }
    if (modelLower.includes("claude-3-sonnet") || modelLower.includes("claude-3")) {
      return { input: 0.003, output: 0.015 };
    }
    if (providerLower.includes("anthropic")) {
      return { input: 0.003, output: 0.015 };
    }
    if (providerLower.includes("openai")) {
      return { input: 0.001, output: 0.002 };
    }
    return { input: 0.001, output: 0.002 };
  }

  private estimateTokens(text: string, prompt: string): { promptTokens: number; completionTokens: number; totalTokens: number } {
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(text.length / 4);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private calculateAccuracy(actual: string, expected: string): number {
    const actualLower = actual.toLowerCase();
    const expectedLower = expected.toLowerCase();
    if (actualLower === expectedLower) return 1;
    if (actualLower.includes(expectedLower) || expectedLower.includes(actualLower)) return 0.8;
    const distance = this.levenshteinDistance(actualLower, expectedLower);
    const maxLength = Math.max(actualLower.length, expectedLower.length);
    if (maxLength === 0) return 1;
    return Math.max(0, 1 - (distance / maxLength));
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator
        );
      }
    }
    return matrix[str2.length][str1.length];
  }
}

export class ModelPerformanceMonitor {
  private records: PerformanceRecord[] = [];
  private benchmarks: Map<string, PerformanceBenchmark> = new Map();
  private evaluationResults: EvaluationResult[] = [];
  private autoConfig: AutoEvaluationConfig;
  private lastEvaluationTime: number = 0;
  private executor: BenchmarkExecutor | null = null;

  constructor(config?: Partial<AutoEvaluationConfig>) {
    this.autoConfig = {
      enabled: config?.enabled ?? true,
      evaluationIntervalMinutes: config?.evaluationIntervalMinutes ?? 60,
      minEvaluationIntervalMs: config?.minEvaluationIntervalMs ?? 300000, // 5分钟
      benchmarkIds: config?.benchmarkIds ?? [],
      taskTypes: config?.taskTypes ?? ['general', 'reasoning', 'generation'],
      sampleSize: config?.sampleSize ?? 10,
      saveDetailedLogs: config?.saveDetailedLogs ?? true,
    };
  }

  /**
   * 注册基准测试执行器
   */
  registerExecutor(executor: BenchmarkExecutor): void {
    this.executor = executor;
  }

  /**
   * 获取已注册的执行器
   */
  getExecutor(): BenchmarkExecutor | null {
    return this.executor;
  }

  /**
   * 检查是否已注册执行器
   */
  hasExecutor(): boolean {
    return this.executor !== null;
  }

  /**
   * 记录单次模型调用的性能
   */
  recordPerformance(modelName: string, input: string, output: string, metrics: PerformanceMetric, taskType: string = 'general'): void {
    const record: PerformanceRecord = {
      id: generateId(),
      modelName,
      metrics,
      taskType,
      timestamp: new Date().toISOString(),
      inputPrompt: input,
      modelOutput: output,
    };

    this.records.push(record);
    
    // 只保留最近1000条记录以节省内存
    if (this.records.length > 1000) {
      this.records = this.records.slice(-1000);
    }
  }

  /**
   * 注册基准测试
   */
  registerBenchmark(benchmark: PerformanceBenchmark): void {
    this.benchmarks.set(benchmark.id, benchmark);
  }

  /**
   * 获取基准测试
   */
  getBenchmark(benchmarkId: string): PerformanceBenchmark | undefined {
    return this.benchmarks.get(benchmarkId);
  }

  /**
   * 运行基准测试
   */
  async runBenchmark(modelName: string, benchmarkId: string): Promise<EvaluationResult> {
    const benchmark = this.benchmarks.get(benchmarkId);
    if (!benchmark) {
      throw new Error(`Benchmark not found: ${benchmarkId}`);
    }

    if (!this.executor) {
      throw new Error(
        `benchmark_executor_not_registered:${modelName}:${benchmarkId}. Register a BenchmarkExecutor using registerExecutor() before running benchmarks.`,
      );
    }

    const results: PerformanceMetric[] = [];
    const outputs: string[] = [];

    for (let i = 0; i < benchmark.inputs.length; i++) {
      const input = benchmark.inputs[i];
      const expected = benchmark.expectedOutputs?.[i];

      const invocationResult = await this.executor.invokeModel(modelName, input);
      const scoredMetrics = await this.executor.scoreOutput(invocationResult.output, benchmark.taskType, expected);

      results.push({
        ...scoredMetrics,
        responseTimeMs: invocationResult.latencyMs,
        throughputTokensPerSecond: invocationResult.totalTokens > 0
          ? (invocationResult.completionTokens / invocationResult.latencyMs) * 1000
          : 0,
        cost: invocationResult.cost,
        errorRate: 0,
      });

      outputs.push(invocationResult.output);
    }

    const avgMetrics = this.averageMetrics(results);

    const evaluationResult: EvaluationResult = {
      id: generateId(),
      modelName,
      benchmarkId,
      overallScore: this.calculateOverallScore(avgMetrics),
      metrics: avgMetrics,
      timestamp: new Date().toISOString(),
    };

    this.evaluationResults.push(evaluationResult);

    if (this.autoConfig.saveDetailedLogs) {
      for (let i = 0; i < benchmark.inputs.length; i++) {
        this.recordPerformance(
          modelName,
          benchmark.inputs[i],
          outputs[i],
          results[i],
          benchmark.taskType
        );
      }
    }

    return evaluationResult;
  }

  private averageMetrics(metricsList: PerformanceMetric[]): PerformanceMetric {
    if (metricsList.length === 0) {
      return {
        responseTimeMs: 0,
        throughputTokensPerSecond: 0,
        errorRate: 0,
        cost: 0,
        accuracy: 0,
        usefulness: 0,
        creativity: 0,
        consistency: 0,
      };
    }

    const count = metricsList.length;
    return {
      responseTimeMs: metricsList.reduce((sum, m) => sum + m.responseTimeMs, 0) / count,
      throughputTokensPerSecond: metricsList.reduce((sum, m) => sum + m.throughputTokensPerSecond, 0) / count,
      errorRate: metricsList.reduce((sum, m) => sum + m.errorRate, 0) / count,
      cost: metricsList.reduce((sum, m) => sum + m.cost, 0) / count,
      accuracy: metricsList.reduce((sum, m) => sum + m.accuracy, 0) / count,
      usefulness: metricsList.reduce((sum, m) => sum + m.usefulness, 0) / count,
      creativity: metricsList.reduce((sum, m) => sum + m.creativity, 0) / count,
      consistency: metricsList.reduce((sum, m) => sum + m.consistency, 0) / count,
    };
  }

  private calculateOverallScore(metrics: PerformanceMetric): number {
    return (
      metrics.accuracy * 0.3 +
      metrics.usefulness * 0.25 +
      metrics.consistency * 0.2 +
      metrics.creativity * 0.1 +
      Math.max(0, 1 - metrics.responseTimeMs / 10000) * 0.1 +
      Math.max(0, 1 - metrics.cost / 10) * 0.05
    );
  }

  /**
   * 计算输出准确性
   */
  private calculateAccuracy(actual: string, expected: string): number {
    // 简单的准确性计算，实际应用中可能需要更复杂的NLP技术
    const actualLower = actual.toLowerCase();
    const expectedLower = expected.toLowerCase();
    
    // 计算编辑距离作为相似度的基础
    const distance = this.levenshteinDistance(actualLower, expectedLower);
    const maxLength = Math.max(actualLower.length, expectedLower.length);
    
    if (maxLength === 0) return 1;
    
    return 1 - (distance / maxLength);
  }

  /**
   * 计算编辑距离
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) {
      matrix[0][i] = i;
    }

    for (let j = 0; j <= str2.length; j++) {
      matrix[j][0] = j;
    }

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1, // insertion
          matrix[j - 1][i] + 1, // deletion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * 获取模型的历史性能统计
   */
  getModelPerformanceStats(modelName: string, taskType?: string, hoursBack: number = 24): PerformanceMetric | null {
    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
    const relevantRecords = this.records.filter(record => {
      const recordTime = new Date(record.timestamp).getTime();
      return record.modelName === modelName && 
             recordTime >= cutoffTime &&
             (!taskType || record.taskType === taskType);
    });

    if (relevantRecords.length === 0) {
      return null;
    }

    // 计算平均指标
    const stats: PerformanceMetric = {
      responseTimeMs: 0,
      throughputTokensPerSecond: 0,
      errorRate: 0,
      cost: 0,
      accuracy: 0,
      usefulness: 0,
      creativity: 0,
      consistency: 0,
    };

    relevantRecords.forEach(record => {
      stats.responseTimeMs += record.metrics.responseTimeMs;
      stats.throughputTokensPerSecond += record.metrics.throughputTokensPerSecond;
      stats.errorRate += record.metrics.errorRate;
      stats.cost += record.metrics.cost;
      stats.accuracy += record.metrics.accuracy;
      stats.usefulness += record.metrics.usefulness;
      stats.creativity += record.metrics.creativity;
      stats.consistency += record.metrics.consistency;
    });

    const count = relevantRecords.length;
    stats.responseTimeMs /= count;
    stats.throughputTokensPerSecond /= count;
    stats.errorRate /= count;
    stats.cost /= count;
    stats.accuracy /= count;
    stats.usefulness /= count;
    stats.creativity /= count;
    stats.consistency /= count;

    return stats;
  }

  /**
   * 获取模型排名
   */
  getModelRankings(taskType: string = 'general', hoursBack: number = 24): Array<{
    modelName: string;
    averageScore: number;
    sampleSize: number;
    metrics: PerformanceMetric;
  }> {
    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
    const relevantRecords = this.records.filter(record => {
      const recordTime = new Date(record.timestamp).getTime();
      return recordTime >= cutoffTime && 
             (!taskType || record.taskType === taskType);
    });

    if (relevantRecords.length === 0) {
      return [];
    }

    // 按模型分组
    const modelGroups = new Map<string, PerformanceRecord[]>();
    relevantRecords.forEach(record => {
      if (!modelGroups.has(record.modelName)) {
        modelGroups.set(record.modelName, []);
      }
      modelGroups.get(record.modelName)!.push(record);
    });

    // 计算每个模型的平均得分
    const rankings = Array.from(modelGroups.entries()).map(([modelName, records]) => {
      // 计算平均指标
      const avgMetrics: PerformanceMetric = {
        responseTimeMs: 0,
        throughputTokensPerSecond: 0,
        errorRate: 0,
        cost: 0,
        accuracy: 0,
        usefulness: 0,
        creativity: 0,
        consistency: 0,
      };

      records.forEach(record => {
        avgMetrics.responseTimeMs += record.metrics.responseTimeMs;
        avgMetrics.throughputTokensPerSecond += record.metrics.throughputTokensPerSecond;
        avgMetrics.errorRate += record.metrics.errorRate;
        avgMetrics.cost += record.metrics.cost;
        avgMetrics.accuracy += record.metrics.accuracy;
        avgMetrics.usefulness += record.metrics.usefulness;
        avgMetrics.creativity += record.metrics.creativity;
        avgMetrics.consistency += record.metrics.consistency;
      });

      const count = records.length;
      avgMetrics.responseTimeMs /= count;
      avgMetrics.throughputTokensPerSecond /= count;
      avgMetrics.errorRate /= count;
      avgMetrics.cost /= count;
      avgMetrics.accuracy /= count;
      avgMetrics.usefulness /= count;
      avgMetrics.creativity /= count;
      avgMetrics.consistency /= count;

      // 计算综合得分
      const averageScore = (
        avgMetrics.accuracy * 0.3 +
        avgMetrics.usefulness * 0.25 +
        avgMetrics.consistency * 0.2 +
        (1 - avgMetrics.responseTimeMs / 10000) * 0.15 + // 响应时间越短越好
        avgMetrics.creativity * 0.1
      );

      return {
        modelName,
        averageScore: Math.min(averageScore, 1), // 确保不超过1
        sampleSize: count,
        metrics: avgMetrics
      };
    });

    // 按综合得分排序
    return rankings.sort((a, b) => b.averageScore - a.averageScore);
  }

  /**
   * 获取最新的评估结果
   */
  getLatestEvaluationResults(modelName?: string, benchmarkId?: string): EvaluationResult[] {
    let results = this.evaluationResults;
    
    if (modelName) {
      results = results.filter(r => r.modelName === modelName);
    }
    
    if (benchmarkId) {
      results = results.filter(r => r.benchmarkId === benchmarkId);
    }
    
    // 按时间倒序排列
    return results.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /**
   * 检查是否需要进行自动评估
   */
  shouldRunAutoEvaluation(): boolean {
    if (!this.autoConfig.enabled) {
      return false;
    }

    const now = Date.now();
    return (now - this.lastEvaluationTime) >= (this.autoConfig.evaluationIntervalMinutes * 60 * 1000);
  }

  /**
   * 运行自动评估
   */
  async runAutoEvaluation(): Promise<EvaluationResult[]> {
    if (!this.autoConfig.enabled || !this.shouldRunAutoEvaluation()) {
      return [];
    }

    const results: EvaluationResult[] = [];
    
    // 为每个注册的基准测试运行评估
    for (const benchmarkId of this.autoConfig.benchmarkIds) {
      void benchmarkId;
    }

    this.lastEvaluationTime = Date.now();
    
    // 只保留最近的评估结果
    if (this.evaluationResults.length > 100) {
      this.evaluationResults = this.evaluationResults.slice(-100);
    }
    
    return results;
  }

  /**
   * 获取性能趋势
   */
  getPerformanceTrend(modelName: string, metric: keyof PerformanceMetric, hoursBack: number = 24): Array<{
    timestamp: string;
    value: number;
  }> {
    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
    const relevantRecords = this.records
      .filter(record => {
        const recordTime = new Date(record.timestamp).getTime();
        return record.modelName === modelName && recordTime >= cutoffTime;
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return relevantRecords.map(record => ({
      timestamp: record.timestamp,
      value: record.metrics[metric] as number
    }));
  }
}
