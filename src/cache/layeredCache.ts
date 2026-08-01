/**
 * 分层缓存管理器
 * 借鉴 VMLX 的 5 层缓存架构 (L1 Memory + L2 Disk)
 * 实现多级缓存策略，提升推理性能
 */

import * as fs from 'fs';
import * as path from 'path';

export interface KvBlock {
  key: string;
  data: Buffer;
  timestamp: number;
  size: number;
}

interface CacheEntry {
  blocks: KvBlock[];
  accessedAt: number;
  hitCount: number;
}

export class LayeredCacheManager {
  private l1Cache: Map<string, CacheEntry> = new Map();
  private l2CachePath: string;
  private l1MaxSize: number; // 字节
  private l2MaxSize: number; // 字节
  private l1CurrentSize: number = 0;
  private l2CurrentSize: number = 0;

  constructor(options: {
    l2CachePath?: string;
    l1MaxSize?: number; // 默认 1GB
    l2MaxSize?: number; // 默认 10GB
  }) {
    this.l2CachePath = options.l2CachePath || path.join(process.cwd(), '.kgm-cache');
    this.l1MaxSize = options.l1MaxSize || 1024 * 1024 * 1024; // 1GB
    this.l2MaxSize = options.l2MaxSize || 10 * 1024 * 1024 * 1024; // 10GB
    
    // 确保 L2 缓存目录存在
    if (!fs.existsSync(this.l2CachePath)) {
      fs.mkdirSync(this.l2CachePath, { recursive: true });
    }
    
    // 加载 L2 缓存统计
    this.loadL2Stats();
  }

  /**
   * 获取或计算 KV 块
   */
  async getOrCompute(promptHash: string, computeFn: () => Promise<KvBlock[]>): Promise<KvBlock[]> {
    // L1 查找（内存快速缓存）
    const l1Entry = this.l1Cache.get(promptHash);
    if (l1Entry) {
      l1Entry.accessedAt = Date.now();
      l1Entry.hitCount++;
      return l1Entry.blocks;
    }

    // L2 查找（SSD 持久化缓存）
    const l2Blocks = await this.l2Get(promptHash);
    if (l2Blocks) {
      // 提升到 L1
      await this.l1Set(promptHash, l2Blocks);
      return l2Blocks;
    }

    // 计算并缓存
    const result = await computeFn();
    await this.l1Set(promptHash, result);
    await this.l2Set(promptHash, result);
    return result;
  }

  /**
   * L1 缓存设置
   */
  private async l1Set(promptHash: string, blocks: KvBlock[]): Promise<void> {
    const size = blocks.reduce((acc, block) => acc + block.size, 0);
    
    // 如果超过限制，先清理
    while (this.l1CurrentSize + size > this.l1MaxSize && this.l1Cache.size > 0) {
      await this.evictL1();
    }

    this.l1Cache.set(promptHash, {
      blocks,
      accessedAt: Date.now(),
      hitCount: 1
    });
    this.l1CurrentSize += size;
  }

  /**
   * L1 缓存驱逐（LRU 策略）
   */
  private async evictL1(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    this.l1Cache.forEach((entry, key) => {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      const entry = this.l1Cache.get(oldestKey)!;
      this.l1CurrentSize -= entry.blocks.reduce((acc, block) => acc + block.size, 0);
      this.l1Cache.delete(oldestKey);
    }
  }

  /**
   * L2 缓存获取
   */
  private async l2Get(promptHash: string): Promise<KvBlock[] | null> {
    const filePath = this.getL2FilePath(promptHash);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      return parsed.blocks as KvBlock[];
    } catch {
      return null;
    }
  }

  /**
   * L2 缓存设置
   */
  private async l2Set(promptHash: string, blocks: KvBlock[]): Promise<void> {
    const size = blocks.reduce((acc, block) => acc + block.size, 0);
    
    // 如果超过限制，先清理
    while (this.l2CurrentSize + size > this.l2MaxSize) {
      await this.evictL2();
    }

    const filePath = this.getL2FilePath(promptHash);
    await fs.promises.writeFile(filePath, JSON.stringify({
      blocks,
      createdAt: Date.now(),
      size
    }));
    this.l2CurrentSize += size;
  }

  /**
   * L2 缓存驱逐（LRU 策略）
   */
  private async evictL2(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.l2CachePath);
      let oldestFile: string | null = null;
      let oldestTime = Date.now();

      for (const file of files) {
        const filePath = path.join(this.l2CachePath, file);
        const stat = await fs.promises.stat(filePath);
        if (stat.mtime.getTime() < oldestTime) {
          oldestTime = stat.mtime.getTime();
          oldestFile = filePath;
        }
      }

      if (oldestFile) {
        const data = await fs.promises.readFile(oldestFile, 'utf-8');
        const parsed = JSON.parse(data);
        this.l2CurrentSize -= parsed.size || 0;
        await fs.promises.unlink(oldestFile);
      }
    } catch {
      // 忽略清理错误
    }
  }

  /**
   * 获取 L2 文件路径
   */
  private getL2FilePath(promptHash: string): string {
    // 使用哈希的前两位创建子目录，避免单目录文件过多
    const prefix = promptHash.substring(0, 2);
    const dirPath = path.join(this.l2CachePath, prefix);
    
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    return path.join(dirPath, `${promptHash}.json`);
  }

  /**
   * 加载 L2 缓存统计
   */
  private loadL2Stats(): void {
    try {
      const files = fs.readdirSync(this.l2CachePath, { recursive: true });
      this.l2CurrentSize = files.reduce((acc, file) => {
        const filePath = path.join(this.l2CachePath, String(file));
        try {
          const stat = fs.statSync(filePath);
          return acc + stat.size;
        } catch {
          return acc;
        }
      }, 0);
    } catch {
      this.l2CurrentSize = 0;
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
    l1Size: number;
    l1MaxSize: number;
    l1Entries: number;
    l2Size: number;
    l2MaxSize: number;
  } {
    return {
      l1Size: this.l1CurrentSize,
      l1MaxSize: this.l1MaxSize,
      l1Entries: this.l1Cache.size,
      l2Size: this.l2CurrentSize,
      l2MaxSize: this.l2MaxSize
    };
  }

  /**
   * 清理所有缓存
   */
  async clear(): Promise<void> {
    this.l1Cache.clear();
    this.l1CurrentSize = 0;
    
    try {
      await fs.promises.rm(this.l2CachePath, { recursive: true });
      fs.mkdirSync(this.l2CachePath, { recursive: true });
    } catch {
      // 忽略清理错误
    }
    this.l2CurrentSize = 0;
  }
}
