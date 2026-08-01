/**
 * 高性能内存池管理器
 * 借鉴Shimmy的零拷贝和预分配策略
 * 减少GC压力和内存碎片
 */

export interface PoolConfig {
  /** 池大小 */
  poolSize: number;
  /** 最大空闲时间（毫秒） */
  maxIdleTime: number;
  /** 预分配数量 */
  preallocate: number;
  /** 自动回收间隔（毫秒） */
  cleanupInterval: number;
}

export interface PooledObject<T> {
  object: T;
  acquiredAt: number;
  poolId: string;
}

export interface PoolStats {
  poolSize: number;
  available: number;
  inUse: number;
  totalCreated: number;
  totalDestroyed: number;
  peakUsage: number;
}

/**
 * 通用对象池
 */
export class ObjectPool<T> {
  private available: T[] = [];
  private inUse = new Set<T>();
  private factory: () => T;
  private reset: (obj: T) => void;
  private config: PoolConfig;
  private stats = {
    totalCreated: 0,
    totalDestroyed: 0,
    peakUsage: 0,
  };
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    factory: () => T,
    reset: (obj: T) => void,
    config: Partial<PoolConfig> = {}
  ) {
    this.factory = factory;
    this.reset = reset;
    this.config = {
      poolSize: config.poolSize ?? 100,
      maxIdleTime: config.maxIdleTime ?? 300000, // 5分钟
      preallocate: config.preallocate ?? 10,
      cleanupInterval: config.cleanupInterval ?? 60000, // 1分钟
    };

    // 预分配对象
    this.preallocate();

    // 启动定时清理
    this.startCleanupTimer();
  }

  /**
   * 预分配对象
   */
  private preallocate(): void {
    const count = Math.min(this.config.preallocate, this.config.poolSize);
    for (let i = 0; i < count; i++) {
      const obj = this.factory();
      this.available.push(obj);
      this.stats.totalCreated++;
    }
  }

  /**
   * 获取对象
   */
  acquire(): T {
    let obj: T;

    if (this.available.length > 0) {
      obj = this.available.pop()!;
    } else if (this.stats.totalCreated < this.config.poolSize) {
      obj = this.factory();
      this.stats.totalCreated++;
    } else {
      // 池已满，创建临时对象（不受池管理）
      obj = this.factory();
    }

    this.reset(obj);
    this.inUse.add(obj);

    // 更新峰值
    const currentUsage = this.inUse.size;
    if (currentUsage > this.stats.peakUsage) {
      this.stats.peakUsage = currentUsage;
    }

    return obj;
  }

  /**
   * 释放对象回池
   */
  release(obj: T): void {
    if (!this.inUse.has(obj)) {
      return; // 不是池管理的对象
    }

    this.inUse.delete(obj);

    if (this.available.length < this.config.poolSize) {
      this.reset(obj);
      this.available.push(obj);
    } else {
      // 池已满，销毁对象
      this.stats.totalDestroyed++;
    }
  }

  /**
   * 获取池统计信息
   */
  getStats(): PoolStats {
    return {
      poolSize: this.config.poolSize,
      available: this.available.length,
      inUse: this.inUse.size,
      totalCreated: this.stats.totalCreated,
      totalDestroyed: this.stats.totalDestroyed,
      peakUsage: this.stats.peakUsage,
    };
  }

  /**
   * 清空池
   */
  clear(): void {
    this.available = [];
    this.inUse.clear();
    this.stats.totalCreated = 0;
    this.stats.totalDestroyed = 0;
    this.stats.peakUsage = 0;
  }

  /**
   * 销毁池
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
  }

  /**
   * 启动定时清理
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * 执行清理
   */
  private performCleanup(): void {
    // 清理超额空闲对象
    const maxIdle = this.config.poolSize * 0.5;
    while (this.available.length > maxIdle) {
      this.available.pop();
      this.stats.totalDestroyed++;
    }
  }
}

/**
 * 缓冲区池 - 专门用于管理Float32Array等二进制缓冲区
 */
export class BufferPool {
  private pools = new Map<number, Float32Array[]>();
  private maxPoolSize = 20;

  /**
   * 获取缓冲区
   */
  acquire(size: number): Float32Array {
    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    return new Float32Array(size);
  }

  /**
   * 释放缓冲区
   */
  release(buffer: Float32Array): void {
    const size = buffer.length;
    let pool = this.pools.get(size);
    if (!pool) {
      pool = [];
      this.pools.set(size, pool);
    }

    if (pool.length < this.maxPoolSize) {
      // 重置缓冲区内容（安全清理）
      buffer.fill(0);
      pool.push(buffer);
    }
  }

  /**
   * 获取池状态
   */
  getStats(): Record<number, number> {
    const stats: Record<number, number> = {};
    for (const [size, pool] of this.pools.entries()) {
      stats[size] = pool.length;
    }
    return stats;
  }

  /**
   * 清空所有池
   */
  clear(): void {
    this.pools.clear();
  }
}

/**
 * 字符串构建器池
 * 避免频繁的字符串拼接分配
 */
export class StringBuilderPool {
  private pool: string[] = [];
  private maxSize = 50;

  acquire(): StringBuilder {
    return new StringBuilder(this);
  }

  release(builder: StringBuilder): void {
    if (this.pool.length < this.maxSize) {
      builder.clear();
      // 注意：这里不直接存储builder，而是让GC处理
    }
  }
}

export class StringBuilder {
  private parts: string[] = [];
  private pool: StringBuilderPool;

  constructor(pool: StringBuilderPool) {
    this.pool = pool;
  }

  append(str: string): this {
    this.parts.push(str);
    return this;
  }

  toString(): string {
    return this.parts.join("");
  }

  clear(): void {
    this.parts = [];
  }

  getLength(): number {
    return this.parts.reduce((sum, part) => sum + part.length, 0);
  }

  dispose(): void {
    this.clear();
    this.pool.release(this);
  }
}

/**
 * 全局内存管理器
 * 统一管理所有内存池
 */
export class MemoryManager {
  private bufferPool = new BufferPool();
  private stringBuilderPool = new StringBuilderPool();
  private objectPools = new Map<string, ObjectPool<unknown>>();

  /**
   * 获取缓冲区
   */
  getBuffer(size: number): Float32Array {
    return this.bufferPool.acquire(size);
  }

  /**
   * 释放缓冲区
   */
  releaseBuffer(buffer: Float32Array): void {
    this.bufferPool.release(buffer);
  }

  /**
   * 获取字符串构建器
   */
  getStringBuilder(): StringBuilder {
    return this.stringBuilderPool.acquire();
  }

  /**
   * 注册对象池
   */
  registerPool<T>(name: string, factory: () => T, reset: (obj: T) => void, config?: Partial<PoolConfig>): ObjectPool<T> {
    const pool = new ObjectPool(factory, reset, config);
    this.objectPools.set(name, pool as ObjectPool<unknown>);
    return pool;
  }

  /**
   * 获取对象池
   */
  getPool<T>(name: string): ObjectPool<T> | undefined {
    return this.objectPools.get(name) as ObjectPool<T> | undefined;
  }

  /**
   * 获取所有统计信息
   */
  getStats(): {
    buffers: Record<number, number>;
    pools: Record<string, PoolStats>;
  } {
    const pools: Record<string, PoolStats> = {};
    for (const [name, pool] of this.objectPools.entries()) {
      pools[name] = pool.getStats();
    }

    return {
      buffers: this.bufferPool.getStats(),
      pools,
    };
  }

  /**
   * 全局清理
   */
  cleanup(): void {
    this.bufferPool.clear();
    for (const pool of this.objectPools.values()) {
      pool.clear();
    }
  }
}

// 全局单例
let globalMemoryManager: MemoryManager | null = null;

export function getMemoryManager(): MemoryManager {
  if (!globalMemoryManager) {
    globalMemoryManager = new MemoryManager();
  }
  return globalMemoryManager;
}
