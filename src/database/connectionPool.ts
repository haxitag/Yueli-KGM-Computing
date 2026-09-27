import { logger } from '../observability/logger.js';
import { performanceMonitor, setDefaultBaselines } from '../observability/performanceMetrics.js';

interface ConnectionPoolConfig {
  maxConnections?: number;
  idleTimeout?: number;
  busyTimeout?: number;
  journalMode?: 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF';
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  cacheSize?: number;
  mmapSize?: number;
}

class ConnectionPool {
  private db: any = null;
  private config: Required<ConnectionPoolConfig>;
  private queryCount = 0;
  private slowQueryThreshold = 1000; // ms

  constructor(private dbPath: string, config?: ConnectionPoolConfig) {
    this.config = {
      maxConnections: config?.maxConnections ?? 10,
      idleTimeout: config?.idleTimeout ?? 300000, // 5 minutes
      busyTimeout: config?.busyTimeout ?? 5000, // 5 seconds
      journalMode: config?.journalMode ?? 'WAL',
      synchronous: config?.synchronous ?? 'NORMAL',
      cacheSize: config?.cacheSize ?? -64000, // 64MB
      mmapSize: config?.mmapSize ?? 268435456, // 256MB
    };
  }

  connect(): any {
    if (this.db) {
      return this.db;
    }

    try {
      const Sqlite = require('better-sqlite3');
      this.db = new Sqlite(this.dbPath, {
        verbose: process.env.NODE_ENV === 'development' ? (msg: string) => logger.debug({ sql: msg }, 'SQLite query') : undefined,
      });

      // Configure connection
      this.db.pragma(`journal_mode = ${this.config.journalMode}`);
      this.db.pragma(`synchronous = ${this.config.synchronous}`);
      this.db.pragma(`cache_size = ${this.config.cacheSize}`);
      this.db.pragma(`mmap_size = ${this.config.mmapSize}`);
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('page_size = 4096');

      // Set busy timeout
      this.db.busyTimeout(this.config.busyTimeout);

      logger.info({
        dbPath: this.dbPath,
        config: this.config,
      }, 'Database connection established');

      return this.db;
    } catch (error) {
      logger.error({ error, dbPath: this.dbPath }, 'Failed to connect to database');
      throw new Error(`Database connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  execute<T>(query: string, params?: Record<string, unknown>): T {
    const db = this.connect();
    const start = Date.now();

    try {
      const result = db.prepare(query).run(params) as T;
      const duration = Date.now() - start;
      this.queryCount++;

      performanceMonitor.recordHistogram('database_query_latency_ms', duration, { operation: 'execute' });

      if (duration > this.slowQueryThreshold) {
        logger.warn({
          query: query.substring(0, 200),
          duration,
          params: params ? '[REDACTED]' : undefined,
        }, 'Slow database query detected');
      }

      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error({
        error,
        query: query.substring(0, 200),
        duration,
      }, 'Database query failed');
      throw error;
    }
  }

  query<T>(query: string, params?: Record<string, unknown>): T[] {
    const db = this.connect();
    const start = Date.now();

    try {
      const result = db.prepare(query).all(params) as T[];
      const duration = Date.now() - start;
      this.queryCount++;

      performanceMonitor.recordHistogram('database_query_latency_ms', duration, { operation: 'query' });

      if (duration > this.slowQueryThreshold) {
        logger.warn({
          query: query.substring(0, 200),
          duration,
          params: params ? '[REDACTED]' : undefined,
        }, 'Slow database query detected');
      }

      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error({
        error,
        query: query.substring(0, 200),
        duration,
      }, 'Database query failed');
      throw error;
    }
  }

  get<T>(query: string, params?: Record<string, unknown>): T | undefined {
    const db = this.connect();
    const start = Date.now();

    try {
      const result = db.prepare(query).get(params) as T | undefined;
      const duration = Date.now() - start;
      this.queryCount++;

      performanceMonitor.recordHistogram('database_query_latency_ms', duration, { operation: 'get' });

      if (duration > this.slowQueryThreshold) {
        logger.warn({
          query: query.substring(0, 200),
          duration,
          params: params ? '[REDACTED]' : undefined,
        }, 'Slow database query detected');
      }

      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error({
        error,
        query: query.substring(0, 200),
        duration,
      }, 'Database query failed');
      throw error;
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
        logger.info({
          queryCount: this.queryCount,
          dbPath: this.dbPath,
        }, 'Database connection closed');
      } catch (error) {
        logger.error({ error }, 'Error closing database connection');
      } finally {
        this.db = null;
      }
    }
  }

  getStats(): {
    isConnected: boolean;
    queryCount: number;
    config: Required<ConnectionPoolConfig>;
  } {
    return {
      isConnected: this.db !== null,
      queryCount: this.queryCount,
      config: this.config,
    };
  }

  vacuum(): void {
    const db = this.connect();
    const start = Date.now();
    
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      const duration = Date.now() - start;
      
      logger.info({ duration }, 'Database vacuum completed');
    } catch (error) {
      logger.error({ error }, 'Database vacuum failed');
      throw error;
    }
  }

  checkIntegrity(): boolean {
    const db = this.connect();
    
    try {
      const result = db.pragma('integrity_check') as string[];
      const isOk = result.length === 1 && result[0] === 'ok';
      
      if (!isOk) {
        logger.error({ result }, 'Database integrity check failed');
      }
      
      return isOk;
    } catch (error) {
      logger.error({ error }, 'Database integrity check error');
      return false;
    }
  }
}

// Global connection pool registry
const pools = new Map<string, ConnectionPool>();

export function getConnectionPool(dbPath: string, config?: ConnectionPoolConfig): ConnectionPool {
  if (!pools.has(dbPath)) {
    const pool = new ConnectionPool(dbPath, config);
    pools.set(dbPath, pool);
    logger.info({ dbPath }, 'Connection pool created');
  }
  return pools.get(dbPath)!;
}

export function closeAllPools(): void {
  pools.forEach((pool, dbPath) => {
    pool.close();
    logger.info({ dbPath }, 'Connection pool closed');
  });
  pools.clear();
}

export function registerShutdownHandlers(): void {
  process.on('beforeExit', () => {
    closeAllPools();
  });

  process.on('SIGINT', () => {
    closeAllPools();
  });

  process.on('SIGTERM', () => {
    closeAllPools();
  });
}

// Initialize default baselines
setDefaultBaselines();
