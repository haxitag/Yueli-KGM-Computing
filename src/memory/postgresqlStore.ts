import type { MetadataRecord, MetadataStore } from "./metadataStore.js";
import type { DatabaseConfig } from "../core/configStore.js";
import { logger } from "../observability/logger.js";
import { performanceMonitor } from "../observability/performanceMetrics.js";
import { Pool } from "pg";

interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
  idleTimeout?: number;
  connectionTimeout?: number;
}

export class PostgresqlMetadataStore implements MetadataStore {
  private pool: Pool;
  private config: PostgresConfig;
  private queryCount = 0;
  private slowQueryThreshold = 1000; // ms

  constructor(config: PostgresConfig) {
    this.config = {
      maxConnections: 20,
      idleTimeout: 30000,
      connectionTimeout: 10000,
      ssl: false,
      ...config,
    };
    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.username,
      password: this.config.password,
      ssl: this.config.ssl,
      max: this.config.maxConnections,
      idleTimeoutMillis: this.config.idleTimeout,
      connectionTimeoutMillis: this.config.connectionTimeout,
    });
  }

  static async connect(config: DatabaseConfig): Promise<PostgresqlMetadataStore> {
    if (config.provider !== "postgresql") {
      throw new Error("Invalid database provider for PostgresqlMetadataStore");
    }

    const pgConfig = {
      host: config.host || "localhost",
      port: config.port || 5432,
      database: config.database || "kgm",
      username: config.username || "postgres",
      password: config.password || "",
      ssl: config.ssl || false,
      maxConnections: config.maxConnections,
      idleTimeout: config.idleTimeout,
      connectionTimeout: config.connectionTimeout,
    };

    const store = new PostgresqlMetadataStore(pgConfig);
    await store.initialize();
    return store;
  }

  private async initialize(): Promise<void> {
    try {
      // Test connection
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();

      // Create tables if not exist
      await this.createTables();

      logger.info({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
      }, "PostgreSQL connection established");
    } catch (error) {
      const safeConfig = {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        username: this.config.username,
        password: "***",
      };
      logger.error({ error, config: safeConfig }, "Failed to connect to PostgreSQL");
      throw new Error(`PostgreSQL connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createTables(): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        text TEXT NOT NULL,
        source VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_chunks(user_id);
      CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_chunks(source);
      CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory_chunks(created_at);
    `;

    const client = await this.pool.connect();
    try {
      await client.query(createTableQuery);
      logger.info("PostgreSQL tables created/verified");
    } finally {
      client.release();
    }
  }

  async upsert(record: MetadataRecord): Promise<void> {
    const start = Date.now();
    const client = await this.pool.connect();
    
    try {
      const query = `
        INSERT INTO memory_chunks (id, user_id, text, source, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) 
        DO UPDATE SET 
          user_id = EXCLUDED.user_id,
          text = EXCLUDED.text,
          source = EXCLUDED.source,
          created_at = EXCLUDED.created_at
      `;
      
      await client.query(query, [
        record.id,
        record.userId,
        record.text,
        record.source,
        record.createdAt,
      ]);
      
      this.queryCount++;
      const duration = Date.now() - start;
      performanceMonitor.recordHistogram('database_query_latency_ms', duration, { operation: 'upsert' });
      
      if (duration > this.slowQueryThreshold) {
        logger.warn({
          query: 'upsert',
          duration,
          recordId: record.id,
        }, 'Slow database query detected');
      }
    } catch (error) {
      const duration = Date.now() - start;
      logger.error({
        error,
        query: 'upsert',
        duration,
        recordId: record.id,
      }, 'Database query failed');
      throw error;
    } finally {
      client.release();
    }
  }

  async getMany(ids: string[]): Promise<MetadataRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const start = Date.now();
    const client = await this.pool.connect();
    
    try {
      const query = `
        SELECT id, user_id as "userId", text, source, 
               created_at as "createdAt"
        FROM memory_chunks 
        WHERE id = ANY($1)
        ORDER BY created_at DESC
      `;
      
      const result = await client.query(query, [ids]);
      
      this.queryCount++;
      const duration = Date.now() - start;
      performanceMonitor.recordHistogram('database_query_latency_ms', duration, { operation: 'getMany' });
      
      if (duration > this.slowQueryThreshold) {
        logger.warn({
          query: 'getMany',
          duration,
          count: ids.length,
        }, 'Slow database query detected');
      }
      
      return result.rows.map((row: any) => ({
        id: row.id,
        userId: row.userId,
        text: row.text,
        source: row.source,
        createdAt: row.createdAt,
      }));
    } catch (error) {
      const duration = Date.now() - start;
      logger.error({
        error,
        query: 'getMany',
        duration,
        count: ids.length,
      }, 'Database query failed');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteById(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query("DELETE FROM memory_chunks WHERE id = $1", [id]);
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  async listRecent(params?: {
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<MetadataRecord[]> {
    const limit = Math.max(1, Math.min(500, params?.limit ?? 50));
    const offset = Math.max(0, params?.offset ?? 0);
    const values: unknown[] = [];
    const where = params?.userId ? "WHERE user_id = $1" : "";
    if (params?.userId) values.push(params.userId);
    values.push(limit, offset);
    const limitIndex = values.length - 1;
    const offsetIndex = values.length;
    const result = await this.pool.query(
      `SELECT id, user_id AS "userId", text, source, created_at AS "createdAt"
       FROM memory_chunks
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      values,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.userId),
      text: String(row.text),
      source: String(row.source),
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    }));
  }

  async getStats(): Promise<{
    totalChunks: number;
    userCount: number;
    byUser: Array<{ userId: string; chunks: number }>;
  }> {
    const [totals, users] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS "totalChunks",
                COUNT(DISTINCT user_id)::int AS "userCount"
         FROM memory_chunks`,
      ),
      this.pool.query(
        `SELECT user_id AS "userId", COUNT(*)::int AS chunks
         FROM memory_chunks
         GROUP BY user_id
         ORDER BY chunks DESC, user_id ASC`,
      ),
    ]);
    return {
      totalChunks: Number(totals.rows[0]?.totalChunks ?? 0),
      userCount: Number(totals.rows[0]?.userCount ?? 0),
      byUser: users.rows.map((row) => ({
        userId: String(row.userId),
        chunks: Number(row.chunks),
      })),
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      logger.info({
        queryCount: this.queryCount,
      }, 'PostgreSQL connection pool closed');
    }
  }

  getConnectionStats(): {
    isConnected: boolean;
    queryCount: number;
    config: PostgresConfig;
  } {
    return {
      isConnected: this.pool !== null,
      queryCount: this.queryCount,
      config: this.config,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();
      return true;
    } catch (error) {
      logger.error({ error }, 'PostgreSQL health check failed');
      return false;
    }
  }

  async vacuum(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("VACUUM ANALYZE memory_chunks");
      logger.info("PostgreSQL vacuum completed");
    } catch (error) {
      logger.error({ error }, 'PostgreSQL vacuum failed');
      throw error;
    } finally {
      client.release();
    }
  }
}
