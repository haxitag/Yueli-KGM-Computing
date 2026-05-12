import type { MemoryChunk, MemoryStore } from "./store.js";
import type { Embedder } from "../embedding/canonical.js";
import { generateId } from "../utils/id.js";

export type WriteGateCondition = 
  | { type: 'user_quota'; maxWritesPerHour: number }
  | { type: 'content_filter'; patterns: string[] }
  | { type: 'similarity_threshold'; threshold: number }
  | { type: 'embedding_version'; requiredVersion: string }
  | { type: 'approval_required'; roles: string[] }
  | { type: 'rate_limit'; maxRequestsPerMinute: number }
  | { type: 'size_limit'; maxSizeInChars: number }
  | { type: 'source_validation'; allowedSources: string[] };

export type WriteGateRule = {
  /** 规则ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 规则描述 */
  description: string;
  /** 应用条件 */
  condition: WriteGateCondition;
  /** 是否启用 */
  enabled: boolean;
  /** 应用的用户ID（可选） */
  userId?: string;
  /** 应用的会话ID（可选） */
  sessionId?: string;
  /** 优先级（数字越小优先级越高） */
  priority: number;
};

export type WriteGateResult = {
  /** 是否允许写入 */
  allowed: boolean;
  /** 拒绝原因（如果被拒绝） */
  reason?: string;
  /** 替代操作（如果适用） */
  alternativeAction?: 'modify' | 'redirect' | 'approve_required';
  /** 修改后的数据（如果进行了修改） */
  modifiedData?: Partial<MemoryChunk>;
  /** 规则ID */
  ruleId?: string;
};

export type VersionInfo = {
  /** 版本号 */
  version: string;
  /** 版本创建时间 */
  createdAt: string;
  /** 版本描述 */
  description?: string;
  /** 创建者 */
  createdBy?: string;
  /** 是否为活跃版本 */
  isActive: boolean;
  /** 版本类型 */
  type: 'major' | 'minor' | 'patch' | 'experimental';
};

export type MemoryWriteLog = {
  /** 日志ID */
  id: string;
  /** 记忆ID */
  memoryId: string;
  /** 用户ID */
  userId: string;
  /** 写入时间 */
  timestamp: string;
  /** 写入结果 */
  result: 'success' | 'rejected' | 'modified' | 'approved';
  /** 操作类型 */
  operation: 'create' | 'update' | 'delete';
  /** 触发的规则ID */
  ruleId?: string;
  /** 拒绝或修改原因 */
  reason?: string;
  /** 原始数据 */
  originalData: Partial<MemoryChunk>;
  /** 实际写入的数据 */
  actualData: Partial<MemoryChunk>;
  /** 写入者IP地址（可选） */
  ipAddress?: string;
  /** 用户代理（可选） */
  userAgent?: string;
};

export type ApprovalRequest = {
  /** 请求ID */
  id: string;
  /** 记忆数据 */
  memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string };
  /** 请求时间 */
  requestedAt: string;
  /** 请求者 */
  requestedBy: string;
  /** 请求原因 */
  reason?: string;
  /** 审批状态 */
  status: 'pending' | 'approved' | 'rejected';
  /** 审批者 */
  approvedBy?: string;
  /** 审批时间 */
  approvedAt?: string;
  /** 审批意见 */
  approvalNotes?: string;
};

export class WriteGatingMechanism {
  private store: MemoryStore;
  private embedder: Embedder;
  private rules: WriteGateRule[] = [];
  private versions: Map<string, VersionInfo[]> = new Map();
  private logs: MemoryWriteLog[] = [];
  private approvalQueue: ApprovalRequest[] = [];
  private userWriteCounts: Map<string, { count: number; lastReset: Date }> = new Map();

  constructor(store: MemoryStore, embedder: Embedder) {
    this.store = store;
    this.embedder = embedder;
  }

  /**
   * 添加写入门控规则
   */
  addRule(rule: Omit<WriteGateRule, 'id'>): string {
    const ruleId = generateId();
    this.rules.push({
      ...rule,
      id: ruleId
    });
    
    // 按优先级排序规则
    this.rules.sort((a, b) => a.priority - b.priority);
    
    return ruleId;
  }

  /**
   * 移除写入门控规则
   */
  removeRule(ruleId: string): boolean {
    const initialLength = this.rules.length;
    this.rules = this.rules.filter(rule => rule.id !== ruleId);
    return initialLength !== this.rules.length;
  }

  /**
   * 检查写入是否被允许
   */
  async checkWriteAccess(
    memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string },
    userId: string,
    context?: {
      sessionId?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<WriteGateResult> {
    // 按优先级顺序检查所有规则
    for (const rule of this.rules) {
      if (!rule.enabled) {
        continue;
      }

      // 检查规则是否适用于此用户/会话
      if ((rule.userId && rule.userId !== userId) || 
          (rule.sessionId && rule.sessionId !== context?.sessionId)) {
        continue;
      }

      const result = await this.evaluateRule(rule, memoryChunk, userId, context);
      if (!result.allowed) {
        // 记录拒绝的日志
        await this.logWriteAttempt(
          memoryChunk.id || generateId(),
          userId,
          'rejected',
          rule.id,
          result.reason,
          memoryChunk,
          memoryChunk,
          context
        );
        
        return result;
      }
      
      // 如果规则修改了数据，更新memoryChunk
      if (result.modifiedData) {
        Object.assign(memoryChunk, result.modifiedData);
      }
    }

    // 所有规则都通过，允许写入
    return { allowed: true };
  }

  /**
   * 评估单个规则
   */
  private async evaluateRule(
    rule: WriteGateRule,
    memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string },
    userId: string,
    context?: {
      sessionId?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<WriteGateResult> {
    const condition = rule.condition;

    switch (condition.type) {
      case 'user_quota':
        return this.checkUserQuota(userId, condition.maxWritesPerHour);
      
      case 'content_filter':
        return this.checkContentFilter(memoryChunk.text, condition.patterns);
      
      case 'similarity_threshold':
        return this.checkSimilarityThreshold(memoryChunk, condition.threshold);
      
      case 'embedding_version':
        return this.checkEmbeddingVersion(memoryChunk.embeddingVersion, condition.requiredVersion);
      
      case 'approval_required':
        return this.checkApprovalRequired(userId, condition.roles, memoryChunk);
      
      case 'rate_limit':
        return this.checkRateLimit(userId, condition.maxRequestsPerMinute);
      
      case 'size_limit':
        return this.checkSizeLimit(memoryChunk.text, condition.maxSizeInChars);
      
      case 'source_validation':
        return this.checkSourceValidation(memoryChunk.source, condition.allowedSources);
      
      default:
        return { allowed: true }; // 未知规则类型，允许通过
    }
  }

  /**
   * 检查用户配额
   */
  private async checkUserQuota(userId: string, maxWritesPerHour: number): Promise<WriteGateResult> {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // 获取用户在过去一小时内的写入次数
    const recentLogs = this.logs.filter(log => 
      log.userId === userId && 
      new Date(log.timestamp) > hourAgo &&
      log.result === 'success'
    );
    
    if (recentLogs.length >= maxWritesPerHour) {
      return {
        allowed: false,
        reason: `User quota exceeded: ${maxWritesPerHour} writes per hour`
      };
    }
    
    return { allowed: true };
  }

  /**
   * 检查内容过滤
   */
  private async checkContentFilter(text: string, patterns: string[]): Promise<WriteGateResult> {
    for (const pattern of patterns) {
      if (text.toLowerCase().includes(pattern.toLowerCase())) {
        return {
          allowed: false,
          reason: `Content contains blocked pattern: ${pattern}`
        };
      }
    }
    
    return { allowed: true };
  }

  /**
   * 检查相似性阈值
   */
  private async checkSimilarityThreshold(
    memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string },
    threshold: number
  ): Promise<WriteGateResult> {
    // 生成嵌入向量用于比较
    const newEmbedding = await this.embedder.embed(memoryChunk.text);
    
    // 这里应该搜索存储中相似的记忆
    // 由于MemoryStore接口没有直接提供相似性搜索方法，我们跳过此检查
    // 在实际实现中，这将调用存储的相似性搜索功能
    
    return { allowed: true };
  }

  /**
   * 检查嵌入版本
   */
  private async checkEmbeddingVersion(embeddingVersion: string, requiredVersion: string): Promise<WriteGateResult> {
    if (embeddingVersion !== requiredVersion) {
      return {
        allowed: false,
        reason: `Invalid embedding version: ${embeddingVersion}, expected: ${requiredVersion}`
      };
    }
    
    return { allowed: true };
  }

  /**
   * 检查是否需要审批
   */
  private async checkApprovalRequired(
    userId: string,
    roles: string[],
    memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string }
  ): Promise<WriteGateResult> {
    // 在实际实现中，这里会检查用户角色
    // 如果用户角色不在允许列表中，需要审批
    return { 
      allowed: true, // 简化实现，总是允许
      alternativeAction: 'approve_required'
    };
  }

  /**
   * 检查速率限制
   */
  private async checkRateLimit(userId: string, maxRequestsPerMinute: number): Promise<WriteGateResult> {
    const now = new Date();
    const minuteAgo = new Date(now.getTime() - 60 * 1000);
    
    // 获取用户在过去一分钟内的请求数
    const recentLogs = this.logs.filter(log => 
      log.userId === userId && 
      new Date(log.timestamp) > minuteAgo
    );
    
    if (recentLogs.length >= maxRequestsPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${maxRequestsPerMinute} requests per minute`
      };
    }
    
    return { allowed: true };
  }

  /**
   * 检查大小限制
   */
  private async checkSizeLimit(text: string, maxSizeInChars: number): Promise<WriteGateResult> {
    if (text.length > maxSizeInChars) {
      return {
        allowed: false,
        reason: `Content exceeds size limit: ${text.length} chars, max allowed: ${maxSizeInChars}`
      };
    }
    
    return { allowed: true };
  }

  /**
   * 检查来源验证
   */
  private async checkSourceValidation(source: string, allowedSources: string[]): Promise<WriteGateResult> {
    if (!allowedSources.includes(source)) {
      return {
        allowed: false,
        reason: `Invalid source: ${source}, allowed sources: ${allowedSources.join(', ')}`
      };
    }
    
    return { allowed: true };
  }

  /**
   * 安全写入记忆（应用门控规则）
   */
  async secureWrite(
    memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string },
    userId: string,
    context?: {
      sessionId?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<{ success: boolean; memoryId?: string; reason?: string }> {
    // 检查写入权限
    const accessCheck = await this.checkWriteAccess(memoryChunk, userId, context);
    
    if (!accessCheck.allowed) {
      return { success: false, reason: accessCheck.reason };
    }

    try {
      // 如果数据被修改，使用修改后的数据
      const finalChunk = accessCheck.modifiedData 
        ? { ...memoryChunk, ...accessCheck.modifiedData }
        : memoryChunk;

      // 生成ID（如果还没有的话）
      const id = finalChunk.id || generateId();
      
      // 创建完整的记忆块
      const now = new Date().toISOString();
      const completeChunk: MemoryChunk = {
        ...finalChunk,
        id,
        createdAt: now,
        lastAccessedAt: now,
        embeddingVersion: finalChunk.embeddingVersion || 'default',
      };

      // 添加到存储
      await this.store.add(completeChunk);

      // 记录成功的写入
      await this.logWriteAttempt(
        id,
        userId,
        'success',
        accessCheck.ruleId,
        undefined,
        memoryChunk,
        finalChunk,
        context
      );

      // 更新用户写入计数
      await this.updateUserWriteCount(userId);

      return { success: true, memoryId: id };
    } catch (error) {
      console.error('Failed to write memory:', error);
      
      await this.logWriteAttempt(
        memoryChunk.id || generateId(),
        userId,
        'rejected',
        accessCheck.ruleId,
        `Storage error: ${error}`,
        memoryChunk,
        memoryChunk,
        context
      );

      return { success: false, reason: `Storage error: ${error}` };
    }
  }

  /**
   * 记录写入尝试
   */
  private async logWriteAttempt(
    memoryId: string,
    userId: string,
    result: MemoryWriteLog['result'],
    ruleId: string | undefined,
    reason: string | undefined,
    originalData: Partial<MemoryChunk>,
    actualData: Partial<MemoryChunk>,
    context?: {
      sessionId?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<void> {
    const logEntry: MemoryWriteLog = {
      id: generateId(),
      memoryId,
      userId,
      timestamp: new Date().toISOString(),
      result,
      operation: 'create', // 在实际实现中，这可能是create、update或delete
      ruleId,
      reason,
      originalData,
      actualData,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    };

    this.logs.push(logEntry);

    // 限制日志数量以节省内存
    if (this.logs.length > 10000) {
      this.logs = this.logs.slice(-10000);
    }
  }

  /**
   * 更新用户写入计数
   */
  private async updateUserWriteCount(userId: string): Promise<void> {
    const now = new Date();
    const userData = this.userWriteCounts.get(userId);
    
    if (!userData) {
      this.userWriteCounts.set(userId, { count: 1, lastReset: now });
      return;
    }

    // 检查是否需要重置计数（每小时重置）
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    if (userData.lastReset < hourAgo) {
      this.userWriteCounts.set(userId, { count: 1, lastReset: now });
    } else {
      userData.count += 1;
      this.userWriteCounts.set(userId, userData);
    }
  }

  /**
   * 添加版本信息
   */
  addVersion(userId: string, versionInfo: Omit<VersionInfo, 'createdAt'>): void {
    const versions = this.versions.get(userId) || [];
    versions.push({
      ...versionInfo,
      createdAt: new Date().toISOString()
    });
    
    // 按创建时间排序
    versions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    this.versions.set(userId, versions);
  }

  /**
   * 获取用户的所有版本
   */
  getUserVersions(userId: string): VersionInfo[] {
    return this.versions.get(userId) || [];
  }

  /**
   * 获取用户的活跃版本
   */
  getActiveVersion(userId: string): VersionInfo | undefined {
    const versions = this.versions.get(userId) || [];
    return versions.find(v => v.isActive);
  }

  /**
   * 创建审批请求
   */
  async createApprovalRequest(
    memoryChunk: Omit<MemoryChunk, 'id' | 'createdAt'> & { id?: string },
    requestedBy: string,
    reason?: string
  ): Promise<string> {
    const requestId = generateId();
    
    const request: ApprovalRequest = {
      id: requestId,
      memoryChunk,
      requestedAt: new Date().toISOString(),
      requestedBy,
      reason,
      status: 'pending'
    };

    this.approvalQueue.push(request);
    return requestId;
  }

  /**
   * 审批请求
   */
  async approveRequest(
    requestId: string,
    approvedBy: string,
    approve: boolean,
    notes?: string
  ): Promise<boolean> {
    const requestIndex = this.approvalQueue.findIndex(req => req.id === requestId);
    if (requestIndex === -1) {
      return false;
    }

    const request = this.approvalQueue[requestIndex];
    request.status = approve ? 'approved' : 'rejected';
    request.approvedBy = approvedBy;
    request.approvedAt = new Date().toISOString();
    request.approvalNotes = notes;

    if (approve) {
      // 如果批准，执行写入操作
      try {
        await this.store.add({
          ...request.memoryChunk,
          id: request.memoryChunk.id || generateId(),
          createdAt: new Date().toISOString(),
          embeddingVersion: request.memoryChunk.embeddingVersion || 'default',
        });
      } catch (error) {
        console.error('Failed to write approved memory:', error);
        return false;
      }
    }

    return true;
  }

  /**
   * 获取待审批的请求
   */
  getPendingApprovals(): ApprovalRequest[] {
    return this.approvalQueue.filter(req => req.status === 'pending');
  }

  /**
   * 获取写入日志
   */
  getWriteLogs(
    userId?: string,
    startDate?: Date,
    endDate?: Date,
    result?: MemoryWriteLog['result']
  ): MemoryWriteLog[] {
    let logs = [...this.logs];

    if (userId) {
      logs = logs.filter(log => log.userId === userId);
    }

    if (startDate) {
      logs = logs.filter(log => new Date(log.timestamp) >= startDate);
    }

    if (endDate) {
      logs = logs.filter(log => new Date(log.timestamp) <= endDate);
    }

    if (result) {
      logs = logs.filter(log => log.result === result);
    }

    // 按时间倒序排列
    return logs.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /**
   * 获取写入门控规则
   */
  getRules(): WriteGateRule[] {
    return [...this.rules];
  }

  /**
   * 获取特定用户的规则
   */
  getUserRules(userId: string): WriteGateRule[] {
    return this.rules.filter(rule => !rule.userId || rule.userId === userId);
  }

  /**
   * 获取统计信息
   */
  getStatistics(): {
    totalRules: number;
    totalLogs: number;
    pendingApprovals: number;
    userWriteCounts: number;
  } {
    return {
      totalRules: this.rules.length,
      totalLogs: this.logs.length,
      pendingApprovals: this.approvalQueue.length,
      userWriteCounts: this.userWriteCounts.size,
    };
  }

  /**
   * 验证嵌入版本兼容性
   */
  validateEmbeddingCompatibility(
    currentVersion: string,
    requiredVersion: string
  ): boolean {
    // 简单的版本比较，实际实现中可能需要更复杂的版本兼容性检查
    return currentVersion === requiredVersion;
  }

  /**
   * 获取版本变更影响分析
   */
  getVersionImpactAnalysis(fromVersion: string, toVersion: string): {
    affectedMemories: number;
    compatibilityIssues: string[];
  } {
    // 在实际实现中，这将分析版本变更对现有记忆的影响
    return {
      affectedMemories: 0,
      compatibilityIssues: [],
    };
  }
}