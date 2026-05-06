import { logger } from "../observability/logger.js";
import { performanceMonitor } from "../observability/performanceMetrics.js";
export class PostgresqlMetadataStore {
    pool = null;
    config;
    queryCount = 0;
    slowQueryThreshold = 1000; // ms
    constructor(config) {
        this.config = {
            maxConnections: 20,
            idleTimeout: 30000,
            connectionTimeout: 10000,
            ssl: false,
            ...config,
        };
    }
    static async connect(config) {
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
    async initialize() {
        try {
            const { Pool } = require("pg");
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
        }
        catch (error) {
            logger.error({ error, config: this.config }, "Failed to connect to PostgreSQL");
            throw new Error(`PostgreSQL connection failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async createTables() {
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
        }
        finally {
            client.release();
        }
    }
    async upsert(record) {
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
        }
        catch (error) {
            const duration = Date.now() - start;
            logger.error({
                error,
                query: 'upsert',
                duration,
                recordId: record.id,
            }, 'Database query failed');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async getMany(ids) {
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
            return result.rows.map((row) => ({
                id: row.id,
                userId: row.userId,
                text: row.text,
                source: row.source,
                createdAt: row.createdAt,
            }));
        }
        catch (error) {
            const duration = Date.now() - start;
            logger.error({
                error,
                query: 'getMany',
                duration,
                count: ids.length,
            }, 'Database query failed');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async close() {
        if (this.pool) {
            await this.pool.end();
            logger.info({
                queryCount: this.queryCount,
            }, 'PostgreSQL connection pool closed');
        }
    }
    getStats() {
        return {
            isConnected: this.pool !== null,
            queryCount: this.queryCount,
            config: this.config,
        };
    }
    async healthCheck() {
        try {
            const client = await this.pool.connect();
            await client.query("SELECT 1");
            client.release();
            return true;
        }
        catch (error) {
            logger.error({ error }, 'PostgreSQL health check failed');
            return false;
        }
    }
    async vacuum() {
        const client = await this.pool.connect();
        try {
            await client.query("VACUUM ANALYZE memory_chunks");
            logger.info("PostgreSQL vacuum completed");
        }
        catch (error) {
            logger.error({ error }, 'PostgreSQL vacuum failed');
            throw error;
        }
        finally {
            client.release();
        }
    }
}
