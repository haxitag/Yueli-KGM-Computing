/**
 * 分布式存储抽象层
 * 提供跨节点的统一存储接口，支持数据分片和复制
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { ClusterManager } from './cluster.js';

export interface StorageConfig {
  /** 存储后端类型：memory|redis|mongodb|s3 */
  backend: 'memory' | 'redis' | 'mongodb' | 's3';
  /** 后端配置 */
  backendConfig: Record<string, any>;
  /** 是否启用数据分片 */
  sharding: boolean;
  /** 是否启用数据复制 */
  replication: boolean;
  /** 复制因子 */
  replicationFactor: number;
  /** 一致性级别：strong|eventual|causal */
  consistency: 'strong' | 'eventual' | 'causal';
  /** 是否启用缓存 */
  caching: boolean;
  /** 缓存TTL（毫秒） */
  cacheTTL: number;
  /** 是否启用压缩 */
  compression: boolean;
  /** 是否启用加密 */
  encryption: boolean;
}

export interface StorageRecord<T = any> {
  /** 记录ID */
  id: string;
  /** 键 */
  key: string;
  /** 值 */
  value: T;
  /** 版本号（用于乐观锁） */
  version: number;
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
  /** 过期时间 */
  expiresAt?: Date;
  /** 元数据 */
  metadata: Record<string, any>;
  /** 标签（用于分类和查询） */
  tags: string[];
}

export interface StorageQuery {
  /** 键前缀匹配 */
  prefix?: string;
  /** 键模式匹配（支持*通配符） */
  pattern?: string;
  /** 标签过滤 */
  tags?: string[];
  /** 元数据过滤 */
  metadata?: Record<string, any>;
  /** 创建时间范围 */
  createdAtRange?: [Date?, Date?];
  /** 更新时间范围 */
  updatedAtRange?: [Date?, Date?];
  /** 分页限制 */
  limit?: number;
  /** 分页偏移 */
  offset?: number;
  /** 排序字段 */
  sortBy?: 'key' | 'createdAt' | 'updatedAt' | 'version';
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc';
}

export interface StorageStats {
  /** 总记录数 */
  totalRecords: number;
  /** 总存储大小（字节） */
  totalSize: number;
  /** 按类型分布 */
  byType: Record<string, number>;
  /** 按分片分布 */
  byShard: Record<number, number>;
  /** 按节点分布 */
  byNode: Record<string, number>;
  /** 缓存命中率 */
  cacheHitRate: number;
  /** 复制状态 */
  replicationStatus: Record<string, 'synced' | 'syncing' | 'outdated'>;
}

/**
 * 分布式存储管理器
 */
export class DistributedStorage<T = any> extends EventEmitter {
  private cluster: ClusterManager;
  private config: StorageConfig;
  private localCache: Map<string, { value: T; timestamp: number }> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private backend: any; // 实际的后端存储实例
  private cleanupIntervals: Map<string, NodeJS.Timeout> = new Map();
  
  constructor(
    cluster: ClusterManager,
    config: Partial<StorageConfig> = {}
  ) {
    super();
    
    this.cluster = cluster;
    this.config = {
      backend: config.backend || 'memory',
      backendConfig: config.backendConfig || {},
      sharding: config.sharding ?? true,
      replication: config.replication ?? true,
      replicationFactor: config.replicationFactor || 2,
      consistency: config.consistency || 'eventual',
      caching: config.caching ?? true,
      cacheTTL: config.cacheTTL || 60000, // 1分钟
      compression: config.compression ?? false,
      encryption: config.encryption ?? false,
    };
    
    // 初始化后端存储
    this.initializeBackend();
    
    // 启动定期清理
    this.startCleanupTasks();
  }
  
  /**
   * 设置存储值
   */
  async set(
    key: string,
    value: T,
    options: {
      /** TTL（毫秒） */
      ttl?: number;
      /** 乐观锁版本 */
      version?: number;
      /** 标签 */
      tags?: string[];
      /** 元数据 */
      metadata?: Record<string, any>;
      /** 是否覆盖现有值 */
      overwrite?: boolean;
    } = {}
  ): Promise<StorageRecord<T>> {
    const now = new Date();
    
    // 检查是否已存在且不允许覆盖
    if (!options.overwrite) {
      const existing = await this.get(key, false); // 不读缓存
      if (existing) {
        throw new Error(`Key ${key} already exists`);
      }
    }
    
    // 确定分片
    const shardId = this.config.sharding 
      ? this.calculateShardId(key) 
      : undefined;
    
    // 确定存储节点
    const primaryNode = shardId
      ? this.cluster.getNodeForShard(shardId)
      : this.cluster.getCurrentNode();
    
    if (!primaryNode) {
      throw new Error('No storage node available');
    }
    
    // 创建记录
    const record: StorageRecord<T> = {
      id: randomUUID(),
      key,
      value,
      version: options.version || 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: options.ttl ? new Date(now.getTime() + options.ttl) : undefined,
      metadata: options.metadata || {},
      tags: options.tags || [],
    };
    
    // 如果是当前节点，直接存储
    if (primaryNode.id === this.cluster.getCurrentNode()?.id) {
      await this.storeLocally(record, shardId);
    } else {
      // 转发到主节点
      await this.forwardToNode(primaryNode.id, 'set', { 
        key, 
        record, 
        shardId 
      });
    }
    
    // 如果需要复制
    if (this.config.replication) {
      await this.replicateRecord(record, shardId, primaryNode.id);
    }
    
    // 更新缓存
    if (this.config.caching) {
      this.localCache.set(key, {
        value,
        timestamp: now.getTime(),
      });
    }
    
    console.log(`💾 存储值: ${key} -> ${primaryNode.name}`);
    this.emit('record.set', { key, record, shardId, primaryNode });
    
    return record;
  }
  
  /**
   * 获取存储值
   */
  async get(
    key: string,
    useCache: boolean = true
  ): Promise<StorageRecord<T> | null> {
    // 检查缓存
    if (useCache && this.config.caching) {
      const cached = this.localCache.get(key);
      if (cached) {
        const now = Date.now();
        if (now - cached.timestamp < this.config.cacheTTL) {
          console.log(`📦 缓存命中: ${key}`);
          
          // 返回缓存值（需要获取完整记录）
          // 这里简化处理，实际应该从缓存获取完整记录
          return {
            id: 'cache',
            key,
            value: cached.value,
            version: 1,
            createdAt: new Date(cached.timestamp),
            updatedAt: new Date(cached.timestamp),
            metadata: {},
            tags: [],
          };
        }
      }
    }
    
    // 确定分片
    const shardId = this.config.sharding 
      ? this.calculateShardId(key) 
      : undefined;
    
    // 确定存储节点
    const storageNode = shardId
      ? this.cluster.getNodeForShard(shardId)
      : this.cluster.getCurrentNode();
    
    if (!storageNode) {
      return null;
    }
    
    let record: StorageRecord<T> | null = null;
    
    // 如果是当前节点，直接读取
    if (storageNode.id === this.cluster.getCurrentNode()?.id) {
      record = await this.retrieveLocally(key, shardId);
    } else {
      // 从远程节点读取
      record = await this.retrieveFromNode(storageNode.id, key, shardId);
    }
    
    // 如果主节点没有找到，尝试从副本读取
    if (!record && this.config.replication && shardId) {
      record = await this.tryReplicaRead(key, shardId, storageNode.id);
    }
    
    // 更新缓存
    if (record && this.config.caching) {
      this.localCache.set(key, {
        value: record.value,
        timestamp: record.updatedAt.getTime(),
      });
    }
    
    if (record) {
      console.log(`🔍 找到记录: ${key} (版本: ${record.version})`);
    } else {
      console.log(`❓ 未找到记录: ${key}`);
    }
    
    return record;
  }
  
  /**
   * 更新存储值
   */
  async update(
    key: string,
    updater: (current: StorageRecord<T> | null) => Promise<StorageRecord<T>>,
    options: {
      maxRetries?: number;
      retryDelay?: number;
    } = {}
  ): Promise<StorageRecord<T>> {
    const maxRetries = options.maxRetries || 3;
    const retryDelay = options.retryDelay || 100;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 获取当前值
        const current = await this.get(key, false);
        
        // 使用updater函数更新
        const updated = await updater(current);
        updated.version = (current?.version || 0) + 1;
        updated.updatedAt = new Date();
        
        // 保存更新
        return await this.set(key, updated.value, {
          version: updated.version,
          tags: updated.tags,
          metadata: updated.metadata,
          overwrite: true,
        });
        
      } catch (error: any) {
        if (error.message.includes('version conflict') && attempt < maxRetries - 1) {
          // 版本冲突，重试
          await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
          continue;
        }
        
        throw error;
      }
    }
    
    throw new Error(`Failed to update ${key} after ${maxRetries} attempts`);
  }
  
  /**
   * 删除存储值
   */
  async delete(key: string): Promise<boolean> {
    // 确定分片
    const shardId = this.config.sharding 
      ? this.calculateShardId(key) 
      : undefined;
    
    // 确定存储节点
    const storageNode = shardId
      ? this.cluster.getNodeForShard(shardId)
      : this.cluster.getCurrentNode();
    
    if (!storageNode) {
      return false;
    }
    
    let success = false;
    
    // 如果是当前节点，直接删除
    if (storageNode.id === this.cluster.getCurrentNode()?.id) {
      success = await this.deleteLocally(key, shardId);
    } else {
      // 通知远程节点删除
      success = await this.deleteFromNode(storageNode.id, key, shardId);
    }
    
    // 清理缓存
    this.localCache.delete(key);
    
    // 如果需要，从副本删除
    if (success && this.config.replication && shardId) {
      await this.replicateDelete(key, shardId, storageNode.id);
    }
    
    if (success) {
      console.log(`🗑️  删除记录: ${key}`);
      this.emit('record.deleted', { key, shardId, storageNode });
    }
    
    return success;
  }
  
  /**
   * 查询记录
   */
  async query(query: StorageQuery): Promise<StorageRecord<T>[]> {
    // 简单实现：如果有关键字匹配，返回所有记录
    // 实际实现需要根据后端存储能力实现
    
    const results: StorageRecord<T>[] = [];
    
    // 这里简化处理，只支持前缀查询
    if (query.prefix) {
      // 在实际实现中，这里应该查询后端存储
      console.log(`🔍 查询记录（前缀: ${query.prefix}）`);
    } else {
      console.log(`🔍 查询记录（无过滤条件）`);
    }
    
    // 为了演示返回空结果
    return results.slice(query.offset || 0, (query.limit || 10) + (query.offset || 0));
  }
  
  /**
   * 批量操作
   */
  async batch(operations: Array<{
    type: 'set' | 'delete' | 'get';
    key: string;
    value?: T;
    options?: any;
  }>): Promise<Array<StorageRecord<T> | boolean | null>> {
    const results: Array<StorageRecord<T> | boolean | null> = [];
    
    // 按分片分组
    const operationsByShard = new Map<number, typeof operations>();
    
    for (const op of operations) {
      const shardId = this.config.sharding 
        ? this.calculateShardId(op.key) 
        : undefined;
      
      const shardKey = shardId ?? -1;
      const group = operationsByShard.get(shardKey) || [];
      group.push(op);
      operationsByShard.set(shardKey, group);
    }
    
    // 并行执行每个分片的操作
    const promises: Array<Promise<void>> = [];
    
    for (const [shardId, shardOps] of operationsByShard) {
      const node = shardId !== -1
        ? this.cluster.getNodeForShard(shardId)
        : this.cluster.getCurrentNode();
      
      if (!node) {
        // 节点不可用，所有操作失败
        for (let i = 0; i < shardOps.length; i++) {
          if (shardOps[i].type === 'get') {
            results.push(null);
          } else {
            results.push(false);
          }
        }
        continue;
      }
      
      // 如果是当前节点，批量执行
      if (node.id === this.cluster.getCurrentNode()?.id) {
        promises.push(
          (async () => {
            for (const op of shardOps) {
              try {
                if (op.type === 'set' && op.value !== undefined) {
                  const record = await this.set(op.key, op.value, op.options || {});
                  results.push(record);
                } else if (op.type === 'delete') {
                  const success = await this.delete(op.key);
                  results.push(success);
                } else if (op.type === 'get') {
                  const record = await this.get(op.key, true);
                  results.push(record);
                }
              } catch (error) {
                // 操作失败
                if (op.type === 'get') {
                  results.push(null);
                } else {
                  results.push(false);
                }
              }
            }
          })()
        );
      } else {
        // 转发到远程节点
        promises.push(
          (async () => {
            const remoteResults = await this.forwardBatchToNode(
              node.id, 
              shardId !== -1 ? shardId : undefined,
              shardOps
            );
            results.push(...remoteResults);
          })()
        );
      }
    }
    
    await Promise.all(promises);
    
    return results;
  }
  
  /**
   * 获取存储统计信息
   */
  async getStats(): Promise<StorageStats> {
    const nodes = this.cluster.getNodes().filter(node => node.status === 'online');
    const statsByNode: Record<string, number> = {};
    const statsByShard: Record<number, number> = {};
    
    let totalRecords = 0;
    let totalSize = 0;
    
    // 从每个节点收集统计信息（简化实现）
    for (const node of nodes) {
      if (node.id === this.cluster.getCurrentNode()?.id) {
        // 本地节点
        const localStats = this.getLocalStats();
        statsByNode[node.name] = localStats.totalRecords;
        totalRecords += localStats.totalRecords;
        totalSize += localStats.totalSize;
      } else {
        // 远程节点（这里简化处理）
        statsByNode[node.name] = 0;
      }
    }
    
    // 分片统计（简化实现）
    if (this.config.sharding) {
      for (let shardId = 0; shardId < this.cluster.getClusterStatus().health.shardCoverage; shardId++) {
        statsByShard[shardId] = Math.floor(Math.random() * 100); // 模拟数据
      }
    }
    
    return {
      totalRecords,
      totalSize,
      byType: {}, // 需要实际数据
      byShard: statsByShard,
      byNode: statsByNode,
      cacheHitRate: Math.random(), // 模拟命中率
      replicationStatus: {}, // 需要实际数据
    };
  }
  
  /**
   * 清理过期记录
   */
  async cleanupExpired(): Promise<number> {
    let cleanedCount = 0;
    const now = new Date();
    
    // 清理本地缓存
    for (const [key, entry] of this.localCache.entries()) {
      if (now.getTime() - entry.timestamp > this.config.cacheTTL) {
        this.localCache.delete(key);
        cleanedCount++;
      }
    }
    
    // 清理过期记录的实际逻辑需要后端存储支持
    console.log(`🧹 清理了 ${cleanedCount} 个过期缓存项`);
    
    return cleanedCount;
  }
  
  /**
   * 计算键的分片ID
   */
  private calculateShardId(key: string): number {
    // 使用简单的哈希函数
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash = hash & hash; // 转换为32位整数
    }
    
    return Math.abs(hash) % this.cluster.getClusterStatus().health.shardCoverage;
  }
  
  private initializeBackend(): void {
    // 根据配置初始化后端存储
    switch (this.config.backend) {
      case 'memory':
        // 使用内存存储
        this.backend = new Map();
        break;
      case 'redis':
        // 初始化Redis客户端
        console.log('🔧 初始化Redis存储后端');
        // this.backend = new Redis(this.config.backendConfig);
        this.backend = new Map(); // 模拟
        break;
      case 'mongodb':
        // 初始化MongoDB客户端
        console.log('🔧 初始化MongoDB存储后端');
        this.backend = new Map(); // 模拟
        break;
      case 's3':
        // 初始化AWS S3客户端
        console.log('🔧 初始化S3存储后端');
        this.backend = new Map(); // 模拟
        break;
      default:
        this.backend = new Map();
    }
  }
  
  private async storeLocally(
    record: StorageRecord<T>,
    shardId?: number
  ): Promise<void> {
    // 存储到本地后端
    const storageKey = shardId !== undefined ? `shard_${shardId}:${record.key}` : record.key;
    
    // 根据一致性级别处理
    const consistency = this.config.consistency;
    
    if (consistency === 'strong') {
      // 强一致性：同步写入
      this.backend.set(storageKey, JSON.stringify(record));
    } else {
      // 最终一致性：异步写入
      this.pendingWrites.set(
        record.key,
        (async () => {
          this.backend.set(storageKey, JSON.stringify(record));
        })()
      );
    }
  }
  
  private async retrieveLocally(
    key: string,
    shardId?: number
  ): Promise<StorageRecord<T> | null> {
    const storageKey = shardId !== undefined ? `shard_${shardId}:${key}` : key;
    const recordStr = this.backend.get(storageKey);
    
    if (!recordStr) {
      return null;
    }
    
    try {
      return JSON.parse(recordStr);
    } catch (error) {
      console.error(`Failed to parse record for key ${key}:`, error);
      return null;
    }
  }
  
  private async deleteLocally(
    key: string,
    shardId?: number
  ): Promise<boolean> {
    const storageKey = shardId !== undefined ? `shard_${shardId}:${key}` : key;
    const existed = this.backend.has(storageKey);
    
    if (existed) {
      this.backend.delete(storageKey);
      return true;
    }
    
    return false;
  }
  
  private async forwardToNode(
    nodeId: string,
    operation: string,
    data: any
  ): Promise<any> {
    console.log(`📤 转发操作到节点 ${nodeId}: ${operation}`);
    
    // 这里应该使用实际的RPC或消息队列
    // 为了演示，我们模拟网络通信
    
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // 模拟成功的响应
        resolve({ success: true, nodeId, operation });
      }, 10 + Math.random() * 50);
    });
  }
  
  private async forwardBatchToNode(
    nodeId: string,
    shardId: number | undefined,
    operations: Array<{
      type: 'set' | 'delete' | 'get';
      key: string;
      value?: T;
      options?: any;
    }>
  ): Promise<Array<StorageRecord<T> | boolean | null>> {
    console.log(`📤 批量转发操作到节点 ${nodeId}: ${operations.length} 个操作`);
    
    // 模拟批量操作的响应
    return operations.map(op => {
      if (op.type === 'get') {
        return null; // 模拟未找到
      } else {
        return true; // 模拟成功
      }
    });
  }
  
  private async retrieveFromNode(
    nodeId: string,
    key: string,
    shardId?: number
  ): Promise<StorageRecord<T> | null> {
    console.log(`📥 从节点 ${nodeId} 获取记录: ${key}`);
    
    // 模拟从远程节点获取数据
    return new Promise((resolve) => {
      setTimeout(() => {
        // 模拟随机找到或找不到
        if (Math.random() > 0.5) {
          const now = new Date();
          resolve({
            id: randomUUID(),
            key,
            value: {} as T,
            version: 1,
            createdAt: now,
            updatedAt: now,
            metadata: {},
            tags: [],
          });
        } else {
          resolve(null);
        }
      }, 20 + Math.random() * 80);
    });
  }
  
  private async deleteFromNode(
    nodeId: string,
    key: string,
    shardId?: number
  ): Promise<boolean> {
    console.log(`🗑️  从节点 ${nodeId} 删除记录: ${key}`);
    
    // 模拟删除操作
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(Math.random() > 0.2); // 80%成功率
      }, 10 + Math.random() * 40);
    });
  }
  
  private async replicateRecord(
    record: StorageRecord<T>,
    shardId: number | undefined,
    primaryNodeId: string
  ): Promise<void> {
    const replicationFactor = this.config.replicationFactor;
    
    if (replicationFactor <= 1) {
      return; // 不需要复制
    }
    
    // 获取符合条件的副本节点
    const onlineNodes = this.cluster.getNodes().filter(
      node => node.status === 'online' && node.id !== primaryNodeId
    );
    
    if (onlineNodes.length === 0) {
      console.warn('⚠️ 没有可用的副本节点');
      return;
    }
    
    // 选择副本节点
    const replicaNodes = onlineNodes.slice(0, replicationFactor - 1);
    
    console.log(`🔄 复制记录到 ${replicaNodes.length} 个副本节点`);
    
    // 异步复制到副本节点
    const replicationPromises = replicaNodes.map(node =>
      this.forwardToNode(node.id, 'replicate', { 
        record, 
        shardId,
        source: primaryNodeId 
      }).catch(error => {
        console.error(`复制到节点 ${node.name} 失败:`, error);
        return null;
      })
    );
    
    await Promise.all(replicationPromises);
    
    console.log(`✅ 记录复制完成`);
  }
  
  private async replicateDelete(
    key: string,
    shardId: number | undefined,
    primaryNodeId: string
  ): Promise<void> {
    // 类似replicateRecord，但删除操作
    console.log(`🔄 复制删除操作: ${key}`);
  }
  
  private async tryReplicaRead(
    key: string,
    shardId: number,
    primaryNodeId: string
  ): Promise<StorageRecord<T> | null> {
    // 从副本节点尝试读取
    const onlineNodes = this.cluster.getNodes().filter(
      node => node.status === 'online' && node.id !== primaryNodeId
    );
    
    for (const node of onlineNodes) {
      try {
        const record = await this.retrieveFromNode(node.id, key, shardId);
        if (record) {
          console.log(`✅ 从副本节点 ${node.name} 读取记录: ${key}`);
          return record;
        }
      } catch (error) {
        // 继续尝试下一个副本
        continue;
      }
    }
    
    return null;
  }
  
  private getLocalStats(): { totalRecords: number; totalSize: number } {
    // 计算本地存储统计
    return {
      totalRecords: this.backend.size,
      totalSize: Array.from(this.backend.values())
        .reduce((sum, value) => sum + JSON.stringify(value).length, 0),
    };
  }
  
  private startCleanupTasks(): void {
    // 定期清理过期缓存
    const cacheCleanup = setInterval(() => {
      this.cleanupExpired().catch(console.error);
    }, 60000); // 每分钟清理一次
    
    this.cleanupIntervals.set('cache', cacheCleanup);
    
    // 定期清理pending writes
    const writeCleanup = setInterval(() => {
      this.cleanupPendingWrites();
    }, 5000); // 每5秒清理一次
    
    this.cleanupIntervals.set('writes', writeCleanup);
  }
  
  private cleanupPendingWrites(): void {
    // 清理已完成或失败的pending writes
    const now = Date.now();
    
    for (const [key, promise] of this.pendingWrites.entries()) {
      promise
        .then(() => {
          this.pendingWrites.delete(key);
        })
        .catch(() => {
          this.pendingWrites.delete(key);
        });
    }
  }
  
  /**
   * 停止存储管理器
   */
  async stop(): Promise<void> {
    // 清理定时器
    for (const interval of this.cleanupIntervals.values()) {
      clearInterval(interval);
    }
    
    this.cleanupIntervals.clear();
    
    // 等待pending writes完成
    await Promise.all(Array.from(this.pendingWrites.values()));
    
    console.log('🛑 分布式存储管理器已停止');
  }
}