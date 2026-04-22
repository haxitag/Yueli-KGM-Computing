import type { ModelRecord } from "./registry.js";
import type { LlmClient, CompletionResult } from "../llm/client.js";
import type { ContextPack, ToolDefinition } from "../core/types.js";
import { renderPrompt } from "../prompt/renderer.js";

export type VoteType = 'majority' | 'confidence' | 'consensus' | 'expert';

export type MultiModelResult = {
  results: Array<{
    model: string;
    result: CompletionResult;
    timestamp: string;
    executionTimeMs: number;
  }>;
  finalResult: CompletionResult;
  votingMethod?: VoteType;
  consensus?: boolean;
};

export type ParallelExecutionOptions = {
  /** 并行执行超时时间（毫秒） */
  timeoutMs?: number;
  /** 至少需要多少个模型返回结果 */
  minResponses?: number;
  /** 投票类型 */
  voteType?: VoteType;
  /** 是否等待所有模型完成 */
  waitForAll?: boolean;
};

export type VotingCriteria = {
  /** 基于置信度的投票权重 */
  confidenceBased?: boolean;
  /** 基于模型评级的权重 */
  ratingBased?: boolean;
  /** 基于响应一致性的权重 */
  consistencyBased?: boolean;
};

export class MultiModelOrchestrator {
  /**
   * 并行执行多个模型
   */
  async executeParallel(
    models: ModelRecord[],
    context: ContextPack,
    options: ParallelExecutionOptions = {}
  ): Promise<MultiModelResult> {
    const { timeoutMs = 30000, minResponses = 1, waitForAll = false } = options;
    
    // 渲染提示词
    const tools: ToolDefinition[] = []; // 在实际应用中，这里应该获取上下文相关的工具
    const prompt = renderPrompt({ context, tools, outputSchema: {} });

    // 创建执行Promise数组
    const executionPromises = models.map(model => {
      return this.executeModelWithTiming(model.client, prompt, timeoutMs);
    });

    let results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }> = [];

    if (waitForAll) {
      // 等待所有模型完成（或超时）
      const allResults = await Promise.allSettled(executionPromises);
      results = allResults.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          // 如果模型执行失败，返回错误结果
          return {
            model: models[index].config.name,
            result: { text: `Error: ${result.reason}`, raw: { error: result.reason } },
            timestamp: new Date().toISOString(),
            executionTimeMs: timeoutMs,
          };
        }
      }).filter(r => r.result.text && !r.result.text.startsWith('Error'));
    } else {
      // 使用竞态条件，获取最快的结果
      const controller = new AbortController();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Parallel execution timeout')), timeoutMs);
      });

      // 实现一个race，当达到minResponses数量时提前结束
      const responseCount = Math.max(minResponses, 1);
      const completed: typeof results = [];
      let resolved = false;

      // 创建一个promise来追踪完成的请求数量
      const completionPromise = new Promise<MultiModelResult>((resolve) => {
        let completedCount = 0;
        
        executionPromises.forEach((promise, index) => {
          promise.then(result => {
            completed.push(result);
            completedCount++;
            
            if (completedCount >= responseCount && !resolved) {
              resolved = true;
              const finalResult = this.aggregateResults(completed, options);
              resolve(finalResult);
            }
          }).catch(err => {
            console.error(`Model ${models[index].config.name} execution failed:`, err);
            completedCount++;
            
            if (completedCount >= executionPromises.length && !resolved) {
              // 所有请求都已完成，即使有些失败了
              resolved = true;
              const finalResult = this.aggregateResults(completed, options);
              resolve(finalResult);
            }
          });
        });
      });

      // 等待结果或超时
      try {
        return await Promise.race([completionPromise, timeoutPromise]);
      } catch (error) {
        throw new Error(`Parallel execution failed: ${error}`);
      }
    }

    return this.aggregateResults(results, options);
  }

  /**
   * 执行单个模型并记录时间
   */
  private async executeModelWithTiming(
    client: LlmClient,
    prompt: string,
    timeoutMs: number
  ): Promise<{
    model: string;
    result: CompletionResult;
    timestamp: string;
    executionTimeMs: number;
  }> {
    const startTime = Date.now();
    try {
      const result = await client.complete(prompt);
      const endTime = Date.now();
      
      return {
        model: (client as any).model || 'unknown', // 获取模型名的方法取决于具体实现
        result,
        timestamp: new Date().toISOString(),
        executionTimeMs: endTime - startTime,
      };
    } catch (error) {
      const endTime = Date.now();
      throw error;
    }
  }

  /**
   * 聚合多个模型的结果
   */
  private aggregateResults(
    results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }>,
    options: ParallelExecutionOptions
  ): MultiModelResult {
    if (results.length === 0) {
      return {
        results: [],
        finalResult: { text: "No models responded", raw: {} }
      };
    }

    // 如果只有一个结果，直接返回
    if (results.length === 1) {
      return {
        results,
        finalResult: results[0].result
      };
    }

    // 根据投票类型聚合结果
    const voteType = options.voteType || 'majority';
    let finalResult: CompletionResult;

    switch (voteType) {
      case 'majority':
        finalResult = this.majorityVote(results);
        break;
      case 'confidence':
        finalResult = this.confidenceBasedVote(results);
        break;
      case 'consensus':
        const { result, consensus } = this.consensusBasedVote(results);
        finalResult = result;
        break;
      case 'expert':
        finalResult = this.expertBasedVote(results);
        break;
      default:
        finalResult = this.majorityVote(results);
    }

    return {
      results,
      finalResult,
      votingMethod: voteType,
      consensus: voteType === 'consensus' ? this.checkConsensus(results) : undefined
    };
  }

  /**
   * 多数投票
   */
  private majorityVote(
    results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }>
  ): CompletionResult {
    // 统计相同结果的数量
    const resultCounts = new Map<string, number>();
    const resultMap = new Map<string, CompletionResult>();
    
    for (const result of results) {
      const text = result.result.text.trim();
      const count = resultCounts.get(text) || 0;
      resultCounts.set(text, count + 1);
      if (!resultMap.has(text)) {
        resultMap.set(text, result.result);
      }
    }

    // 找到出现次数最多的文本
    let maxCount = 0;
    let majorityText = '';
    
    for (const [text, count] of resultCounts) {
      if (count > maxCount) {
        maxCount = count;
        majorityText = text;
      }
    }

    // 如果没有明显的多数，返回第一个结果
    if (maxCount === 1 && results.length > 1) {
      return results[0].result;
    }

    return resultMap.get(majorityText)!;
  }

  /**
   * 基于置信度的投票
   */
  private confidenceBasedVote(
    results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }>
  ): CompletionResult {
    // 在实际应用中，这里需要分析模型响应中的置信度信息
    // 目前我们基于执行时间和模型能力简单估算
    
    let bestResult = results[0];
    let bestScore = this.calculateConfidenceScore(results[0]);
    
    for (let i = 1; i < results.length; i++) {
      const score = this.calculateConfidenceScore(results[i]);
      if (score > bestScore) {
        bestScore = score;
        bestResult = results[i];
      }
    }
    
    return bestResult.result;
  }

  /**
   * 计算置信度分数
   */
  private calculateConfidenceScore(result: {
    model: string;
    result: CompletionResult;
    timestamp: string;
    executionTimeMs: number;
  }): number {
    // 简单的置信度计算方法
    // 实际应用中可以考虑更多因素，如响应长度、关键词分析等
    const timeFactor = 1 / (result.executionTimeMs / 1000 + 1); // 时间越短分数越高
    const lengthFactor = Math.min(result.result.text.length / 100, 1); // 长度适中为佳
    
    return (timeFactor * 0.3 + lengthFactor * 0.7);
  }

  /**
   * 基于共识的投票
   */
  private consensusBasedVote(
    results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }>
  ): { result: CompletionResult; consensus: boolean } {
    // 检查结果之间的相似性
    const similarResults = this.groupSimilarResults(results);
    
    if (similarResults.length === 1) {
      // 所有结果都相似，达成共识
      return {
        result: similarResults[0].results[0].result,
        consensus: true
      };
    } else {
      // 没有达成共识，返回最长的结果
      const longestResult = results.reduce((prev, current) => 
        prev.result.text.length > current.result.text.length ? prev : current
      );
      
      return {
        result: longestResult.result,
        consensus: false
      };
    }
  }

  /**
   * 检查是否达成共识
   */
  private checkConsensus(
    results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }>
  ): boolean {
    const grouped = this.groupSimilarResults(results);
    return grouped.length === 1;
  }

  /**
   * 将相似结果分组
   */
  private groupSimilarResults(
    results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }>
  ): Array<{ results: typeof results; similarity: number }> {
    if (results.length <= 1) {
      return [{ results, similarity: 1 }];
    }

    // 简单的相似性检查，实际应用中可能需要更复杂的算法
    const groups: Array<{ results: typeof results; similarity: number }> = [];
    
    for (const result of results) {
      let addedToGroup = false;
      
      for (const group of groups) {
        // 检查与组中任一结果的相似性
        for (const groupResult of group.results) {
          if (this.isSimilar(result.result.text, groupResult.result.text)) {
            group.results.push(result);
            addedToGroup = true;
            break;
          }
        }
        if (addedToGroup) break;
      }
      
      if (!addedToGroup) {
        groups.push({ results: [result], similarity: 1 });
      }
    }
    
    return groups;
  }

  /**
   * 检查两个文本是否相似
   */
  private isSimilar(text1: string, text2: string): boolean {
    // 简化的相似性检查
    // 实际应用中可以使用编辑距离、语义相似度等算法
    const normalized1 = text1.toLowerCase().replace(/\s+/g, '');
    const normalized2 = text2.toLowerCase().replace(/\s+/g, '');
    
    // 检查是否包含相同的关键词
    const commonWordsThreshold = 0.6; // 60%的单词相同认为相似
    const words1 = normalized1.split(/[\s\p{P}]+/u).filter(w => w.length > 3);
    const words2 = normalized2.split(/[\s\p{P}]+/u).filter(w => w.length > 3);
    
    if (words1.length === 0 || words2.length === 0) {
      return normalized1 === normalized2;
    }
    
    const commonWords = words1.filter(word => words2.includes(word)).length;
    const maxWords = Math.max(words1.length, words2.length);
    
    return (commonWords / maxWords) >= commonWordsThreshold;
  }

  /**
   * 基于专家模型的投票
   */
  private expertBasedVote(
    results: Array<{
      model: string;
      result: CompletionResult;
      timestamp: string;
      executionTimeMs: number;
    }>
  ): CompletionResult {
    // 在实际应用中，这里会选择特定领域的专家模型
    // 目前我们简单地选择第一个结果
    return results[0].result;
  }

  /**
   * 选举最佳结果（综合多种策略）
   */
  async electBestResult(
    models: ModelRecord[],
    context: ContextPack,
    criteria?: VotingCriteria
  ): Promise<CompletionResult> {
    const results = await this.executeParallel(models, context, {
      waitForAll: true,
      minResponses: models.length
    });

    // 应用多种评判标准
    if (criteria?.confidenceBased) {
      return this.confidenceBasedVote(results.results);
    } else if (criteria?.consistencyBased) {
      const consensusResult = this.consensusBasedVote(results.results);
      if (consensusResult.consensus) {
        return consensusResult.result;
      } else {
        // 如果没有达成共识，使用多数投票
        return this.majorityVote(results.results);
      }
    }

    // 默认使用多数投票
    return this.majorityVote(results.results);
  }
}