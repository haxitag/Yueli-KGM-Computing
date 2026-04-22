/**
 * Paged KV Cache管理器
 * 实现PagedAttention + CoW机制
 */
export class PagedKvCacheManager {
    physicalBlocks = new Map();
    logicalBlocks = new Map();
    pageSize;
    maxBlocks;
    usedBlocks = 0;
    hiddenSize;
    lruQueue = [];
    constructor(options = {}) {
        this.pageSize = options.pageSize ?? 16;
        this.maxBlocks = options.maxBlocks ?? 1024;
        this.hiddenSize = options.hiddenSize ?? 4096;
    }
    /**
     * 分配物理块
     */
    allocateBlock() {
        if (this.usedBlocks >= this.maxBlocks) {
            // 尝试LRU淘汰
            if (!this.evictLRU()) {
                return null; // OOM
            }
        }
        const block = {
            id: this.generateId(),
            kCache: new Float32Array(this.pageSize * this.hiddenSize),
            vCache: new Float32Array(this.pageSize * this.hiddenSize),
            refCount: 1,
            isShared: false,
            lastAccessed: Date.now(),
        };
        this.physicalBlocks.set(block.id, block);
        this.usedBlocks++;
        this.lruQueue.push(block.id);
        return block;
    }
    /**
     * 释放物理块
     */
    freeBlock(blockId) {
        const block = this.physicalBlocks.get(blockId);
        if (!block)
            return;
        block.refCount--;
        if (block.refCount <= 0) {
            this.physicalBlocks.delete(blockId);
            this.usedBlocks--;
            this.lruQueue = this.lruQueue.filter((id) => id !== blockId);
        }
    }
    /**
     * 写时复制
     */
    copyOnWrite(blockId) {
        const original = this.physicalBlocks.get(blockId);
        if (!original) {
            throw new Error(`block_not_found:${blockId}`);
        }
        // 更新访问时间
        original.lastAccessed = Date.now();
        if (!original.isShared) {
            original.isShared = true;
            original.refCount++;
            return original;
        }
        // 创建新副本
        const copy = this.allocateBlock();
        if (!copy) {
            throw new Error("out_of_memory: cannot allocate block for CoW");
        }
        copy.kCache.set(original.kCache);
        copy.vCache.set(original.vCache);
        copy.isShared = false;
        copy.lastAccessed = Date.now();
        return copy;
    }
    /**
     * 获取或分配逻辑块
     */
    getLogicalBlock(requestId, tokenIndex) {
        const blocks = this.logicalBlocks.get(requestId) ?? [];
        const blockIndex = Math.floor(tokenIndex / this.pageSize);
        if (blocks[blockIndex]) {
            // 更新访问时间
            const physical = this.physicalBlocks.get(blocks[blockIndex].physicalBlockId);
            if (physical) {
                physical.lastAccessed = Date.now();
            }
            return blocks[blockIndex];
        }
        // 分配新的物理块
        const physical = this.allocateBlock();
        if (!physical) {
            throw new Error("out_of_memory: cannot allocate block");
        }
        const logical = {
            physicalBlockId: physical.id,
            tokenStart: blockIndex * this.pageSize,
            tokenEnd: (blockIndex + 1) * this.pageSize,
            hash: this.generateHash(blockIndex, requestId),
        };
        blocks[blockIndex] = logical;
        this.logicalBlocks.set(requestId, blocks);
        return logical;
    }
    /**
     * 写入KV缓存
     */
    writeKvCache(requestId, tokenIndex, kCache, vCache) {
        const logical = this.getLogicalBlock(requestId, tokenIndex);
        const physical = this.physicalBlocks.get(logical.physicalBlockId);
        if (!physical) {
            throw new Error(`physical_block_not_found:${logical.physicalBlockId}`);
        }
        // 如果是共享块,执行CoW
        if (physical.isShared) {
            const newPhysical = this.copyOnWrite(logical.physicalBlockId);
            // 更新逻辑块引用
            const blocks = this.logicalBlocks.get(requestId);
            const blockIndex = Math.floor(tokenIndex / this.pageSize);
            blocks[blockIndex].physicalBlockId = newPhysical.id;
        }
        // 写入KV缓存
        const offsetInBlock = tokenIndex % this.pageSize;
        const writeOffset = offsetInBlock * this.hiddenSize;
        for (let i = 0; i < this.hiddenSize; i++) {
            physical.kCache[writeOffset + i] = kCache[i];
            physical.vCache[writeOffset + i] = vCache[i];
        }
        physical.lastAccessed = Date.now();
    }
    /**
     * 读取KV缓存
     */
    readKvCache(requestId, tokenIndex) {
        const blocks = this.logicalBlocks.get(requestId);
        if (!blocks)
            return null;
        const blockIndex = Math.floor(tokenIndex / this.pageSize);
        const logical = blocks[blockIndex];
        if (!logical)
            return null;
        const physical = this.physicalBlocks.get(logical.physicalBlockId);
        if (!physical)
            return null;
        const offsetInBlock = tokenIndex % this.pageSize;
        const readOffset = offsetInBlock * this.hiddenSize;
        const kCache = physical.kCache.slice(readOffset, readOffset + this.hiddenSize);
        const vCache = physical.vCache.slice(readOffset, readOffset + this.hiddenSize);
        physical.lastAccessed = Date.now();
        return { kCache, vCache };
    }
    /**
     * 共享逻辑块
     */
    shareLogicalBlock(sourceRequestId, sourceTokenIndex, targetRequestId) {
        const sourceBlocks = this.logicalBlocks.get(sourceRequestId);
        if (!sourceBlocks)
            return;
        const sourceBlockIndex = Math.floor(sourceTokenIndex / this.pageSize);
        const sourceLogical = sourceBlocks[sourceBlockIndex];
        if (!sourceLogical)
            return;
        const targetBlocks = this.logicalBlocks.get(targetRequestId) ?? [];
        const targetBlockIndex = Math.floor(sourceTokenIndex / this.pageSize);
        // 增加物理块引用计数
        const physical = this.physicalBlocks.get(sourceLogical.physicalBlockId);
        if (physical) {
            physical.refCount++;
            physical.isShared = true;
            physical.lastAccessed = Date.now();
        }
        targetBlocks[targetBlockIndex] = { ...sourceLogical };
        this.logicalBlocks.set(targetRequestId, targetBlocks);
    }
    /**
     * 批量共享逻辑块
     */
    shareLogicalBlocks(sourceRequestId, targetRequestId, count) {
        for (let i = 0; i < count; i++) {
            this.shareLogicalBlock(sourceRequestId, i * this.pageSize, targetRequestId);
        }
    }
    /**
     * 清理请求的所有块
     */
    cleanup(requestId) {
        const blocks = this.logicalBlocks.get(requestId);
        if (!blocks)
            return;
        for (const logical of blocks) {
            this.freeBlock(logical.physicalBlockId);
        }
        this.logicalBlocks.delete(requestId);
    }
    /**
     * 获取统计信息
     */
    getStats() {
        const totalMemoryBytes = this.maxBlocks * this.pageSize * this.hiddenSize * 8; // 2 * float32
        const usedMemoryBytes = this.usedBlocks * this.pageSize * this.hiddenSize * 8;
        const sharedBlocks = Array.from(this.physicalBlocks.values()).filter((b) => b.isShared).length;
        return {
            totalBlocks: this.maxBlocks,
            usedBlocks: this.usedBlocks,
            utilization: this.usedBlocks / this.maxBlocks,
            sharedBlocks,
            totalMemoryBytes,
            usedMemoryBytes,
        };
    }
    /**
     * LRU淘汰
     */
    evictLRU() {
        if (this.lruQueue.length === 0)
            return false;
        // 找到最久未使用的可释放块
        for (let i = 0; i < this.lruQueue.length; i++) {
            const blockId = this.lruQueue[i];
            const block = this.physicalBlocks.get(blockId);
            if (block && block.refCount <= 1 && !block.isShared) {
                this.freeBlock(blockId);
                return true;
            }
        }
        return false;
    }
    /**
     * 生成唯一ID
     */
    generateId() {
        return `blk_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    /**
     * 生成哈希
     */
    generateHash(blockIndex, requestId) {
        return `hash_${blockIndex}_${requestId}`;
    }
    /**
     * 获取物理块
     */
    getPhysicalBlock(blockId) {
        return this.physicalBlocks.get(blockId);
    }
    /**
     * 获取逻辑块
     */
    getLogicalBlocks(requestId) {
        return this.logicalBlocks.get(requestId);
    }
}
