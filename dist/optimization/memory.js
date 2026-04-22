/**
 * 内存优化工具
 * 提供智能内存管理、垃圾回收优化和内存泄漏检测
 */
import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
/**
 * 智能内存管理器
 */
export class MemoryManager extends EventEmitter {
    config;
    memoryStats;
    monitorInterval;
    gcObserver;
    objectPools = new Map();
    leakDetector;
    heapSnapshotter;
    MB = 1024 * 1024;
    constructor(config = {}) {
        super();
        this.config = {
            warningThreshold: config.warningThreshold || 512, // 512MB
            dangerThreshold: config.dangerThreshold || 1024, // 1GB
            monitorInterval: config.monitorInterval || 5000, // 5秒
            enableActiveGC: config.enableActiveGC ?? true,
            gcThreshold: config.gcThreshold || 128, // 128MB
            enableMemoryPool: config.enableMemoryPool ?? true,
            poolConfig: {
                poolSize: config.poolConfig?.poolSize || 100,
                maxIdleTime: config.poolConfig?.maxIdleTime || 300000, // 5分钟
                preallocate: config.poolConfig?.preallocate || 10,
            },
            enableLeakDetection: config.enableLeakDetection ?? true,
            leakCheckInterval: config.leakCheckInterval || 60000, // 1分钟
            heapSnapshot: {
                enabled: config.heapSnapshot?.enabled ?? false,
                directory: config.heapSnapshot?.directory || './heapdumps',
                maxSnapshots: config.heapSnapshot?.maxSnapshots || 5,
            },
        };
        this.memoryStats = this.collectMemoryStats();
        // 初始化内存池
        if (this.config.enableMemoryPool) {
            this.initializeObjectPools();
        }
        // 启动监控
        this.startMonitoring();
        // 启动GC监控
        this.startGCMonitoring();
        // 初始化泄漏检测
        if (this.config.enableLeakDetection) {
            this.leakDetector = new MemoryLeakDetector(this.config.leakCheckInterval);
            this.leakDetector.on('leak', (report) => {
                this.emit('memory.leak', report);
            });
        }
        // 初始化堆快照
        if (this.config.heapSnapshot.enabled) {
            this.heapSnapshotter = new HeapSnapshotter({
                directory: this.config.heapSnapshot.directory,
                maxSnapshots: this.config.heapSnapshot.maxSnapshots,
            });
        }
    }
    /**
     * 获取内存池对象
     */
    async acquireFromPool(poolName, creator, validator) {
        if (!this.config.enableMemoryPool) {
            return creator();
        }
        const pool = this.objectPools.get(poolName) || [];
        const now = Date.now();
        // 查找空闲对象
        for (let i = 0; i < pool.length; i++) {
            const pooledObj = pool[i];
            if (pooledObj.isIdle) {
                // 检查对象是否有效
                if (validator && !validator(pooledObj.data)) {
                    pool.splice(i, 1);
                    i--;
                    continue;
                }
                // 检查是否空闲时间过长
                if (now - pooledObj.lastUsed > this.config.poolConfig.maxIdleTime) {
                    pool.splice(i, 1);
                    i--;
                    continue;
                }
                // 激活对象
                pooledObj.isIdle = false;
                pooledObj.lastUsed = now;
                pooledObj.usageCount++;
                this.objectPools.set(poolName, pool);
                console.log(`🎯 从池 ${poolName} 获取对象 (${pooledObj.id})`);
                return pooledObj.data;
            }
        }
        // 没有可用对象，创建新的
        const newObj = creator();
        const pooledObj = {
            id: `pool_${poolName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            data: newObj,
            lastUsed: now,
            usageCount: 1,
            isIdle: false,
        };
        pool.push(pooledObj);
        this.objectPools.set(poolName, pool);
        console.log(`🆕 池 ${poolName} 创建新对象 (${pooledObj.id})`);
        return newObj;
    }
    /**
     * 释放对象到内存池
     */
    releaseToPool(poolName, obj, cleaner) {
        if (!this.config.enableMemoryPool) {
            return;
        }
        const pool = this.objectPools.get(poolName) || [];
        // 查找对应的池对象
        for (const pooledObj of pool) {
            if (pooledObj.data === obj && !pooledObj.isIdle) {
                // 清理对象
                if (cleaner) {
                    cleaner(pooledObj.data);
                }
                // 标记为空闲
                pooledObj.isIdle = true;
                console.log(`🔙 对象释放到池 ${poolName} (${pooledObj.id})`);
                return;
            }
        }
        // 对象不在池中，可能直接丢弃或添加到池中
        if (pool.length < this.config.poolConfig.poolSize) {
            const pooledObj = {
                id: `pool_${poolName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                data: obj,
                lastUsed: Date.now(),
                usageCount: 0,
                isIdle: true,
            };
            pool.push(pooledObj);
            this.objectPools.set(poolName, pool);
            console.log(`➕ 新对象添加到池 ${poolName} (${pooledObj.id})`);
        }
        else {
            // 池已满，丢弃对象
            console.log(`🗑️  池 ${poolName} 已满，丢弃对象`);
        }
    }
    /**
     * 清理内存池
     */
    cleanupPools() {
        if (!this.config.enableMemoryPool) {
            return 0;
        }
        let cleanedCount = 0;
        const now = Date.now();
        for (const [poolName, pool] of this.objectPools.entries()) {
            const initialSize = pool.length;
            // 清理空闲时间过长的对象
            for (let i = pool.length - 1; i >= 0; i--) {
                const pooledObj = pool[i];
                if (pooledObj.isIdle && (now - pooledObj.lastUsed > this.config.poolConfig.maxIdleTime)) {
                    pool.splice(i, 1);
                    cleanedCount++;
                }
            }
            // 清理池大小超过限制的对象（从最旧的空闲对象开始）
            if (pool.length > this.config.poolConfig.poolSize) {
                const toRemove = pool.length - this.config.poolConfig.poolSize;
                const idleObjects = pool.filter(obj => obj.isIdle);
                idleObjects.sort((a, b) => a.lastUsed - b.lastUsed);
                for (let i = 0; i < Math.min(toRemove, idleObjects.length); i++) {
                    const index = pool.findIndex(obj => obj.id === idleObjects[i].id);
                    if (index !== -1) {
                        pool.splice(index, 1);
                        cleanedCount++;
                    }
                }
            }
            if (pool.length < initialSize) {
                console.log(`🧹 清理池 ${poolName}: ${initialSize} -> ${pool.length} 个对象`);
                this.objectPools.set(poolName, pool);
            }
        }
        return cleanedCount;
    }
    /**
     * 获取内存使用统计
     */
    getMemoryStats() {
        this.memoryStats = this.collectMemoryStats();
        return { ...this.memoryStats };
    }
    /**
     * 手动触发垃圾回收（如果启用）
     */
    triggerGC() {
        if (!this.config.enableActiveGC) {
            return false;
        }
        const stats = this.getMemoryStats();
        if (stats.heapUsed > this.config.gcThreshold * this.MB) {
            console.log(`🧹 触发主动垃圾回收 (当前: ${(stats.heapUsed / this.MB).toFixed(2)}MB)`);
            if (global.gc) {
                // 注意：需要启动Node.js时添加 --expose-gc 标志
                global.gc();
                return true;
            }
            else {
                console.warn('⚠️ 无法执行GC，请使用 --expose-gc 标志启动Node.js');
                return false;
            }
        }
        return false;
    }
    /**
     * 获取内存池统计
     */
    getPoolStats() {
        const stats = {};
        for (const [poolName, pool] of this.objectPools.entries()) {
            const idle = pool.filter(obj => obj.isIdle).length;
            const active = pool.length - idle;
            const totalUsage = pool.reduce((sum, obj) => sum + obj.usageCount, 0);
            const avgUsage = pool.length > 0 ? totalUsage / pool.length : 0;
            stats[poolName] = {
                total: pool.length,
                idle,
                active,
                avgUsage,
            };
        }
        return stats;
    }
    /**
     * 生成堆快照
     */
    async takeHeapSnapshot(name) {
        if (!this.config.heapSnapshot.enabled || !this.heapSnapshotter) {
            console.warn('⚠️ 堆快照功能未启用');
            return null;
        }
        return this.heapSnapshotter?.takeSnapshot(name);
    }
    /**
     * 分析堆快照差异
     */
    async analyzeHeapDiff(oldSnapshot, newSnapshot) {
        if (!this.heapSnapshotter) {
            return null;
        }
        return this.heapSnapshotter.analyzeDiff(oldSnapshot, newSnapshot);
    }
    /**
     * 执行内存压力测试
     */
    async stressTest(options) {
        console.log(`🧪 开始内存压力测试: ${options.objectCount} 个对象, ${options.duration}ms`);
        const startMemory = this.getMemoryStats();
        const startGcCount = this.memoryStats.gcCount;
        const startGcTime = this.memoryStats.gcTime;
        // 创建测试对象
        const testObjects = [];
        for (let i = 0; i < options.objectCount; i++) {
            testObjects.push({
                id: i,
                data: Buffer.alloc(options.objectSize),
                timestamp: Date.now(),
            });
        }
        // 保持对象存活一段时间
        await new Promise(resolve => setTimeout(resolve, options.duration));
        const endMemory = this.getMemoryStats();
        return {
            startMemory,
            endMemory,
            memoryGrowth: endMemory.heapUsed - startMemory.heapUsed,
            gcCount: this.memoryStats.gcCount - startGcCount,
            gcTime: this.memoryStats.gcTime - startGcTime,
        };
    }
    /**
     * 停止内存管理器
     */
    async stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        if (this.gcObserver) {
            this.gcObserver.disconnect();
        }
        if (this.leakDetector) {
            this.leakDetector.stop();
        }
        // 清理所有内存池
        this.objectPools.clear();
        console.log('🛑 内存管理器已停止');
    }
    collectMemoryStats() {
        const memoryUsage = process.memoryUsage();
        const stats = {
            processMemory: memoryUsage.rss / this.MB,
            heapUsed: memoryUsage.heapUsed / this.MB,
            heapTotal: memoryUsage.heapTotal / this.MB,
            heapLimit: memoryUsage.heapUsed > 0 ? memoryUsage.heapTotal * 2 / this.MB : 0, // 估算
            externalMemory: memoryUsage.external / this.MB,
            arrayBuffers: memoryUsage.arrayBuffers / this.MB,
            rss: memoryUsage.rss / this.MB,
            pressure: memoryUsage.heapUsed / memoryUsage.heapTotal,
            gcCount: this.memoryStats?.gcCount || 0,
            gcTime: this.memoryStats?.gcTime || 0,
        };
        return stats;
    }
    initializeObjectPools() {
        const preallocate = this.config.poolConfig.preallocate;
        if (preallocate > 0) {
            console.log(`🔄 预分配内存池 (${preallocate} 个对象)`);
            // 这里可以添加预分配逻辑
            // 例如：this.objectPools.set('default', new Array(preallocate).fill(null).map(() => ({})));
        }
    }
    startMonitoring() {
        this.monitorInterval = setInterval(() => {
            this.checkMemoryUsage();
        }, this.config.monitorInterval);
    }
    checkMemoryUsage() {
        const stats = this.getMemoryStats();
        // 检查内存警告
        if (stats.heapUsed > this.config.warningThreshold) {
            console.warn(`⚠️ 内存使用警告: ${stats.heapUsed.toFixed(2)}MB`);
            this.emit('memory.warning', stats);
            // 触发主动清理
            this.triggerGC();
            this.cleanupPools();
        }
        // 检查内存危险
        if (stats.heapUsed > this.config.dangerThreshold) {
            console.error(`🚨 内存使用危险: ${stats.heapUsed.toFixed(2)}MB`);
            this.emit('memory.danger', stats);
            // 紧急措施
            this.emergencyCleanup();
        }
        // 发送常规指标
        this.emit('memory.stats', stats);
    }
    startGCMonitoring() {
        if (performance.clearMeasures) {
            this.gcObserver = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                for (const entry of entries) {
                    if (entry.name.includes('gc') || entry.name.includes('GC')) {
                        this.memoryStats.gcCount++;
                        this.memoryStats.gcTime += entry.duration;
                        console.debug(`🧹 GC事件: ${entry.name}, 耗时: ${entry.duration.toFixed(2)}ms`);
                        this.emit('gc.occurred', entry);
                    }
                }
            });
            this.gcObserver.observe({ entryTypes: ['measure'] });
        }
    }
    emergencyCleanup() {
        console.log('🚨 执行紧急内存清理');
        // 清理所有内存池
        this.objectPools.clear();
        // 尝试触发GC
        this.triggerGC();
        // 发送警报
        this.emit('memory.emergency', this.getMemoryStats());
    }
}
/**
 * 内存泄漏检测器
 */
class MemoryLeakDetector extends EventEmitter {
    checkInterval;
    interval;
    snapshots = new Map();
    MB = 1024 * 1024;
    constructor(checkInterval = 60000) {
        super();
        this.checkInterval = checkInterval;
        this.start();
    }
    start() {
        this.interval = setInterval(() => {
            this.checkForLeaks();
        }, this.checkInterval);
    }
    checkForLeaks() {
        const memoryUsage = process.memoryUsage();
        const heapUsed = memoryUsage.heapUsed;
        const timestamp = Date.now();
        const key = `snapshot_${Math.floor(timestamp / 60000)}`; // 每分钟一个快照
        // 保存当前快照
        const previous = this.snapshots.get(key);
        this.snapshots.set(key, heapUsed);
        // 清理旧快照
        this.cleanupOldSnapshots();
        // 如果有前一个快照，计算增长
        if (previous) {
            const growth = heapUsed - previous;
            const growthRate = (growth / this.MB) * (60000 / this.checkInterval); // MB/分钟
            if (growthRate > 1) { // 增长超过1MB/分钟
                console.warn(`⚠️ 疑似内存泄漏: ${growthRate.toFixed(2)}MB/分钟`);
                const report = {
                    timestamp: new Date(),
                    suspiciousObjects: Math.floor(growth / 1000), // 估算
                    growthRate,
                    leakPoints: this.analyzePotentialLeaks(),
                    suggestions: [
                        '检查长期存活的对象引用',
                        '检查未被清理的事件监听器',
                        '检查缓存策略',
                        '考虑使用内存池',
                    ],
                };
                this.emit('leak', report);
            }
        }
    }
    analyzePotentialLeaks() {
        // 这里应该使用堆分析工具
        // 为了演示，返回一些模拟数据
        return [
            {
                type: 'EventEmitter listeners',
                size: 1024 * 100, // 100KB
                count: 50,
                stackTrace: ['app.js:123:45', 'events.js:456:78'],
            },
            {
                type: 'Cache objects',
                size: 1024 * 500, // 500KB
                count: 1000,
                stackTrace: ['cache.js:89:12', 'store.js:34:56'],
            },
        ];
    }
    cleanupOldSnapshots() {
        const now = Date.now();
        const cutoff = now - 10 * 60 * 1000; // 保留10分钟
        for (const [key] of this.snapshots.entries()) {
            const timestamp = parseInt(key.split('_')[1]) * 60000;
            if (timestamp < cutoff) {
                this.snapshots.delete(key);
            }
        }
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
        }
    }
}
/**
 * 堆快照管理器
 */
class HeapSnapshotter {
    config;
    heapModule;
    constructor(config) {
        this.config = config;
        // 确保目录存在
        const fs = require('fs');
        const path = require('path');
        if (!fs.existsSync(this.config.directory)) {
            fs.mkdirSync(this.config.directory, { recursive: true });
        }
        // 尝试加载heapdump模块
        try {
            this.heapModule = require('heapdump');
        }
        catch (error) {
            console.warn('⚠️ heapdump模块未安装，无法生成堆快照');
            console.warn('安装: npm install heapdump');
        }
    }
    takeSnapshot(name) {
        return new Promise((resolve) => {
            if (!this.heapModule) {
                resolve(null);
                return;
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const snapshotName = name
                ? `${name}_${timestamp}.heapsnapshot`
                : `heapdump_${timestamp}.heapsnapshot`;
            const snapshotPath = require('path').join(this.config.directory, snapshotName);
            this.heapModule.writeSnapshot(snapshotPath, (err, filename) => {
                if (err) {
                    console.error('生成堆快照失败:', err);
                    resolve(null);
                }
                else {
                    console.log(`📸 堆快照已保存: ${snapshotPath}`);
                    resolve(snapshotPath);
                }
            });
        });
    }
    analyzeDiff(oldSnapshot, newSnapshot) {
        // 堆快照差异分析需要专门的工具
        // 这里简化处理
        console.log(`🔍 分析堆快照差异: ${oldSnapshot} -> ${newSnapshot}`);
        return Promise.resolve({
            added: [],
            removed: [],
            sizeChange: 0,
            objectCountChange: 0,
        });
    }
    cleanupOldSnapshots() {
        const fs = require('fs');
        const path = require('path');
        try {
            const files = fs.readdirSync(this.config.directory)
                .filter((file) => file.endsWith('.heapsnapshot'))
                .map((file) => ({
                name: file,
                path: path.join(this.config.directory, file),
                time: fs.statSync(path.join(this.config.directory, file)).mtime.getTime(),
            }))
                .sort((a, b) => b.time - a.time); // 最新的在前
            // 删除超过限制的快照
            if (files.length > this.config.maxSnapshots) {
                for (let i = this.config.maxSnapshots; i < files.length; i++) {
                    fs.unlinkSync(files[i].path);
                    console.log(`🗑️  删除旧堆快照: ${files[i].name}`);
                }
            }
        }
        catch (error) {
            console.error('清理堆快照失败:', error);
        }
    }
}
/**
 * 默认内存管理器实例
 */
export const memoryManager = new MemoryManager();
/**
 * 快速内存检查函数
 */
export function quickMemoryCheck() {
    const manager = new MemoryManager({ monitorInterval: 0 }); // 不使用定时器
    const stats = manager.getMemoryStats();
    const suggestions = [];
    let ok = true;
    if (stats.pressure > 0.8) {
        ok = false;
        suggestions.push('内存压力过高，考虑优化内存使用');
    }
    if (stats.heapUsed > 500) { // 500MB
        ok = false;
        suggestions.push('堆内存使用超过500MB，考虑内存优化');
    }
    if (stats.gcTime > 1000) { // 1秒GC时间
        suggestions.push('GC时间过长，可能存在内存泄漏');
    }
    manager.stop();
    return { ok, memory: stats, suggestions };
}
