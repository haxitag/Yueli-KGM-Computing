import type { MemoryChunk, MemoryStore } from "./store.js";
import type { Evidence } from "../core/types.js";
import { generateId } from "../utils/id.js";

export type DecayFunction = (ageInDays: number, initialImportance: number) => number;

export type MemoryDecayConfig = {
  /** 默认衰减函数 */
  defaultDecayFunction: DecayFunction;
  /** 记忆保留天数 */
  retentionPeriodDays: number;
  /** 衰减评估间隔（小时） */
  evaluationIntervalHours: number;
  /** 重要性阈值（低于此值将被标记为可删除） */
  importanceThreshold: number;
  /** 是否启用软删除（标记而非物理删除） */
  softDeleteEnabled: boolean;
  /** 软删除保留天数 */
  softDeleteRetentionDays: number;
  /** 是否启用访问频率衰减 */
  accessFrequencyDecay: boolean;
  /** 访问频率衰减权重 */
  accessFrequencyWeight: number;
};

export type DecayRule = {
  /** 规则ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 应用的用户ID（可选，如果不指定则应用于所有用户） */
  userId?: string;
  /** 应用的记忆标签（可选） */
  tags?: string[];
  /** 衰减函数 */
  decayFunction: DecayFunction;
  /** 有效期截止日期 */
  expiryDate?: Date;
  /** 是否启用 */
  enabled: boolean;
};

export type DecayResult = {
  /** 已衰减的记忆ID */
  decayedMemoryIds: string[];
  /** 已删除的记忆ID */
  deletedMemoryIds: string[];
  /** 更新的记忆ID */
  updatedMemoryIds: string[];
  /** 衰减详情 */
  details: Array<{
    memoryId: string;
    oldImportance: number;
    newImportance: number;
    action: 'decayed' | 'deleted' | 'updated';
  }>;
};

export type RevocationReason = 
  | 'privacy_request'      // 隐私请求
  | 'accuracy_correction'  // 准确性修正
  | 'outdated'            // 过时
  | 'user_request'        // 用户请求
  | 'policy_violation'    // 策略违规
  | 'duplicate'           // 重复内容
  | 'security'            // 安全原因
  | 'manual_override';    // 手动覆盖

export type RevocationRecord = {
  /** 撤销记录ID */
  id: string;
  /** 被撤销的记忆ID */
  memoryId: string;
  /** 撤销原因 */
  reason: RevocationReason;
  /** 撤销时间 */
  revokedAt: Date;
  /** 撤销人（可选） */
  revokedBy?: string;
  /** 撤销备注 */
  notes?: string;
  /** 是否永久撤销 */
  permanent: boolean;
};

export class MemoryDecayMechanism {
  private store: MemoryStore;
  private config: MemoryDecayConfig;
  private decayRules: DecayRule[] = [];
  private revocationRecords: Map<string, RevocationRecord> = new Map();
  private decayTimer?: NodeJS.Timeout;

  constructor(store: MemoryStore, config?: Partial<MemoryDecayConfig>) {
    this.store = store;
    
    // 设置默认衰减函数（线性衰减，每天降低0.01的重要性）
    const defaultDecayFunction: DecayFunction = (ageInDays, initialImportance) => {
      // 基础衰减：每天减少1%的重要性
      const baseDecay = ageInDays * 0.01;
      // 不让重要性降到0以下
      return Math.max(0, initialImportance - baseDecay);
    };
    
    this.config = {
      defaultDecayFunction: config?.defaultDecayFunction ?? defaultDecayFunction,
      retentionPeriodDays: config?.retentionPeriodDays ?? 365, // 默认保留一年
      evaluationIntervalHours: config?.evaluationIntervalHours ?? 24, // 每天评估一次
      importanceThreshold: config?.importanceThreshold ?? 0.2, // 低于0.2的重要性将被标记
      softDeleteEnabled: config?.softDeleteEnabled ?? true,
      softDeleteRetentionDays: config?.softDeleteRetentionDays ?? 30, // 软删除保留30天
      accessFrequencyDecay: config?.accessFrequencyDecay ?? true,
      accessFrequencyWeight: config?.accessFrequencyWeight ?? 0.1,
    };

    // 启动定期衰减评估
    this.startDecaySchedule();
  }

  /**
   * 启动定期衰减评估
   */
  private startDecaySchedule(): void {
    this.decayTimer = setInterval(() => {
      this.performDecayEvaluation();
    }, this.config.evaluationIntervalHours * 60 * 60 * 1000);
  }

  /**
   * 执行衰减评估
   */
  async performDecayEvaluation(): Promise<DecayResult> {
    // 获取所有记忆
    // 注意：这里需要实际的实现来获取所有用户的记忆
    // 由于MemoryStore接口没有提供获取所有记忆的方法，我们需要模拟
    console.log("Performing decay evaluation...");
    
    // 返回模拟结果
    return {
      decayedMemoryIds: [],
      deletedMemoryIds: [],
      updatedMemoryIds: [],
      details: []
    };
  }

  /**
   * 计算记忆的衰减值
   */
  calculateDecay(memory: MemoryChunk, decayFunction?: DecayFunction): number {
    const func = decayFunction || this.config.defaultDecayFunction;
    
    // 计算记忆年龄（以天为单位）
    const createdAt = new Date(memory.createdAt);
    const now = new Date();
    const ageInDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    
    // 获取初始重要性（这里假设重要性信息存储在某种元数据中）
    // 实际实现中，重要性可能存储在专门的元数据表中
    const initialImportance = this.getInitialImportance(memory);
    
    // 应用衰减函数
    return func(ageInDays, initialImportance);
  }

  /**
   * 获取记忆的初始重要性
   */
  private getInitialImportance(memory: MemoryChunk): number {
    // 在实际实现中，这将从专门的元数据存储中获取重要性
    // 现在返回一个默认值
    return 0.5; // 默认中等重要性
  }

  /**
   * 应用衰减规则
   */
  addDecayRule(rule: Omit<DecayRule, 'id'>): string {
    const ruleId = generateId();
    this.decayRules.push({
      ...rule,
      id: ruleId
    });
    return ruleId;
  }

  /**
   * 移除衰减规则
   */
  removeDecayRule(ruleId: string): boolean {
    const index = this.decayRules.findIndex(rule => rule.id === ruleId);
    if (index !== -1) {
      this.decayRules.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * 撤销特定记忆
   */
  async revokeMemory(
    memoryId: string, 
    reason: RevocationReason, 
    revokedBy?: string, 
    notes?: string,
    permanent: boolean = false
  ): Promise<boolean> {
    try {
      // 创建撤销记录
      const revocationRecord: RevocationRecord = {
        id: generateId(),
        memoryId,
        reason,
        revokedAt: new Date(),
        revokedBy,
        notes,
        permanent
      };

      this.revocationRecords.set(memoryId, revocationRecord);

      // 根据是否永久撤销来决定如何处理记忆
      if (permanent) {
        // 永久撤销 - 从存储中删除记忆
        await this.permanentlyDeleteMemory(memoryId);
      } else {
        // 临时撤销 - 标记为已撤销但仍保留
        await this.markMemoryAsRevoked(memoryId, revocationRecord);
      }

      return true;
    } catch (error) {
      console.error(`Failed to revoke memory ${memoryId}:`, error);
      return false;
    }
  }

  /**
   * 永久删除记忆
   */
  private async permanentlyDeleteMemory(memoryId: string): Promise<void> {
    // 在实际实现中，这将从存储中物理删除记忆
    console.log(`Permanently deleting memory: ${memoryId}`);
  }

  /**
   * 标记记忆为已撤销
   */
  private async markMemoryAsRevoked(memoryId: string, record: RevocationRecord): Promise<void> {
    // 在实际实现中，这将在存储中标记记忆为已撤销
    console.log(`Marking memory as revoked: ${memoryId}, reason: ${record.reason}`);
  }

  /**
   * 批量撤销记忆
   */
  async bulkRevokeMemories(
    memoryIds: string[], 
    reason: RevocationReason, 
    revokedBy?: string, 
    notes?: string
  ): Promise<{
    successful: string[];
    failed: string[];
  }> {
    const successful: string[] = [];
    const failed: string[] = [];

    for (const memoryId of memoryIds) {
      try {
        const result = await this.revokeMemory(memoryId, reason, revokedBy, notes);
        if (result) {
          successful.push(memoryId);
        } else {
          failed.push(memoryId);
        }
      } catch (error) {
        failed.push(memoryId);
        console.error(`Failed to revoke memory ${memoryId}:`, error);
      }
    }

    return { successful, failed };
  }

  /**
   * 检查记忆是否已被撤销
   */
  isMemoryRevoked(memoryId: string): boolean {
    return this.revocationRecords.has(memoryId);
  }

  /**
   * 获取撤销记录
   */
  getRevocationRecord(memoryId: string): RevocationRecord | undefined {
    return this.revocationRecords.get(memoryId);
  }

  /**
   * 获取所有撤销记录
   */
  getAllRevocationRecords(): RevocationRecord[] {
    return Array.from(this.revocationRecords.values());
  }

  /**
   * 恢复被撤销的记忆
   */
  async restoreMemory(memoryId: string): Promise<boolean> {
    try {
      const record = this.revocationRecords.get(memoryId);
      if (!record) {
        console.log(`Memory ${memoryId} was not revoked`);
        return false;
      }

      if (record.permanent) {
        console.log(`Cannot restore permanently revoked memory ${memoryId}`);
        return false;
      }

      // 恢复记忆
      await this.unmarkMemoryAsRevoked(memoryId);

      // 从撤销记录中移除
      this.revocationRecords.delete(memoryId);

      return true;
    } catch (error) {
      console.error(`Failed to restore memory ${memoryId}:`, error);
      return false;
    }
  }

  /**
   * 取消标记记忆为已撤销
   */
  private async unmarkMemoryAsRevoked(memoryId: string): Promise<void> {
    // 在实际实现中，这将取消存储中记忆的撤销标记
    console.log(`Unmarking memory as revoked: ${memoryId}`);
  }

  /**
   * 清理过期的软删除记忆
   */
  async cleanupSoftDeletedMemories(): Promise<void> {
    const now = new Date();
    const cutoffDate = new Date(now);
    cutoffDate.setDate(now.getDate() - this.config.softDeleteRetentionDays);

    // 查找并永久删除过期的软删除记忆
    // 实际实现中需要遍历存储以查找标记为软删除的记忆
    console.log(`Cleaning up soft-deleted memories older than ${cutoffDate.toISOString()}`);
  }

  /**
   * 获取记忆的衰减状态
   */
  async getMemoryDecayStatus(memoryId: string): Promise<{
    currentImportance: number;
    ageInDays: number;
    isEligibleForDeletion: boolean;
    daysUntilDeletion: number;
  } | null> {
    try {
      // 在实际实现中，这将从存储中获取记忆
      // 由于我们无法直接从MemoryStore获取单个记忆，返回null
      return null;
    } catch (error) {
      console.error(`Failed to get decay status for memory ${memoryId}:`, error);
      return null;
    }
  }

  /**
   * 更新记忆的重要性评分
   */
  async updateMemoryImportance(memoryId: string, newImportance: number): Promise<boolean> {
    try {
      // 在实际实现中，这将更新存储中的记忆重要性
      console.log(`Updating importance for memory ${memoryId} to ${newImportance}`);
      return true;
    } catch (error) {
      console.error(`Failed to update importance for memory ${memoryId}:`, error);
      return false;
    }
  }

  /**
   * 获取衰减配置
   */
  getConfig(): MemoryDecayConfig {
    return { ...this.config };
  }

  /**
   * 更新衰减配置
   */
  updateConfig(updates: Partial<MemoryDecayConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * 获取所有衰减规则
   */
  getDecayRules(): DecayRule[] {
    return [...this.decayRules];
  }

  /**
   * 获取特定用户的衰减规则
   */
  getUserDecayRules(userId: string): DecayRule[] {
    return this.decayRules.filter(rule => !rule.userId || rule.userId === userId);
  }

  /**
   * 评估单个记忆的衰减
   */
  async evaluateMemoryDecay(memory: MemoryChunk): Promise<{
    shouldDecay: boolean;
    shouldDelete: boolean;
    newImportance: number;
  }> {
    // 检查是否已被撤销
    if (this.isMemoryRevoked(memory.id)) {
      return {
        shouldDecay: false,
        shouldDelete: true, // 已撤销的记忆应被删除
        newImportance: 0
      };
    }

    // 计算新重要性
    const newImportance = this.calculateDecay(memory);
    
    // 检查是否低于阈值
    const shouldDelete = newImportance < this.config.importanceThreshold;
    
    return {
      shouldDecay: !shouldDelete, // 如果不删除，则视为衰减
      shouldDelete,
      newImportance
    };
  }

  /**
   * 关闭衰减机制并清理资源
   */
  close(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = undefined;
    }
  }

  /**
   * 获取衰减统计信息
   */
  async getDecayStatistics(): Promise<{
    totalMemories: number;
    decayedMemories: number;
    deletedMemories: number;
    revokedMemories: number;
    averageImportance: number;
  }> {
    // 在实际实现中，这将查询存储以获取统计信息
    return {
      totalMemories: 0,
      decayedMemories: 0,
      deletedMemories: 0,
      revokedMemories: this.revocationRecords.size,
      averageImportance: 0.5
    };
  }
}