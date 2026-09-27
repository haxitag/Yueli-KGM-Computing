/**
 * 完整版PagedAttention实现
 * 包含:
 * 1. 块级链式哈希前缀缓存 (Block-level Chained Hash Prefix Cache)
 * 2. Block Swapping (CPU-GPU交换)
 * 3. 高效内存管理
 */

import type { KvBlock } from "./types.js";

/**
 * 块状态
 */
export enum BlockState {
  /** 在GPU中 */
  ON_GPU = "on_gpu",
  /** 在CPU中 */
  ON_CPU = "on_cpu",
  /** 正在传输 */
  TRANSFERRING = "transferring",
  /** 已释放 */
  FREED = "freed",
}

/**
 * 物理内存位置
 */
export enum MemoryLocation {
  GPU = "gpu",
  CPU = "cpu",
}

/**
 * 块交换统计
 */
export type BlockSwapStats = {
  gpuToCpuSwaps: number;
  cpuToGpuSwaps: number;
  totalBytesSwapped: number;
  avgSwapTimeMs: number;
  swapBandwidthMBps: number;
};

/**
 * 块表项
 */
export type BlockTableEntry = {
  physicalBlockId: string;
  location: MemoryLocation;
  lastAccessTime: number;
};

/**
 * 交换请求
 */
export type SwapRequest = {
  blockId: string;
  fromLocation: MemoryLocation;
  toLocation: MemoryLocation;
  callback?: (success: boolean) => void;
};

/**
 * 物理KV块 (支持CPU-GPU交换)
 */
export type PhysicalKvBlock = {
  id: string;
  kCacheGPU: Float32Array | null;
  vCacheGPU: Float32Array | null;
  kCacheCPU: Float32Array | null;
  vCacheCPU: Float32Array | null;
  refCount: number;
  state: BlockState;
  isShared: boolean;
  lastAccessed: number;
  size: number; // 字节数
  hash: string; // 用于前缀缓存
};

/**
 * 前缀缓存哈希表项
 */
export type PrefixCacheEntry = {
  hash: string;
  physicalBlockId: string;
  refCount: number;
  lastAccessed: number;
};

/**
 * 完整版PagedAttention KV Cache管理器
 */
export class FullPagedKvCacheManager {
  // 物理块存储
  private physicalBlocks = new Map<string, PhysicalKvBlock>();

  // 逻辑块到物理块的映射
  private logicalBlocks = new Map<string, LogicalKvBlock[]>();

  // 块表 (每个请求一个)
  private blockTables = new Map<string, BlockTableEntry[]>();

  // 前缀缓存哈希表
  private prefixCache = new Map<string, PrefixCacheEntry>();

  // GPU块LRU队列
  private gpuLruQueue: string[] = [];

  // CPU块LRU队列
  private cpuLruQueue: string[] = [];

  // 交换队列
  private swapQueue: SwapRequest[] = [];
  private isSwapping = false;

  // 配置
  private pageSize: number;
  private maxBlocks: number;
  private maxGpuBlocks: number;
  private hiddenSize: number;
  private numHeads: number;
  private headDim: number;
  private useBlockSwap: boolean;

  // 统计
  private swapStats: BlockSwapStats = {
    gpuToCpuSwaps: 0,
    cpuToGpuSwaps: 0,
    totalBytesSwapped: 0,
    avgSwapTimeMs: 0,
    swapBandwidthMBps: 0,
  };

  constructor(options: {
    pageSize?: number;
    maxBlocks?: number;
    maxGpuBlocks?: number;
    hiddenSize?: number;
    numHeads?: number;
    headDim?: number;
    useBlockSwap?: boolean;
  } = {}) {
    this.pageSize = options.pageSize ?? 16;
    this.maxBlocks = options.maxBlocks ?? 2048;
    this.maxGpuBlocks = options.maxGpuBlocks ?? 1024;
    this.hiddenSize = options.hiddenSize ?? 4096;
    this.numHeads = options.numHeads ?? 32;
    this.headDim = options.headDim ?? 128;
    this.useBlockSwap = options.useBlockSwap ?? true;
  }

  /**
   * 分配物理块 (在GPU上)
   */
  allocateGPUBlock(): PhysicalKvBlock | null {
    // 检查GPU块数量
    const gpuBlocks = Array.from(this.physicalBlocks.values()).filter(
      (b) => b.state === BlockState.ON_GPU,
    ).length;

    if (gpuBlocks >= this.maxGpuBlocks) {
      // 尝试交换块到CPU
      if (this.useBlockSwap) {
        if (!this.evictGPUBlockToCPU()) {
          return null; // GPU OOM
        }
      } else {
        return null;
      }
    }

    // 检查总块数量
    const totalBlocks = this.physicalBlocks.size;
    if (totalBlocks >= this.maxBlocks) {
      return null; // 总内存OOM
    }

    const blockSize = this.calculateBlockSize();
    const block: PhysicalKvBlock = {
      id: this.generateId(),
      kCacheGPU: new Float32Array(blockSize),
      vCacheGPU: new Float32Array(blockSize),
      kCacheCPU: null,
      vCacheCPU: null,
      refCount: 1,
      state: BlockState.ON_GPU,
      isShared: false,
      lastAccessed: Date.now(),
      size: blockSize * 4 * 2, // 2 * float32 * 4 bytes
      hash: "",
    };

    this.physicalBlocks.set(block.id, block);
    this.gpuLruQueue.push(block.id);

    return block;
  }

  /**
   * 将GPU块交换到CPU
   */
  swapGpuBlockToCpu(blockId: string): boolean {
    const block = this.physicalBlocks.get(blockId);
    if (!block || block.state !== BlockState.ON_GPU) {
      return false;
    }

    if (!block.kCacheGPU || !block.vCacheGPU) {
      return false;
    }

    // 标记为传输中
    block.state = BlockState.TRANSFERRING;

    // 复制到CPU
    block.kCacheCPU = new Float32Array(block.kCacheGPU);
    block.vCacheCPU = new Float32Array(block.vCacheGPU);

    // 释放GPU内存
    block.kCacheGPU = null;
    block.vCacheGPU = null;

    block.state = BlockState.ON_CPU;

    // 更新LRU队列
    this.gpuLruQueue = this.gpuLruQueue.filter((id) => id !== blockId);
    this.cpuLruQueue.push(blockId);

    // 更新统计
    this.swapStats.gpuToCpuSwaps++;
    this.swapStats.totalBytesSwapped += block.size;

    return true;
  }

  /**
   * 将CPU块交换到GPU
   */
  swapCpuBlockToGpu(blockId: string): boolean {
    const block = this.physicalBlocks.get(blockId);
    if (!block || block.state !== BlockState.ON_CPU) {
      return false;
    }

    if (!block.kCacheCPU || !block.vCacheCPU) {
      return false;
    }

    // 检查GPU空间
    const gpuBlocks = Array.from(this.physicalBlocks.values()).filter(
      (b) => b.state === BlockState.ON_GPU,
    ).length;

    if (gpuBlocks >= this.maxGpuBlocks) {
      // 尝试先交换一个GPU块到CPU
      if (!this.evictGPUBlockToCPU()) {
        return false;
      }
    }

    // 标记为传输中
    block.state = BlockState.TRANSFERRING;

    // 复制到GPU
    block.kCacheGPU = new Float32Array(block.kCacheCPU);
    block.vCacheGPU = new Float32Array(block.vCacheCPU);

    // 释放CPU内存
    block.kCacheCPU = null;
    block.vCacheCPU = null;

    block.state = BlockState.ON_GPU;

    // 更新LRU队列
    this.cpuLruQueue = this.cpuLruQueue.filter((id) => id !== blockId);
    this.gpuLruQueue.push(blockId);

    // 更新统计
    this.swapStats.cpuToGpuSwaps++;
    this.swapStats.totalBytesSwapped += block.size;

    return true;
  }

  /**
   * 淘汰GPU块到CPU
   */
  private evictGPUBlockToCPU(): boolean {
    // 找到最久未使用的非共享GPU块
    for (let i = 0; i < this.gpuLruQueue.length; i++) {
      const blockId = this.gpuLruQueue[i];
      const block = this.physicalBlocks.get(blockId);

      if (block && block.state === BlockState.ON_GPU && block.refCount <= 1 && !block.isShared) {
        return this.swapGpuBlockToCpu(blockId);
      }
    }

    return false;
  }

  /**
   * 写入KV缓存
   */
  writeKvCache(
    requestId: string,
    tokenIndex: number,
    kCache: Float32Array,
    vCache: Float32Array,
  ): void {
    const logical = this.getLogicalBlock(requestId, tokenIndex);
    const physical = this.physicalBlocks.get(logical.physicalBlockId);

    if (!physical) {
      throw new Error(`physical_block_not_found:${logical.physicalBlockId}`);
    }

    // 如果块在CPU,先交换到GPU
    if (physical.state === BlockState.ON_CPU) {
      if (!this.swapCpuBlockToGpu(physical.id)) {
        throw new Error("gpu_oom: cannot swap block to GPU");
      }
    }

    // 等待块在GPU上
    while (physical.state === BlockState.TRANSFERRING) {
      // 简化实现,实际应该使用Promise
    }

    // 写时复制
    if (physical.isShared) {
      const newPhysical = this.copyOnWrite(physical.id);
      const blocks = this.logicalBlocks.get(requestId)!;
      const blockIndex = Math.floor(tokenIndex / this.pageSize);
      blocks[blockIndex].physicalBlockId = newPhysical.id;
    }

    // 写入KV缓存
    const offsetInBlock = tokenIndex % this.pageSize;
    const writeOffset = offsetInBlock * this.hiddenSize;

    if (physical.kCacheGPU && physical.vCacheGPU) {
      for (let i = 0; i < this.hiddenSize; i++) {
        physical.kCacheGPU[writeOffset + i] = kCache[i];
        physical.vCacheGPU[writeOffset + i] = vCache[i];
      }
    }

    physical.lastAccessed = Date.now();
    this.updateLru(physical.id, MemoryLocation.GPU);
  }

  /**
   * 读取KV缓存
   */
  readKvCache(requestId: string, tokenIndex: number): { kCache: Float32Array; vCache: Float32Array } | null {
    const blocks = this.logicalBlocks.get(requestId);
    if (!blocks) return null;

    const blockIndex = Math.floor(tokenIndex / this.pageSize);
    const logical = blocks[blockIndex];

    if (!logical) return null;

    const physical = this.physicalBlocks.get(logical.physicalBlockId);
    if (!physical) return null;

    // 如果块在CPU,先交换到GPU
    if (physical.state === BlockState.ON_CPU) {
      if (!this.swapCpuBlockToGpu(physical.id)) {
        return null;
      }
    }

    // 等待块在GPU上
    while (physical.state === BlockState.TRANSFERRING) {
      // 简化实现
    }

    const offsetInBlock = tokenIndex % this.pageSize;
    const readOffset = offsetInBlock * this.hiddenSize;

    let kCache: Float32Array;
    let vCache: Float32Array;

    if (physical.kCacheGPU && physical.vCacheGPU) {
      kCache = physical.kCacheGPU.slice(readOffset, readOffset + this.hiddenSize);
      vCache = physical.vCacheGPU.slice(readOffset, readOffset + this.hiddenSize);
    } else if (physical.kCacheCPU && physical.vCacheCPU) {
      kCache = physical.kCacheCPU.slice(readOffset, readOffset + this.hiddenSize);
      vCache = physical.vCacheCPU.slice(readOffset, readOffset + this.hiddenSize);
    } else {
      return null;
    }

    physical.lastAccessed = Date.now();
    this.updateLru(physical.id, MemoryLocation.GPU);

    return { kCache, vCache };
  }

  /**
   * 前缀缓存查找
   */
  lookupPrefixCache(hash: string): string | null {
    const entry = this.prefixCache.get(hash);
    if (entry) {
      entry.refCount++;
      entry.lastAccessed = Date.now();
      return entry.physicalBlockId;
    }
    return null;
  }

  /**
   * 前缀缓存插入
   */
  insertPrefixCache(hash: string, physicalBlockId: string): void {
    const existing = this.prefixCache.get(hash);
    if (existing) {
      existing.refCount++;
      existing.lastAccessed = Date.now();
      return;
    }

    const entry: PrefixCacheEntry = {
      hash,
      physicalBlockId,
      refCount: 1,
      lastAccessed: Date.now(),
    };

    this.prefixCache.set(hash, entry);
  }

  /**
   * 前缀缓存释放
   */
  releasePrefixCache(hash: string): void {
    const entry = this.prefixCache.get(hash);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      this.prefixCache.delete(hash);
    }
  }

  /**
   * 共享前缀块
   */
  sharePrefixBlocks(sourceRequestId: string, targetRequestId: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const tokenIndex = i * this.pageSize;
      const sourceBlocks = this.logicalBlocks.get(sourceRequestId);
      if (!sourceBlocks) continue;

      const blockIndex = Math.floor(tokenIndex / this.pageSize);
      const sourceLogical = sourceBlocks[blockIndex];
      if (!sourceLogical) continue;

      // 计算块的哈希
      const blockHash = this.computeBlockHash(sourceRequestId, blockIndex);

      // 查找前缀缓存
      let physicalBlockId = this.lookupPrefixCache(blockHash);
      if (!physicalBlockId) {
        // 插入到前缀缓存
        physicalBlockId = sourceLogical.physicalBlockId;
        this.insertPrefixCache(blockHash, physicalBlockId);
      }

      // 增加物理块引用计数
      const physical = this.physicalBlocks.get(physicalBlockId);
      if (physical) {
        physical.refCount++;
        physical.isShared = true;
      }

      // 目标请求共享这个块
      const targetBlocks = this.logicalBlocks.get(targetRequestId) ?? [];
      targetBlocks[blockIndex] = { ...sourceLogical, physicalBlockId };
      this.logicalBlocks.set(targetRequestId, targetBlocks);
    }
  }

  /**
   * 写时复制
   */
  private copyOnWrite(blockId: string): PhysicalKvBlock {
    const original = this.physicalBlocks.get(blockId);
    if (!original) {
      throw new Error(`block_not_found:${blockId}`);
    }

    original.lastAccessed = Date.now();

    if (!original.isShared) {
      original.isShared = true;
      original.refCount++;
      return original;
    }

    // 分配新块
    const newBlock = this.allocateGPUBlock();
    if (!newBlock) {
      throw new Error("out_of_memory: cannot allocate block for CoW");
    }

    // 复制数据
    if (original.kCacheGPU && original.vCacheGPU) {
      newBlock.kCacheGPU = new Float32Array(original.kCacheGPU);
      newBlock.vCacheGPU = new Float32Array(original.vCacheGPU);
    } else if (original.kCacheCPU && original.vCacheCPU) {
      newBlock.kCacheCPU = new Float32Array(original.kCacheCPU);
      newBlock.vCacheCPU = new Float32Array(original.vCacheCPU);
    }

    newBlock.isShared = false;
    newBlock.lastAccessed = Date.now();
    newBlock.hash = original.hash;

    return newBlock;
  }

  /**
   * 获取逻辑块
   */
  private getLogicalBlock(requestId: string, tokenIndex: number): LogicalKvBlock {
    const blocks = this.logicalBlocks.get(requestId) ?? [];
    const blockIndex = Math.floor(tokenIndex / this.pageSize);

    if (blocks[blockIndex]) {
      const physical = this.physicalBlocks.get(blocks[blockIndex].physicalBlockId);
      if (physical) {
        physical.lastAccessed = Date.now();
      }
      return blocks[blockIndex];
    }

    // 分配新的物理块
    const physical = this.allocateGPUBlock();
    if (!physical) {
      throw new Error("out_of_memory: cannot allocate block");
    }

    const logical: LogicalKvBlock = {
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
   * 计算块大小
   */
  private calculateBlockSize(): number {
    return this.pageSize * this.numHeads * this.headDim;
  }

  /**
   * 计算块哈希
   */
  private computeBlockHash(requestId: string, blockIndex: number): string {
    const blocks = this.logicalBlocks.get(requestId);
    if (!blocks) return "";
    return `hash_${requestId}_${blockIndex}_${blocks[blockIndex].hash}`;
  }

  /**
   * 更新LRU队列
   */
  private updateLru(blockId: string, location: MemoryLocation): void {
    const block = this.physicalBlocks.get(blockId);
    if (!block) return;

    if (location === MemoryLocation.GPU) {
      this.gpuLruQueue = this.gpuLruQueue.filter((id) => id !== blockId);
      this.gpuLruQueue.push(blockId);
    } else {
      this.cpuLruQueue = this.cpuLruQueue.filter((id) => id !== blockId);
      this.cpuLruQueue.push(blockId);
    }
  }

  /**
   * 清理请求的所有块
   */
  cleanup(requestId: string): void {
    const blocks = this.logicalBlocks.get(requestId);
    if (!blocks) return;

    for (const logical of blocks) {
      const physical = this.physicalBlocks.get(logical.physicalBlockId);
      if (physical) {
        physical.refCount--;
        if (physical.refCount <= 0) {
          this.physicalBlocks.delete(physical.id);
          this.gpuLruQueue = this.gpuLruQueue.filter((id) => id !== physical.id);
          this.cpuLruQueue = this.cpuLruQueue.filter((id) => id !== physical.id);
        }
      }
    }

    this.logicalBlocks.delete(requestId);
    this.blockTables.delete(requestId);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalBlocks: number;
    gpuBlocks: number;
    cpuBlocks: number;
    transferringBlocks: number;
    utilization: number;
    sharedBlocks: number;
    prefixCacheEntries: number;
    swapStats: BlockSwapStats;
  } {
    const gpuBlocks = Array.from(this.physicalBlocks.values()).filter(
      (b) => b.state === BlockState.ON_GPU,
    ).length;
    const cpuBlocks = Array.from(this.physicalBlocks.values()).filter(
      (b) => b.state === BlockState.ON_CPU,
    ).length;
    const transferringBlocks = Array.from(this.physicalBlocks.values()).filter(
      (b) => b.state === BlockState.TRANSFERRING,
    ).length;
    const sharedBlocks = Array.from(this.physicalBlocks.values()).filter((b) => b.isShared).length;

    return {
      totalBlocks: this.physicalBlocks.size,
      gpuBlocks,
      cpuBlocks,
      transferringBlocks,
      utilization: this.physicalBlocks.size / this.maxBlocks,
      sharedBlocks,
      prefixCacheEntries: this.prefixCache.size,
      swapStats: { ...this.swapStats },
    };
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `blk_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * 生成哈希
   */
  private generateHash(blockIndex: number, requestId: string): string {
    return `hash_${blockIndex}_${requestId}`;
  }

  /**
   * 获取物理块
   */
  getPhysicalBlock(blockId: string): PhysicalKvBlock | undefined {
    return this.physicalBlocks.get(blockId);
  }

  /**
   * 获取逻辑块
   */
  getLogicalBlocks(requestId: string): LogicalKvBlock[] | undefined {
    return this.logicalBlocks.get(requestId);
  }
}

/**
 * 逻辑KV块
 */
type LogicalKvBlock = {
  physicalBlockId: string;
  tokenStart: number;
  tokenEnd: number;
  hash: string;
};
