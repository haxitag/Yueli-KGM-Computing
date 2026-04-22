import { createHash } from "node:crypto";
/**
 * 基于Map的前缀缓存实现
 * 包含LRU淘汰机制
 */
export class MapPrefixCache {
    cache = new Map();
    refCounts = new Map();
    accessOrder = new Map();
    accessCounter = 0;
    stats = {
        totalBlocks: 0,
        cachedBlocks: 0,
        hitRate: 0,
        memoryBytes: 0,
        totalRequests: 0,
        cacheHits: 0,
        cacheMisses: 0,
    };
    maxMemoryBytes;
    constructor(options) {
        this.maxMemoryBytes = options?.maxMemoryBytes;
    }
    getBlocks(contextHash) {
        this.stats.totalRequests++;
        this.updateAccessOrder(contextHash);
        const blocks = this.cache.get(contextHash);
        if (blocks) {
            this.stats.cacheHits++;
            this.updateHitRate();
            return blocks;
        }
        this.stats.cacheMisses++;
        this.updateHitRate();
        return null;
    }
    setBlocks(contextHash, blocks) {
        // 检查内存限制
        const newMemoryBytes = blocks.reduce((sum, b) => sum + b.kCache.byteLength + b.vCache.byteLength, 0);
        if (this.maxMemoryBytes) {
            this.evict(this.stats.memoryBytes + newMemoryBytes - this.maxMemoryBytes);
        }
        this.cache.set(contextHash, blocks);
        this.refCounts.set(contextHash, 1);
        this.updateAccessOrder(contextHash);
        this.stats.cachedBlocks += blocks.length;
        this.stats.memoryBytes += newMemoryBytes;
    }
    ref(contextHash) {
        const count = this.refCounts.get(contextHash) ?? 0;
        this.refCounts.set(contextHash, count + 1);
        this.updateAccessOrder(contextHash);
    }
    unref(contextHash) {
        const count = this.refCounts.get(contextHash) ?? 0;
        if (count <= 1) {
            const blocks = this.cache.get(contextHash);
            if (blocks) {
                const memoryBytes = blocks.reduce((sum, b) => sum + b.kCache.byteLength + b.vCache.byteLength, 0);
                this.stats.cachedBlocks -= blocks.length;
                this.stats.memoryBytes -= memoryBytes;
            }
            this.cache.delete(contextHash);
            this.refCounts.delete(contextHash);
            this.accessOrder.delete(contextHash);
        }
        else {
            this.refCounts.set(contextHash, count - 1);
            this.updateAccessOrder(contextHash);
        }
    }
    getStats() {
        return { ...this.stats };
    }
    clear() {
        this.cache.clear();
        this.refCounts.clear();
        this.accessOrder.clear();
        this.stats = {
            totalBlocks: 0,
            cachedBlocks: 0,
            hitRate: 0,
            memoryBytes: 0,
            totalRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
        };
    }
    evict(targetMemoryBytes) {
        const targetBytes = targetMemoryBytes ?? this.stats.memoryBytes * 0.8;
        // 按LRU顺序淘汰
        const sortedEntries = Array.from(this.cache.entries()).sort((a, b) => {
            const orderA = this.accessOrder.get(a[0]) ?? 0;
            const orderB = this.accessOrder.get(b[0]) ?? 0;
            return orderA - orderB;
        });
        for (const [hash, blocks] of sortedEntries) {
            if (this.stats.memoryBytes <= targetBytes)
                break;
            const refCount = this.refCounts.get(hash) ?? 0;
            if (refCount > 0)
                continue;
            const memoryBytes = blocks.reduce((sum, b) => sum + b.kCache.byteLength + b.vCache.byteLength, 0);
            this.cache.delete(hash);
            this.refCounts.delete(hash);
            this.accessOrder.delete(hash);
            this.stats.cachedBlocks -= blocks.length;
            this.stats.memoryBytes -= memoryBytes;
        }
    }
    updateAccessOrder(hash) {
        this.accessOrder.set(hash, this.accessCounter++);
    }
    updateHitRate() {
        if (this.stats.totalRequests === 0) {
            this.stats.hitRate = 0;
        }
        else {
            this.stats.hitRate = this.stats.cacheHits / this.stats.totalRequests;
        }
    }
}
/**
 * 稳定上下文哈希器
 * 计算ContextPack的确定性哈希
 */
export class StableContextHasher {
    /**
     * 计算稳定上下文的哈希
     * 只包含影响推理的部分:
     * - 系统提示词
     * - 工具定义
     * - 输出schema
     * - 静态约束
     */
    computeHash(stableContext) {
        const normalized = this.normalizeStableContext(stableContext);
        return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    }
    /**
     * 标准化稳定上下文
     */
    normalizeStableContext(context) {
        if (typeof context !== "object" || context === null) {
            return context;
        }
        if (Array.isArray(context)) {
            return context.map((item) => this.normalizeStableContext(item));
        }
        const result = {};
        const keys = Object.keys(context).sort();
        for (const key of keys) {
            result[key] = this.normalizeStableContext(context[key]);
        }
        return result;
    }
}
/**
 * 创建稳定上下文哈希
 */
export function computeStableContextHash(context) {
    const hasher = new StableContextHasher();
    return hasher.computeHash(context);
}
