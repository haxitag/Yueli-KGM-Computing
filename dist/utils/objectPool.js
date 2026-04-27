/**
 * Object Pool - 减少 GC 压力
 * 复用频繁创建的对象：Buffer、Array、Response 对象
 */
import { EventEmitter } from "node:events";
class ObjectPool extends EventEmitter {
    pool = [];
    factory;
    reset;
    config;
    stats = {
        created: 0,
        reused: 0,
        destroyed: 0,
        peakSize: 0,
    };
    constructor(factory, reset, config = {}) {
        super();
        this.factory = factory;
        this.reset = reset;
        this.config = {
            initialSize: config.initialSize ?? 10,
            maxSize: config.maxSize ?? 100,
            growthFactor: config.growthFactor ?? 0.5,
        };
        // 预创建初始对象
        for (let i = 0; i < this.config.initialSize; i++) {
            this.createObject();
        }
    }
    createObject() {
        const obj = {
            object: this.factory(),
            inUse: false,
            lastUsed: Date.now(),
            useCount: 0,
        };
        this.pool.push(obj);
        this.stats.created++;
        return obj;
    }
    /**
     * 获取对象
     */
    acquire() {
        // 找空闲对象
        let pooledObj = this.pool.find((p) => !p.inUse);
        if (!pooledObj) {
            // 池已满，创建新对象（如果允许）
            if (this.pool.length < this.config.maxSize) {
                const growth = Math.max(1, Math.floor(this.pool.length * this.config.growthFactor));
                for (let i = 0; i < growth && this.pool.length < this.config.maxSize; i++) {
                    this.createObject();
                }
                pooledObj = this.pool.find((p) => !p.inUse);
            }
        }
        if (pooledObj) {
            pooledObj.inUse = true;
            pooledObj.lastUsed = Date.now();
            pooledObj.useCount++;
            this.reset(pooledObj.object);
            this.stats.reused++;
            this.stats.peakSize = Math.max(this.stats.peakSize, this.pool.length);
            return pooledObj.object;
        }
        // 池已满，创建临时对象（不加入池）
        this.emit("poolExhausted");
        return this.factory();
    }
    /**
     * 释放对象回池
     */
    release(obj) {
        const pooledObj = this.pool.find((p) => p.object === obj);
        if (pooledObj) {
            pooledObj.inUse = false;
            pooledObj.lastUsed = Date.now();
            this.reset(obj);
        }
    }
    /**
     * 清空池
     */
    clear() {
        this.pool = [];
        this.stats.created = 0;
        this.stats.reused = 0;
        this.stats.destroyed = 0;
        this.stats.peakSize = 0;
    }
    /**
     * 获取统计
     */
    getStats() {
        return {
            ...this.stats,
            currentSize: this.pool.length,
            inUse: this.pool.filter((p) => p.inUse).length,
            available: this.pool.filter((p) => !p.inUse).length,
        };
    }
}
// ==================== 专用对象池 ====================
/**
 * Buffer 池 - 用于流式响应
 */
export const bufferPool = new ObjectPool(() => Buffer.allocUnsafe(8192), // 8KB 初始
(buf) => buf.fill(0), { initialSize: 50, maxSize: 200 });
/**
 * Uint8Array 池 - 用于二进制数据
 */
export const uint8ArrayPool = new ObjectPool(() => new Uint8Array(4096), (arr) => arr.fill(0), { initialSize: 50, maxSize: 200 });
/**
 * 字符串数组池 - 用于 token 累积
 */
export const stringArrayPool = new ObjectPool(() => [], (arr) => {
    arr.length = 0;
}, { initialSize: 100, maxSize: 500 });
export const responseChunkPool = new ObjectPool(() => ({
    id: "",
    object: "chat.completion.chunk",
    created: 0,
    model: "",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
}), (chunk) => {
    chunk.id = "";
    chunk.created = 0;
    chunk.model = "";
    chunk.choices[0].index = 0;
    chunk.choices[0].delta = {};
    chunk.choices[0].finish_reason = null;
}, { initialSize: 100, maxSize: 500 });
export const contextPool = new ObjectPool(() => ({
    requestId: "",
    startTime: 0,
    metadata: {},
    tokens: { prompt: 0, completion: 0, total: 0 },
}), (ctx) => {
    ctx.requestId = "";
    ctx.startTime = 0;
    ctx.metadata = {};
    ctx.tokens = { prompt: 0, completion: 0, total: 0 };
}, { initialSize: 50, maxSize: 200 });
// ==================== 高级对象池管理器 ====================
export class ObjectPoolManager extends EventEmitter {
    pools = new Map();
    register(name, pool) {
        this.pools.set(name, pool);
    }
    getPoolStats() {
        const stats = {};
        for (const [name, pool] of this.pools) {
            stats[name] = pool.getStats();
        }
        return stats;
    }
    clearAll() {
        for (const pool of this.pools.values()) {
            pool.clear();
        }
    }
}
export const globalPoolManager = new ObjectPoolManager();
// 注册所有池
globalPoolManager.register("buffer", bufferPool);
globalPoolManager.register("uint8Array", uint8ArrayPool);
globalPoolManager.register("stringArray", stringArrayPool);
globalPoolManager.register("responseChunk", responseChunkPool);
globalPoolManager.register("context", contextPool);
// ==================== 便捷导出 ====================
export { ObjectPool, };
