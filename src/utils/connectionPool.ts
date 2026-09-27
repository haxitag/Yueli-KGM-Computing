/**
 * HTTP连接池优化器
 * 借鉴Shimmy的连接复用策略，减少TCP握手开销
 * 保持长连接，复用HTTP Agent
 */

import http from "node:http";
import https from "node:https";
import type { Agent } from "node:http";

export interface ConnectionPoolConfig {
  /** 最大连接数 */
  maxConnections: number;
  /** 空闲连接超时（毫秒） */
  idleTimeout: number;
  /** 请求超时（毫秒） */
  requestTimeout: number;
  /** 是否启用keepAlive */
  keepAlive: boolean;
  /** keepAlive空闲时间（毫秒） */
  keepAliveMsecs: number;
  /** 最大空闲连接数 */
  maxFreeConnections: number;
}

export interface PooledConnection {
  agent: Agent;
  baseUrl: string;
  lastUsed: number;
  activeRequests: number;
  protocol: "http" | "https";
}

/**
 * HTTP连接池管理器
 * 自动管理连接生命周期，复用底层TCP连接
 */
export class ConnectionPoolManager {
  private pools = new Map<string, PooledConnection>();
  private config: ConnectionPoolConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<ConnectionPoolConfig> = {}) {
    this.config = {
      maxConnections: config.maxConnections ?? 50,
      idleTimeout: config.idleTimeout ?? 60000,
      requestTimeout: config.requestTimeout ?? 30000,
      keepAlive: config.keepAlive ?? true,
      keepAliveMsecs: config.keepAliveMsecs ?? 30000,
      maxFreeConnections: config.maxFreeConnections ?? 10,
    };

    this.startCleanupTimer();
  }

  /**
   * 获取或创建连接池
   */
  getConnection(baseUrl: string): PooledConnection {
    const normalizedUrl = this.normalizeUrl(baseUrl);
    const existing = this.pools.get(normalizedUrl);

    if (existing && this.isConnectionHealthy(existing)) {
      existing.lastUsed = Date.now();
      existing.activeRequests++;
      return existing;
    }

    // 清理旧连接
    if (existing) {
      this.destroyConnection(existing);
    }

    // 创建新连接
    const connection = this.createConnection(normalizedUrl);
    this.pools.set(normalizedUrl, connection);
    return connection;
  }

  /**
   * 释放连接引用
   */
  releaseConnection(baseUrl: string): void {
    const normalizedUrl = this.normalizeUrl(baseUrl);
    const connection = this.pools.get(normalizedUrl);
    if (connection) {
      connection.activeRequests = Math.max(0, connection.activeRequests - 1);
    }
  }

  /**
   * 检查连接健康状态
   */
  private isConnectionHealthy(connection: PooledConnection): boolean {
    const age = Date.now() - connection.lastUsed;
    return age < this.config.idleTimeout && connection.activeRequests < this.config.maxConnections;
  }

  /**
   * 创建新连接
   */
  private createConnection(baseUrl: string): PooledConnection {
    const protocol = baseUrl.startsWith("https:") ? "https" : "http";
    const agent = protocol === "https"
      ? new https.Agent({
          keepAlive: this.config.keepAlive,
          keepAliveMsecs: this.config.keepAliveMsecs,
          maxSockets: this.config.maxConnections,
          maxFreeSockets: this.config.maxFreeConnections,
          timeout: this.config.requestTimeout,
        })
      : new http.Agent({
          keepAlive: this.config.keepAlive,
          keepAliveMsecs: this.config.keepAliveMsecs,
          maxSockets: this.config.maxConnections,
          maxFreeSockets: this.config.maxFreeConnections,
          timeout: this.config.requestTimeout,
        });

    return {
      agent,
      baseUrl,
      lastUsed: Date.now(),
      activeRequests: 1,
      protocol,
    };
  }

  /**
   * 销毁连接
   */
  private destroyConnection(connection: PooledConnection): void {
    connection.agent.destroy();
  }

  /**
   * 清理过期连接
   */
  private cleanupExpiredConnections(): void {
    const now = Date.now();
    for (const [url, connection] of this.pools.entries()) {
      if (connection.activeRequests === 0 && (now - connection.lastUsed) > this.config.idleTimeout) {
        this.destroyConnection(connection);
        this.pools.delete(url);
      }
    }
  }

  /**
   * 启动定时清理
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredConnections();
    }, this.config.idleTimeout);
  }

  /**
   * 获取连接池统计
   */
  getStats(): {
    totalPools: number;
    activeConnections: number;
    idleConnections: number;
  } {
    let active = 0;
    let idle = 0;
    for (const connection of this.pools.values()) {
      if (connection.activeRequests > 0) {
        active++;
      } else {
        idle++;
      }
    }

    return {
      totalPools: this.pools.size,
      activeConnections: active,
      idleConnections: idle,
    };
  }

  /**
   * 销毁所有连接
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const connection of this.pools.values()) {
      this.destroyConnection(connection);
    }
    this.pools.clear();
  }

  /**
   * 规范化URL
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return url;
    }
  }
}

// 全局连接池实例
let globalConnectionPool: ConnectionPoolManager | null = null;

export function getConnectionPool(): ConnectionPoolManager {
  if (!globalConnectionPool) {
    globalConnectionPool = new ConnectionPoolManager();
  }
  return globalConnectionPool;
}
