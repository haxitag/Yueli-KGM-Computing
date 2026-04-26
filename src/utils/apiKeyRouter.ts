/**
 * API Key 路由器
 * 支持多 Key 动态选择和负载均衡，避免并发请求冲突
 */

export interface ApiKeyStatus {
  key: string;
  index: number;
  isAvailable: boolean;
  lastUsed: number;
  errorCount: number;
  rateLimitResetTime: number;
}

export interface ApiKeyPool {
  provider: string;
  keys: ApiKeyStatus[];
  currentIndex: number;
  strategy: 'round-robin' | 'least-used' | 'random' | 'priority';
}

export class ApiKeyRouter {
  private pools: Map<string, ApiKeyPool> = new Map();
  private maxErrorCount = 3;
  private rateLimitCooldown = 60000; // 1分钟冷却

  /**
   * 注册 provider 的多个 API Key
   */
  registerProvider(
    provider: string,
    keys: (string | undefined)[],
    strategy: ApiKeyPool['strategy'] = 'round-robin'
  ): void {
    const validKeys = keys
      .filter((k): k is string => !!k && k.trim() !== '')
      .map((key, index) => ({
        key,
        index,
        isAvailable: true,
        lastUsed: 0,
        errorCount: 0,
        rateLimitResetTime: 0,
      }));

    if (validKeys.length === 0) {
      throw new Error(`No valid API keys provided for ${provider}`);
    }

    this.pools.set(provider, {
      provider,
      keys: validKeys,
      currentIndex: 0,
      strategy,
    });
  }

  /**
   * 获取下一个可用的 API Key
   */
  getNextKey(provider: string): string | null {
    const pool = this.pools.get(provider);
    if (!pool) return null;

    // 重置过期的 rate limit
    const now = Date.now();
    for (const keyStatus of pool.keys) {
      if (!keyStatus.isAvailable && now > keyStatus.rateLimitResetTime) {
        keyStatus.isAvailable = true;
        keyStatus.errorCount = 0;
      }
    }

    // 根据策略选择 key
    let selected: ApiKeyStatus | null = null;

    switch (pool.strategy) {
      case 'round-robin':
        selected = this.selectRoundRobin(pool);
        break;
      case 'least-used':
        selected = this.selectLeastUsed(pool);
        break;
      case 'random':
        selected = this.selectRandom(pool);
        break;
      case 'priority':
        selected = this.selectPriority(pool);
        break;
      default:
        selected = this.selectRoundRobin(pool);
    }

    if (selected) {
      selected.lastUsed = now;
      return selected.key;
    }

    return null;
  }

  /**
   * 报告 key 使用成功
   */
  reportSuccess(provider: string, key: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;

    const keyStatus = pool.keys.find(k => k.key === key);
    if (keyStatus) {
      keyStatus.errorCount = 0;
      keyStatus.isAvailable = true;
    }
  }

  /**
   * 报告 key 使用失败
   */
  reportError(provider: string, key: string, isRateLimit = false): void {
    const pool = this.pools.get(provider);
    if (!pool) return;

    const keyStatus = pool.keys.find(k => k.key === key);
    if (!keyStatus) return;

    keyStatus.errorCount++;

    if (isRateLimit) {
      // 触发速率限制，进入冷却
      keyStatus.isAvailable = false;
      keyStatus.rateLimitResetTime = Date.now() + this.rateLimitCooldown;
    } else if (keyStatus.errorCount >= this.maxErrorCount) {
      // 错误次数过多，暂时禁用
      keyStatus.isAvailable = false;
      keyStatus.rateLimitResetTime = Date.now() + this.rateLimitCooldown;
    }
  }

  /**
   * 获取 provider 的 key 池状态
   */
  getPoolStatus(provider: string): ApiKeyPool | null {
    return this.pools.get(provider) || null;
  }

  /**
   * 获取所有 pools 状态
   */
  getAllStatus(): ApiKeyPool[] {
    return Array.from(this.pools.values());
  }

  /**
   * 重置 provider 的所有 key 状态
   */
  resetProvider(provider: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;

    for (const key of pool.keys) {
      key.isAvailable = true;
      key.errorCount = 0;
      key.rateLimitResetTime = 0;
    }
  }

  /**
   * 移除 provider
   */
  removeProvider(provider: string): void {
    this.pools.delete(provider);
  }

  /**
   * 轮询策略
   */
  private selectRoundRobin(pool: ApiKeyPool): ApiKeyStatus | null {
    const available = pool.keys.filter(k => k.isAvailable);
    if (available.length === 0) return null;

    const selected = available[pool.currentIndex % available.length];
    pool.currentIndex = (pool.currentIndex + 1) % available.length;
    return selected;
  }

  /**
   * 最少使用策略
   */
  private selectLeastUsed(pool: ApiKeyPool): ApiKeyStatus | null {
    const available = pool.keys.filter(k => k.isAvailable);
    if (available.length === 0) return null;

    return available.reduce((min, current) =>
      current.lastUsed < min.lastUsed ? current : min
    );
  }

  /**
   * 随机策略
   */
  private selectRandom(pool: ApiKeyPool): ApiKeyStatus | null {
    const available = pool.keys.filter(k => k.isAvailable);
    if (available.length === 0) return null;

    const index = Math.floor(Math.random() * available.length);
    return available[index];
  }

  /**
   * 优先级策略（按 index 优先级）
   */
  private selectPriority(pool: ApiKeyPool): ApiKeyStatus | null {
    const available = pool.keys.filter(k => k.isAvailable);
    if (available.length === 0) return null;

    // 优先使用 index 小的（主 key）
    return available.reduce((min, current) =>
      current.index < min.index ? current : min
    );
  }
}

// 全局单例
export const globalApiKeyRouter = new ApiKeyRouter();
