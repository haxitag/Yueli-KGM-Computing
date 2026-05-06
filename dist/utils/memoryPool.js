/**
 * 高性能内存池管理器
 * 借鉴Shimmy的零拷贝和预分配策略
 * 减少GC压力和内存碎片
 */
/**
 * 通用对象池
 */
export class ObjectPool {
    available = [];
    inUse = new Set();
    factory;
    reset;
    config;
    stats = {
        totalCreated: 0,
        totalDestroyed: 0,
        peakUsage: 0,
    };
    cleanupTimer = null;
    constructor(factory, reset, config = {}) {
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
    preallocate() {
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
    acquire() {
        let obj;
        if (this.available.length > 0) {
            obj = this.available.pop();
        }
        else if (this.stats.totalCreated < this.config.poolSize) {
            obj = this.factory();
            this.stats.totalCreated++;
        }
        else {
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
    release(obj) {
        if (!this.inUse.has(obj)) {
            return; // 不是池管理的对象
        }
        this.inUse.delete(obj);
        if (this.available.length < this.config.poolSize) {
            this.reset(obj);
            this.available.push(obj);
        }
        else {
            // 池已满，销毁对象
            this.stats.totalDestroyed++;
        }
    }
    /**
     * 获取池统计信息
     */
    getStats() {
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
    clear() {
        this.available = [];
        this.inUse.clear();
        this.stats.totalCreated = 0;
        this.stats.totalDestroyed = 0;
        this.stats.peakUsage = 0;
    }
    /**
     * 销毁池
     */
    destroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.clear();
    }
    /**
     * 启动定时清理
     */
    startCleanupTimer() {
        this.cleanupTimer = setInterval(() => {
            this.performCleanup();
        }, this.config.cleanupInterval);
    }
    /**
     * 执行清理
     */
    performCleanup() {
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
    pools = new Map();
    maxPoolSize = 20;
    /**
     * 获取缓冲区
     */
    acquire(size) {
        const pool = this.pools.get(size);
        if (pool && pool.length > 0) {
            return pool.pop();
        }
        return new Float32Array(size);
    }
    /**
     * 释放缓冲区
     */
    release(buffer) {
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
    getStats() {
        const stats = {};
        for (const [size, pool] of this.pools.entries()) {
            stats[size] = pool.length;
        }
        return stats;
    }
    /**
     * 清空所有池
     */
    clear() {
        this.pools.clear();
    }
}
/**
 * 字符串构建器池
 * 避免频繁的字符串拼接分配
 */
export class StringBuilderPool {
    pool = [];
    maxSize = 50;
    acquire() {
        return new StringBuilder(this);
    }
    release(builder) {
        if (this.pool.length < this.maxSize) {
            builder.clear();
            // 注意：这里不直接存储builder，而是让GC处理
        }
    }
}
export class StringBuilder {
    parts = [];
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    append(str) {
        this.parts.push(str);
        return this;
    }
    toString() {
        return this.parts.join("");
    }
    clear() {
        this.parts = [];
    }
    getLength() {
        return this.parts.reduce((sum, part) => sum + part.length, 0);
    }
    dispose() {
        this.clear();
        this.pool.release(this);
    }
}
/**
 * 全局内存管理器
 * 统一管理所有内存池
 */
export class MemoryManager {
    bufferPool = new BufferPool();
    stringBuilderPool = new StringBuilderPool();
    objectPools = new Map();
    /**
     * 获取缓冲区
     */
    getBuffer(size) {
        return this.bufferPool.acquire(size);
    }
    /**
     * 释放缓冲区
     */
    releaseBuffer(buffer) {
        this.bufferPool.release(buffer);
    }
    /**
     * 获取字符串构建器
     */
    getStringBuilder() {
        return this.stringBuilderPool.acquire();
    }
    /**
     * 注册对象池
     */
    registerPool(name, factory, reset, config) {
        const pool = new ObjectPool(factory, reset, config);
        this.objectPools.set(name, pool);
        return pool;
    }
    /**
     * 获取对象池
     */
    getPool(name) {
        return this.objectPools.get(name);
    }
    /**
     * 获取所有统计信息
     */
    getStats() {
        const pools = {};
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
    cleanup() {
        this.bufferPool.clear();
        for (const pool of this.objectPools.values()) {
            pool.clear();
        }
    }
}
// 全局单例
let globalMemoryManager = null;
export function getMemoryManager() {
    if (!globalMemoryManager) {
        globalMemoryManager = new MemoryManager();
    }
    return globalMemoryManager;
}
