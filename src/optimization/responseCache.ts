import { createHash } from "node:crypto";

/**
 * 响应缓存条目
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessed: number;
  accessCount: number;
}

/**
 * LRU缓存配置
 */
export interface LRUCacheConfig {
  maxSize: number;
  defaultTTL: number;
  staleWhileRevalidate?: boolean;
}

/**
 * 缓存统计信息
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  maxSize: number;
  hitRate: number;
}

/**
 * 高性能LRU响应缓存
 * 借鉴Shimmy的零拷贝缓存策略，基于请求哈希实现快速查找
 */
export class ResponseCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private defaultTTL: number;
  private staleWhileRevalidate: boolean;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(config: Partial<LRUCacheConfig> = {}) {
    this.maxSize = config.maxSize ?? 500;
    this.defaultTTL = config.defaultTTL ?? 30 * 60 * 1000; // 默认30分钟
    this.staleWhileRevalidate = config.staleWhileRevalidate ?? false;
  }

  /**
   * 生成缓存键
   * 使用快速哈希避免长字符串比较
   */
  generateKey(prompt: string, options?: Record<string, unknown>): string {
    const hash = createHash("sha256");
    hash.update(prompt);
    if (options) {
      // 排除随机性和时效性字段
      const cacheableOptions = { ...options };
      delete (cacheableOptions as Record<string, unknown>).seed;
      delete (cacheableOptions as Record<string, unknown>).signal;
      hash.update(JSON.stringify(cacheableOptions));
    }
    return hash.digest("hex").slice(0, 32);
  }

  /**
   * 获取缓存值
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const now = Date.now();
    if (entry.expiresAt < now) {
      if (this.staleWhileRevalidate) {
        // 允许返回过期数据（后台可刷新）
        this.stats.hits++;
        entry.lastAccessed = now;
        entry.accessCount++;
        return entry.value;
      }
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    entry.lastAccessed = now;
    entry.accessCount++;

    // 热数据前置（LRU策略）
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * 设置缓存值
   */
  set(key: string, value: T, ttl?: number): void {
    const now = Date.now();
    const expiresAt = now + (ttl ?? this.defaultTTL);

    // 检查是否需要驱逐
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const entry: CacheEntry<T> = {
      value,
      expiresAt,
      lastAccessed: now,
      accessCount: 1,
    };

    this.cache.set(key, entry);
  }

  /**
   * 删除缓存项
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
  }

  /**
   * 获取统计信息
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      currentSize: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * 定期清理过期缓存
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
        purged++;
      }
    }
    return purged;
  }

  /**
   * LRU驱逐策略 - 移除最近最少访问的条目
   */
  private evictLRU(): void {
    if (this.cache.size === 0) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      // 优先驱逐访问次数少的，其次驱逐最近访问时间早的
      if (entry.accessCount === 1 || entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }
}

/**
 * 流式响应缓存管理器
 * 支持流式数据的增量缓存和恢复
 */
export class StreamingResponseCache {
  private chunks = new Map<string, string[]>();
  private metadata = new Map<string, { model?: string; startTime: number }>();

  startStream(key: string, model?: string): void {
    this.chunks.set(key, []);
    this.metadata.set(key, { model, startTime: Date.now() });
  }

  appendChunk(key: string, chunk: string): void {
    const chunks = this.chunks.get(key);
    if (chunks) {
      chunks.push(chunk);
    }
  }

  getStream(key: string): { chunks: string[]; metadata: { model?: string; startTime: number } } | null {
    const chunks = this.chunks.get(key);
    const meta = this.metadata.get(key);
    if (chunks && meta) {
      return { chunks: [...chunks], metadata: meta };
    }
    return null;
  }

  endStream(key: string): void {
    this.chunks.delete(key);
    this.metadata.delete(key);
  }
}
