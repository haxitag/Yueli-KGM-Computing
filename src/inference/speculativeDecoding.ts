/**
 * Speculative Decoding - 推测性解码
 * 使用小模型快速生成候选 token，大模型验证
 * 理论加速: 2-3 倍
 */

import { EventEmitter } from "node:events";

interface DraftModel {
  id: string;
  generate(prompt: string, maxTokens: number): Promise<string[]>;
  getTokenProbability(token: string, context: string): number | Promise<number>;
}

interface TargetModel {
  id: string;
  verify(tokens: string[], context: string): Promise<{
    accepted: number;
    corrected: string[];
    rejected: number;
  }>;
}

interface SpeculativeConfig {
  maxDraftTokens: number; // 最大 draft token 数
  acceptanceThreshold: number; // 接受概率阈值
  temperature: number;
  useProbabilityChecking: boolean;
}

interface SpeculativeStats {
  totalSpeculations: number;
  avgAcceptedTokens: number;
  avgDraftTokens: number;
  acceptanceRate: number;
  speedup: number;
}

/**
 * Speculative Decoding Engine
 * 核心算法:
 * 1. Draft model 快速生成 K 个 token
 * 2. Target model 并行验证 K 个 token
 * 3. 接受匹配的 token，从第一个不匹配处继续
 */
export class SpeculativeDecoding extends EventEmitter {
  private draftModel: DraftModel;
  private targetModel: TargetModel;
  private config: Required<SpeculativeConfig>;
  private stats: SpeculativeStats = {
    totalSpeculations: 0,
    avgAcceptedTokens: 0,
    avgDraftTokens: 0,
    acceptanceRate: 0,
    speedup: 0,
  };

  constructor(
    draftModel: DraftModel,
    targetModel: TargetModel,
    config: Partial<SpeculativeConfig> = {}
  ) {
    super();
    this.draftModel = draftModel;
    this.targetModel = targetModel;
    this.config = {
      maxDraftTokens: config.maxDraftTokens ?? 5,
      acceptanceThreshold: config.acceptanceThreshold ?? 0.6,
      temperature: config.temperature ?? 1.0,
      useProbabilityChecking: config.useProbabilityChecking ?? true,
    };
  }

  /**
   * 执行推测性解码
   */
  async *generate(
    prompt: string,
    maxTokens: number
  ): AsyncIterable<{ token: string; isDraft: boolean }> {
    let remainingTokens = maxTokens;
    let currentContext = prompt;
    let totalDrafted = 0;
    let totalAccepted = 0;

    this.emit("generationStarted", { prompt, maxTokens });

    while (remainingTokens > 0) {
      const speculationStart = Date.now();

      // 1. Draft model 生成候选 token
      const draftTokens = await this.draft(
        currentContext,
        Math.min(this.config.maxDraftTokens, remainingTokens)
      );
      totalDrafted += draftTokens.length;

      this.emit("draftGenerated", {
        tokens: draftTokens,
        count: draftTokens.length,
      });

      // 2. Target model 验证
      const verification = await this.verify(draftTokens, currentContext);
      totalAccepted += verification.accepted;

      // 3. 输出接受的 token
      for (let i = 0; i < verification.accepted; i++) {
        yield { token: draftTokens[i], isDraft: false };
        currentContext += draftTokens[i];
        remainingTokens--;

        if (remainingTokens <= 0) break;
      }

      // 4. 处理被拒绝的情况
      if (verification.rejected > 0) {
        // 输出 target model 修正的第一个 token
        if (verification.corrected.length > 0) {
          yield { token: verification.corrected[0], isDraft: false };
          currentContext += verification.corrected[0];
          remainingTokens--;
        }
      }

      // 5. 如果没有接受任何 token，fallback 到标准生成
      if (verification.accepted === 0 && verification.corrected.length === 0) {
        // 标准单步生成
        const singleToken = await this.standardGenerate(currentContext);
        yield { token: singleToken, isDraft: false };
        currentContext += singleToken;
        remainingTokens--;
      }

      // 6. 更新统计
      this.updateStats(
        draftTokens.length,
        verification.accepted,
        Date.now() - speculationStart
      );

      this.emit("speculationComplete", {
        drafted: draftTokens.length,
        accepted: verification.accepted,
        rejected: verification.rejected,
      });

      // 检查停止条件
      if (this.shouldStop(draftTokens)) {
        break;
      }
    }

    this.emit("generationComplete", {
      totalDrafted,
      totalAccepted,
      acceptanceRate: totalAccepted / totalDrafted,
    });
  }

  /**
   * Draft 阶段
   */
  private async draft(context: string, numTokens: number): Promise<string[]> {
    // 调用 draft model 生成候选 token
    return this.draftModel.generate(context, numTokens);
  }

  /**
   * 验证阶段
   */
  private async verify(
    draftTokens: string[],
    context: string
  ): Promise<{
    accepted: number;
    corrected: string[];
    rejected: number;
  }> {
    if (!this.config.useProbabilityChecking) {
      // 简单验证: target model 并行检查所有 token
      return this.targetModel.verify(draftTokens, context);
    }

    // 概率检查: 更激进的策略
    let accepted = 0;
    let currentContext = context;

    for (const draftToken of draftTokens) {
      // 获取 draft model 对该 token 的概率
      const draftProb = await Promise.resolve(
        this.draftModel.getTokenProbability(draftToken, currentContext)
      );

      // 获取 target model 对该 token 的概率
      // 这里简化处理，实际应该调用 target model
      const targetProb = Math.random(); // 模拟

      // 接受概率计算
      const acceptanceProb = Math.min(1, targetProb / (draftProb + 1e-10));

      if (acceptanceProb >= this.config.acceptanceThreshold) {
        accepted++;
        currentContext += draftToken;
      } else {
        break;
      }
    }

    return {
      accepted,
      corrected: accepted < draftTokens.length ? [draftTokens[accepted]] : [],
      rejected: draftTokens.length - accepted,
    };
  }

  /**
   * 标准单步生成 (fallback)
   */
  private async standardGenerate(context: string): Promise<string> {
    // 直接调用 target model 生成单个 token
    const result = await this.targetModel.verify([""], context);
    return result.corrected[0] || " ";
  }

  /**
   * 检查是否应该停止生成
   */
  private shouldStop(tokens: string[]): boolean {
    const stopTokens = ["<|endoftext|>", "</s>", "[DONE]"];
    return tokens.some((t) => stopTokens.includes(t));
  }

  /**
   * 更新统计
   */
  private updateStats(
    drafted: number,
    accepted: number,
    timeMs: number
  ): void {
    this.stats.totalSpeculations++;

    const n = this.stats.totalSpeculations;
    this.stats.avgDraftTokens =
      (this.stats.avgDraftTokens * (n - 1) + drafted) / n;
    this.stats.avgAcceptedTokens =
      (this.stats.avgAcceptedTokens * (n - 1) + accepted) / n;
    this.stats.acceptanceRate =
      this.stats.avgAcceptedTokens / this.stats.avgDraftTokens;

    // 估算加速比 (假设 draft 是 target 的 10 倍快)
    const draftCost = 0.1; // 相对时间
    const verifyCost = 1.0; // 相对时间
    const standardCost = 1.0 * drafted; // 串行生成 K 个 token 的时间

    const speculativeCost = draftCost * drafted + verifyCost; // draft + 并行验证
    const expectedAccepted = this.stats.acceptanceRate * drafted;

    this.stats.speedup =
      expectedAccepted > 0 ? standardCost / speculativeCost : 1.0;
  }

  /**
   * 获取统计
   */
  getStats(): SpeculativeStats {
    return { ...this.stats };
  }

  /**
   * 调整配置
   */
  updateConfig(config: Partial<SpeculativeConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit("configUpdated", this.config);
  }

  /**
   * 预热 draft model
   */
  async warmup(prompt: string): Promise<void> {
    // 预热 draft model，加载到内存/显存
    await this.draftModel.generate(prompt, 1);
    this.emit("warmupComplete");
  }
}

/**
 * 简化的 Draft Model 实现
 * 可以是更小的模型 (1B-3B)
 */
export class SimpleDraftModel implements DraftModel {
  id: string;
  private vocabulary: string[];

  constructor(id = "draft-1b") {
    this.id = id;
    // 简化的词汇表
    this.vocabulary = [
      " the",
      " a",
      " is",
      " of",
      " and",
      " to",
      " in",
      " that",
      " have",
      " it",
      " for",
      " not",
      " on",
      " with",
      " he",
      " as",
      " you",
      " do",
      " at",
      " this",
    ];
  }

  async generate(prompt: string, maxTokens: number): Promise<string[]> {
    // 模拟快速生成
    const tokens: string[] = [];

    for (let i = 0; i < maxTokens; i++) {
      // 基于 prompt 的简单启发式选择
      const seed = prompt.length + i;
      const index = seed % this.vocabulary.length;
      tokens.push(this.vocabulary[index]);
    }

    // 模拟延迟 (很快)
    await new Promise((resolve) => setTimeout(resolve, 1));

    return tokens;
  }

  async getTokenProbability(token: string, context: string): Promise<number> {
    // 模拟概率
    const index = this.vocabulary.indexOf(token);
    if (index === -1) return 0.01;
    return 0.5 + Math.random() * 0.5;
  }
}

/**
 * 简化的 Target Model 实现
 * 实际中会是 7B/13B/70B 大模型
 */
export class SimpleTargetModel implements TargetModel {
  id: string;

  constructor(id = "target-7b") {
    this.id = id;
  }

  async verify(
    tokens: string[],
    context: string
  ): Promise<{
    accepted: number;
    corrected: string[];
    rejected: number;
  }> {
    // 模拟验证过程
    // 实际会并行检查所有 token

    let accepted = 0;
    const corrected: string[] = [];

    for (const token of tokens) {
      // 80% 概率接受 (模拟)
      if (Math.random() > 0.2) {
        accepted++;
      } else {
        // 生成修正的 token
        corrected.push(" " + Math.random().toString(36).substr(2, 5));
        break;
      }
    }

    // 模拟延迟 (较慢，但并行)
    await new Promise((resolve) => setTimeout(resolve, 10));

    return {
      accepted,
      corrected,
      rejected: tokens.length - accepted,
    };
  }
}

// 全局单例和便捷函数
export async function speculativeGenerate(
  draftModel: DraftModel,
  targetModel: TargetModel,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const decoder = new SpeculativeDecoding(draftModel, targetModel);

  let result = "";
  for await (const { token } of decoder.generate(prompt, maxTokens)) {
    result += token;
  }

  return result;
}

export const globalSpeculativeDecoding = new SpeculativeDecoding(
  new SimpleDraftModel(),
  new SimpleTargetModel()
);
