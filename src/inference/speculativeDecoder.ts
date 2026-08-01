/**
 * Speculative Decoding实现
 * 使用Draft Model生成候选token,然后由Main Model验证
 */

/**
 * Speculative Decoding配置
 */
export type SpeculativeDecodingConfig = {
  /** Draft Model的tokens数 (默认4) */
  draftTokens: number;
  /** 最小接受率,低于此值禁用speculative decoding (默认0.7) */
  minAcceptanceRate: number;
  /** 最大连续失败次数 (默认5) */
  maxConsecutiveFailures: number;
  /** 是否启用自适应draft tokens (默认true) */
  adaptiveDraftTokens: boolean;
  /** Draft Model预热步数 (默认3) */
  warmupSteps: number;
};

/**
 * Token验证结果
 */
export type TokenValidationResult = {
  accepted: boolean;
  token?: number;
  acceptCount: number;
  draftCount: number;
};

/**
 * Speculative Decoder
 */
export class SpeculativeDecoder {
  private config: SpeculativeDecodingConfig;
  private consecutiveFailures = 0;
  private acceptanceHistory: number[] = [];
  private enabled = true;
  private stepCount = 0;

  constructor(config?: Partial<SpeculativeDecodingConfig>) {
    this.config = {
      draftTokens: 4,
      minAcceptanceRate: 0.7,
      maxConsecutiveFailures: 5,
      adaptiveDraftTokens: true,
      warmupSteps: 3,
      ...config,
    };
  }

  /**
   * 生成候选tokens (Draft Model)
   */
  async generateDraftTokens(
    draftModel: {
      generate: (prompt: string, maxTokens: number) => Promise<number[]>;
    },
    prompt: string,
    contextTokens: number[],
  ): Promise<number[]> {
    if (!this.enabled) {
      return [];
    }

    // 计算自适应draft tokens数量
    const draftCount = this.computeAdaptiveDraftTokens();

    // 使用draft model生成候选tokens
    const draftTokens = await draftModel.generate(prompt, draftCount);

    return draftTokens;
  }

  /**
   * 验证候选tokens (Main Model)
   */
  async validateDraftTokens(
    mainModel: {
      generateOne: (prompt: string, contextTokens: number[]) => Promise<number>;
    },
    prompt: string,
    contextTokens: number[],
    draftTokens: number[],
  ): Promise<TokenValidationResult> {
    let acceptCount = 0;
    let acceptedTokens: number[] = [];

    for (let i = 0; i < draftTokens.length; i++) {
      const currentContext = [...contextTokens, ...acceptedTokens];
      const draftToken = draftTokens[i];

      // Main Model生成一个token
      const mainToken = await mainModel.generateOne(prompt, currentContext);

      if (mainToken === draftToken) {
        // 接受这个draft token
        acceptedTokens.push(draftToken);
        acceptCount++;
      } else {
        // 拒绝,使用main model的token
        acceptedTokens.push(mainToken);
        break;
      }
    }

    // 如果还有draft tokens被拒绝,main model生成一个token
    if (acceptCount < draftTokens.length) {
      const currentContext = [...contextTokens, ...acceptedTokens];
      const mainToken = await mainModel.generateOne(prompt, currentContext);
      if (acceptedTokens.length > 0 && acceptedTokens[acceptedTokens.length - 1] !== mainToken) {
        acceptedTokens.push(mainToken);
      }
    }

    const result: TokenValidationResult = {
      accepted: acceptCount > 0,
      token: acceptedTokens[0],
      acceptCount,
      draftCount: draftTokens.length,
    };

    // 更新统计
    this.updateStats(result);

    return result;
  }

  /**
   * 执行speculative decoding的一步
   */
  async decodeStep(
    draftModel: {
      generate: (prompt: string, maxTokens: number) => Promise<number[]>;
    },
    mainModel: {
      generateOne: (prompt: string, contextTokens: number[]) => Promise<number>;
    },
    prompt: string,
    contextTokens: number[],
  ): Promise<{ token: number; accepted: boolean; speedup: number }> {
    this.stepCount++;

    // 预热阶段,不使用speculative decoding
    if (this.stepCount <= this.config.warmupSteps) {
      const token = await mainModel.generateOne(prompt, contextTokens);
      return { token, accepted: false, speedup: 1.0 };
    }

    // 检查是否启用
    if (!this.enabled) {
      const token = await mainModel.generateOne(prompt, contextTokens);
      return { token, accepted: false, speedup: 1.0 };
    }

    try {
      // 1. Draft Model生成候选tokens
      const draftTokens = await this.generateDraftTokens(draftModel, prompt, contextTokens);

      if (draftTokens.length === 0) {
        const token = await mainModel.generateOne(prompt, contextTokens);
        return { token, accepted: false, speedup: 1.0 };
      }

      // 2. Main Model验证
      const validationResult = await this.validateDraftTokens(
        mainModel,
        prompt,
        contextTokens,
        draftTokens,
      );

      // 计算加速比
      const speedup = this.computeSpeedup(validationResult);

      return {
        token: validationResult.accepted ? validationResult.token : undefined!,
        accepted: validationResult.accepted,
        speedup,
      };
    } catch (error) {
      console.error("Speculative decoding error:", error);
      // 回退到普通生成
      const token = await mainModel.generateOne(prompt, contextTokens);
      return { token, accepted: false, speedup: 1.0 };
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(result: TokenValidationResult): void {
    if (result.draftCount > 0) {
      const acceptanceRate = result.acceptCount / result.draftCount;
      this.acceptanceHistory.push(acceptanceRate);

      // 只保留最近100次
      if (this.acceptanceHistory.length > 100) {
        this.acceptanceHistory.shift();
      }

      // 更新连续失败计数
      if (acceptanceRate < this.config.minAcceptanceRate) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
          this.enabled = false;
          console.warn("Speculative decoding disabled due to low acceptance rate");
        }
      } else {
        this.consecutiveFailures = 0;
      }
    }
  }

  /**
   * 计算自适应draft tokens数量
   */
  private computeAdaptiveDraftTokens(): number {
    if (!this.config.adaptiveDraftTokens) {
      return this.config.draftTokens;
    }

    // 基于历史接受率调整draft tokens数量
    if (this.acceptanceHistory.length < 10) {
      return this.config.draftTokens;
    }

    const avgAcceptanceRate =
      this.acceptanceHistory.reduce((sum, rate) => sum + rate, 0) / this.acceptanceHistory.length;

    // 根据接受率调整
    if (avgAcceptanceRate > 0.9) {
      return Math.min(this.config.draftTokens * 2, 8); // 接受率高,增加draft tokens
    } else if (avgAcceptanceRate > 0.7) {
      return this.config.draftTokens; // 接受率中等,保持不变
    } else {
      return Math.max(this.config.draftTokens / 2, 2); // 接受率低,减少draft tokens
    }
  }

  /**
   * 计算加速比
   */
  private computeSpeedup(result: TokenValidationResult): number {
    if (result.draftCount === 0) {
      return 1.0;
    }

    // 理论加速比: draft tokens + 1 (main model最后生成一个token)
    // 实际加速比取决于接受率
    const theoreticalSpeedup = result.draftCount + 1;
    const actualSpeedup = 1 + result.acceptCount;

    return actualSpeedup / theoreticalSpeedup;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    enabled: boolean;
    stepCount: number;
    consecutiveFailures: number;
    avgAcceptanceRate: number;
    avgSpeedup: number;
    acceptanceHistory: number[];
  } {
    const avgAcceptanceRate =
      this.acceptanceHistory.length > 0
        ? this.acceptanceHistory.reduce((sum, rate) => sum + rate, 0) / this.acceptanceHistory.length
        : 0;

    return {
      enabled: this.enabled,
      stepCount: this.stepCount,
      consecutiveFailures: this.consecutiveFailures,
      avgAcceptanceRate,
      avgSpeedup: avgAcceptanceRate * this.config.draftTokens + 1,
      acceptanceHistory: [...this.acceptanceHistory],
    };
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.consecutiveFailures = 0;
    this.acceptanceHistory = [];
    this.enabled = true;
    this.stepCount = 0;
  }

  /**
   * 启用speculative decoding
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * 禁用speculative decoding
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SpeculativeDecodingConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Draft Model接口
 */
export interface IDraftModel {
  /**
   * 生成候选tokens
   */
  generate(prompt: string, maxTokens: number): Promise<number[]>;

  /**
   * 生成单个token
   */
  generateOne(prompt: string, contextTokens: number[]): Promise<number>;
}

/**
 * Main Model接口
 */
export interface IMainModel {
  /**
   * 生成单个token
   */
  generateOne(prompt: string, contextTokens: number[]): Promise<number>;

  /**
   * 批量生成tokens (用于验证)
   */
  generateBatch(prompt: string, contextTokens: number[], count: number): Promise<number[]>;
}

/**
 * Speculative Decoding包装器
 */
export class SpeculativeDecodingWrapper {
  private decoder: SpeculativeDecoder;
  private draftModel: IDraftModel;
  private mainModel: IMainModel;

  constructor(draftModel: IDraftModel, mainModel: IMainModel, config?: Partial<SpeculativeDecodingConfig>) {
    this.draftModel = draftModel;
    this.mainModel = mainModel;
    this.decoder = new SpeculativeDecoder(config);
  }

  /**
   * 生成完整文本
   */
  async generate(prompt: string, maxTokens: number): Promise<{ text: string; stats: any }> {
    const contextTokens: number[] = [];
    const generatedTokens: number[] = [];
    let totalSpeedup = 0;
    let stepCount = 0;

    for (let i = 0; i < maxTokens; i++) {
      const result = await this.decoder.decodeStep(
        this.draftModel,
        this.mainModel,
        prompt,
        contextTokens,
      );

      if (result.token !== undefined) {
        contextTokens.push(result.token);
        generatedTokens.push(result.token);
      } else {
        break;
      }

      totalSpeedup += result.speedup;
      stepCount++;
    }

    const stats = {
      ...this.decoder.getStats(),
      avgSpeedup: totalSpeedup / stepCount,
    };

    // 简化实现,直接返回tokens
    return {
      text: generatedTokens.join(" "),
      stats,
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return this.decoder.getStats();
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.decoder.resetStats();
  }

  /**
   * 启用
   */
  enable() {
    this.decoder.enable();
  }

  /**
   * 禁用
   */
  disable() {
    this.decoder.disable();
  }
}
