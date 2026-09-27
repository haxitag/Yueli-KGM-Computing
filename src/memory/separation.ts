import type { MemoryChunk, MemoryStore, MemorySearchOptions } from "./store.js";
import type { Embedder } from "../embedding/canonical.js";
import { generateId } from "../utils/id.js";

// 从core/types.ts导入Evidence类型
import type { Evidence } from "../core/types.js";

export type MemoryType = 'short_term' | 'long_term';

export type MemoryMetadata = {
  /** 记忆类型 */
  type: MemoryType;
  /** 创建时间 */
  createdAt: string;
  /** 过期时间（仅短期记忆） */
  expiresAt?: string;
  /** 访问计数 */
  accessCount: number;
  /** 最后访问时间 */
  lastAccessed: string;
  /** 重要性评分（0-1） */
  importance: number;
  /** 关联的会话ID */
  sessionId?: string;
  /** 关联的用户ID */
  userId: string;
  /** 记忆来源 */
  source: string;
  /** 记忆分类标签 */
  tags: string[];
  /** 版本号 */
  version: string;
  /** 是否已归档 */
  archived: boolean;
  /** 原始嵌入版本 */
  embeddingVersion: string;
};

export type LongTermMemoryCriteria = {
  /** 最小重要性阈值 */
  minImportance: number;
  /** 最小访问次数 */
  minAccessCount: number;
  /** 最小留存时间（天） */
  minRetentionDays: number;
  /** 是否包含特定标签 */
  requiredTags?: string[];
  /** 是否排除特定标签 */
  excludedTags?: string[];
};

export type ShortTermMemoryConfig = {
  /** 默认过期时间（小时） */
  defaultExpirationHours: number;
  /** 最大短期记忆数量 */
  maxShortTermCount: number;
  /** 清理间隔（分钟） */
  cleanupIntervalMinutes: number;
};

export type MemoryTransitionResult = {
  /** 转移成功的记忆ID */
  movedChunks: string[];
  /** 未能转移的记忆ID */
  failedChunks: string[];
  /** 转移原因 */
  reason: string;
};

export interface LongTermMemoryStore extends MemoryStore {
  /** 获取长期记忆 */
  getLongTerm(userId: string, tags?: string[]): Promise<MemoryChunk[]>;
  /** 归档记忆 */
  archive(memoryId: string): Promise<void>;
  /** 恢复归档的记忆 */
  restore(memoryId: string): Promise<void>;
  /** 获取归档的记忆 */
  getArchived(userId: string): Promise<MemoryChunk[]>;
}

export interface ShortTermMemoryStore extends MemoryStore {
  /** 获取短期记忆 */
  getShortTerm(userId: string, sessionId?: string): Promise<MemoryChunk[]>;
  /** 清理过期的记忆 */
  cleanupExpired(): Promise<void>;
}

export class SeparatedMemoryManager {
  private longTermStore: LongTermMemoryStore;
  private shortTermStore: ShortTermMemoryStore;
  private embedder: Embedder;
  private config: ShortTermMemoryConfig;
  private longTermCriteria: LongTermMemoryCriteria;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    longTermStore: LongTermMemoryStore,
    shortTermStore: ShortTermMemoryStore,
    embedder: Embedder,
    config?: Partial<ShortTermMemoryConfig>,
    criteria?: Partial<LongTermMemoryCriteria>
  ) {
    this.longTermStore = longTermStore;
    this.shortTermStore = shortTermStore;
    this.embedder = embedder;
    
    this.config = {
      defaultExpirationHours: config?.defaultExpirationHours ?? 24,
      maxShortTermCount: config?.maxShortTermCount ?? 100,
      cleanupIntervalMinutes: config?.cleanupIntervalMinutes ?? 30,
    };
    
    this.longTermCriteria = {
      minImportance: criteria?.minImportance ?? 0.7,
      minAccessCount: criteria?.minAccessCount ?? 3,
      minRetentionDays: criteria?.minRetentionDays ?? 7,
      requiredTags: criteria?.requiredTags,
      excludedTags: criteria?.excludedTags,
    };

    // 启动定期清理任务
    this.startCleanupSchedule();
  }

  /**
   * 添加记忆到适当的存储
   */
  async add(memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string }): Promise<void> {
    // 为新记忆生成ID（如果没有提供）
    const id = memoryChunk.id ?? generateId();
    
    // 创建带有元数据的记忆块
    const enhancedChunk: MemoryChunk = {
      ...memoryChunk,
      id,
      createdAt: new Date().toISOString(),
      embeddingVersion: memoryChunk.embeddingVersion || 'default',
    };

    // 根据重要性等标准决定存储位置
    if (this.shouldPromoteToLongTerm(enhancedChunk, {})) {
      await this.longTermStore.add(enhancedChunk);
    } else {
      await this.shortTermStore.add(enhancedChunk);
    }
  }

  /**
   * 添加短期记忆
   */
  async addShortTerm(
    userId: string,
    text: string,
    source: string,
    sessionId?: string,
    tags: string[] = [],
    importance: number = 0.3, // 默认较低的重要性
    expirationHours?: number
  ): Promise<string> {
    const embedding = await this.embedder.embed(text);
    const chunkId = generateId();
    const now = new Date().toISOString();
    
    const memoryChunk: MemoryChunk = {
      id: chunkId,
      userId,
      text,
      embedding,
      embeddingVersion: 'default',
      source,
      createdAt: now,
      lastAccessedAt: now,
    };

    // 添加到短期存储
    await this.shortTermStore.add(memoryChunk);

    // 检查是否需要转移到长期记忆
    await this.evaluateForLongTermTransition(userId, chunkId);

    return chunkId;
  }

  /**
   * 添加长期记忆
   */
  async addLongTerm(
    userId: string,
    text: string,
    source: string,
    tags: string[] = [],
    importance: number = 0.8 // 默认较高的重要性
  ): Promise<string> {
    const embedding = await this.embedder.embed(text);
    const chunkId = generateId();
    const now = new Date().toISOString();
    
    const memoryChunk: MemoryChunk = {
      id: chunkId,
      userId,
      text,
      embedding,
      embeddingVersion: 'default',
      source,
      createdAt: now,
      lastAccessedAt: now,
    };

    await this.longTermStore.add(memoryChunk);

    return chunkId;
  }

  /**
   * 搜索记忆（在两种存储中都搜索）
   */
  async search(
    userId: string,
    query: string,
    embedder: Embedder,
    topK: number,
    options?: MemorySearchOptions,
  ): Promise<Evidence[]> {
    // 并行搜索两种存储
    const [shortTermResults, longTermResults] = await Promise.all([
      this.shortTermStore.search(userId, query, embedder, Math.ceil(topK / 2), options),
      this.longTermStore.search(userId, query, embedder, Math.ceil(topK / 2), options),
    ]);

    // 合并结果并按相关性排序
    const allResults = [...shortTermResults, ...longTermResults];
    
    // 根据需要可以添加额外的排序逻辑，比如考虑记忆的新鲜度或重要性
    return allResults
      .sort((a, b) => b.score - a.score) // 按相似度分数降序排列
      .slice(0, topK); // 限制返回数量
  }

  /**
   * 获取短期记忆
   */
  async getShortTerm(userId: string, sessionId?: string): Promise<MemoryChunk[]> {
    return this.shortTermStore.getShortTerm(userId, sessionId);
  }

  /**
   * 获取长期记忆
   */
  async getLongTerm(userId: string, tags?: string[]): Promise<MemoryChunk[]> {
    return this.longTermStore.getLongTerm(userId, tags);
  }

  /**
   * 评估并将符合条件的记忆从短期转移到长期
   */
  async evaluateForLongTermTransition(userId: string, memoryId?: string): Promise<MemoryTransitionResult> {
    let chunksToEvaluate: MemoryChunk[];

    if (memoryId) {
      // 评估特定记忆
      const allShortTerm = await this.getShortTerm(userId);
      chunksToEvaluate = allShortTerm.filter(chunk => chunk.id === memoryId);
    } else {
      // 评估所有短期记忆
      chunksToEvaluate = await this.getShortTerm(userId);
    }

    const movedChunks: string[] = [];
    const failedChunks: string[] = [];

    for (const chunk of chunksToEvaluate) {
      if (this.shouldPromoteToLongTerm(chunk, await this.getMemoryMetadata(chunk.id))) {
        try {
          // 从短期存储移除
          await this.moveToLongTerm(chunk);
          movedChunks.push(chunk.id);
        } catch (error) {
          console.error(`Failed to move memory ${chunk.id} to long term:`, error);
          failedChunks.push(chunk.id);
        }
      }
    }

    return {
      movedChunks,
      failedChunks,
      reason: 'Evaluation completed based on importance and retention criteria'
    };
  }

  /**
   * 手动将记忆从短期转移到长期
   */
  async moveToLongTerm(memoryChunk: MemoryChunk): Promise<void> {
    // 添加到长期存储
    await this.longTermStore.add(memoryChunk);
    
    // 从短期存储移除（如果存在）
    // 注意：这依赖于底层存储的具体实现来处理删除
    // 在实际实现中，短期存储可能需要提供删除方法
    try {
      await this.removeFromShortTerm(memoryChunk.id);
    } catch (error) {
      // 如果短期存储不支持删除，可以忽略错误
      console.debug(`Could not remove memory from short term store:`, error);
    }
  }

  /**
   * 从短期记忆中移除
   */
  private async removeFromShortTerm(memoryId: string): Promise<void> {
    // 这里需要短期存储提供删除功能
    // 在实际实现中，可能需要扩展ShortTermMemoryStore接口
    console.debug(`Remove from short term called for: ${memoryId}`);
  }

  /**
   * 检查记忆是否应该提升到长期存储
   */
  private shouldPromoteToLongTerm(chunk: MemoryChunk, metadata: Partial<MemoryMetadata>): boolean {
    // 检查重要性阈值
    if (metadata.importance && metadata.importance < this.longTermCriteria.minImportance) {
      return false;
    }

    // 检查访问次数
    if (metadata.accessCount && metadata.accessCount < this.longTermCriteria.minAccessCount) {
      return false;
    }

    // 检查必需的标签
    if (this.longTermCriteria.requiredTags && metadata.tags) {
      const hasRequiredTags = this.longTermCriteria.requiredTags.some(tag => 
        metadata.tags?.includes(tag)
      );
      if (!hasRequiredTags) {
        return false;
      }
    }

    // 检查排除的标签
    if (this.longTermCriteria.excludedTags && metadata.tags) {
      const hasExcludedTags = this.longTermCriteria.excludedTags.some(tag => 
        metadata.tags?.includes(tag)
      );
      if (hasExcludedTags) {
        return false;
      }
    }

    // 如果通过了所有检查，返回true
    return true;
  }

  /**
   * 更新记忆访问统计
   */
  async updateAccessStats(memoryId: string): Promise<void> {
    // 这里可以更新访问计数和最后访问时间
    // 实现细节取决于具体的存储后端
    console.debug(`Updating access stats for: ${memoryId}`);
  }

  /**
   * 设置记忆重要性评分
   */
  async setImportance(memoryId: string, importance: number): Promise<void> {
    // 实现重要性评分设置
    // 具体实现取决于存储后端
    console.debug(`Setting importance for ${memoryId} to ${importance}`);
  }

  /**
   * 为记忆添加标签
   */
  async addTags(memoryId: string, tags: string[]): Promise<void> {
    // 实现标签添加
    // 具体实现取决于存储后端
    console.debug(`Adding tags ${tags.join(', ')} to ${memoryId}`);
  }

  /**
   * 启动定期清理任务
   */
  private startCleanupSchedule(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.config.cleanupIntervalMinutes * 60 * 1000);
  }

  /**
   * 执行清理任务
   */
  private async performCleanup(): Promise<void> {
    try {
      // 清理短期记忆中的过期项目
      await this.shortTermStore.cleanupExpired();
      
      // 评估短期记忆以决定是否转移到长期记忆
      const userIds = await this.getAllUserIds(); // 需要实现获取所有用户ID的方法
      
      for (const userId of userIds) {
        await this.evaluateForLongTermTransition(userId);
      }
    } catch (error) {
      console.error('Error during memory cleanup:', error);
    }
  }

  /**
   * 获取所有用户ID（辅助方法）
   */
  private async getAllUserIds(): Promise<string[]> {
    // 这需要根据实际的存储实现来获取所有唯一的用户ID
    // 临时返回空数组，实际实现中需要查询数据库
    return [];
  }

  /**
   * 获取记忆元数据
   */
  private async getMemoryMetadata(memoryId: string): Promise<Partial<MemoryMetadata>> {
    // 这需要根据实际的存储实现来获取记忆的元数据
    // 临时返回空对象，实际实现中需要查询数据库
    return {};
  }

  /**
   * 关闭内存管理器并清理资源
   */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 获取存储统计信息
   */
  async getStatistics(): Promise<{
    shortTermCount: number;
    longTermCount: number;
    totalSizeEstimate: number;
  }> {
    // 这需要根据实际的存储实现来获取统计信息
    // 临时实现，实际中需要查询存储后端
    return {
      shortTermCount: 0,
      longTermCount: 0,
      totalSizeEstimate: 0,
    };
  }

  /**
   * 归档长期记忆
   */
  async archiveMemory(memoryId: string): Promise<void> {
    if ('archive' in this.longTermStore) {
      await (this.longTermStore as any).archive(memoryId);
    }
  }

  /**
   * 恢复归档的记忆
   */
  async restoreMemory(memoryId: string): Promise<void> {
    if ('restore' in this.longTermStore) {
      await (this.longTermStore as any).restore(memoryId);
    }
  }

  /**
   * 强制执行转移策略
   */
  async runTransferPolicy(userId: string): Promise<MemoryTransitionResult> {
    return this.evaluateForLongTermTransition(userId);
  }
}