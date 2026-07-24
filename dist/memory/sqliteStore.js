export class SqliteMetadataStore {
    db;
    insertStmt;
    getManyStmt;
    constructor(db) {
        this.db = db;
        this.insertStmt = db.prepare(`INSERT INTO memory_chunks (id, user_id, text, source, created_at, metadata)
       VALUES (@id, @user_id, @text, @source, @created_at, @metadata)
       ON CONFLICT(id) DO UPDATE SET
         user_id=excluded.user_id,
         text=excluded.text,
         source=excluded.source,
         created_at=excluded.created_at,
         metadata=excluded.metadata`);
        this.getManyStmt = (ids) => {
            if (ids.length === 0) {
                return [];
            }
            const placeholders = ids.map(() => "?").join(",");
            const stmt = db.prepare(`SELECT id, user_id as userId, text, source, created_at as createdAt FROM memory_chunks WHERE id IN (${placeholders})`);
            return stmt.all(...ids);
        };
    }
    static async connect(params) {
        const module = (await import("better-sqlite3"));
        const db = new module.default(params.filePath);
        if (params.journalMode) {
            db.pragma(`journal_mode = ${params.journalMode}`);
        }
        db.exec(`CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_chunks(user_id);`);
        return new SqliteMetadataStore(db);
    }
    async upsert(record) {
        this.insertStmt.run({
            id: record.id,
            user_id: record.userId,
            text: record.text,
            source: record.source,
            created_at: record.createdAt,
            metadata: null,
        });
    }
    async getMany(ids) {
        return this.getManyStmt(ids);
    }
    async deleteById(id) {
        const stmt = this.db.prepare("DELETE FROM memory_chunks WHERE id = ?");
        const info = stmt.run(id);
        return (info.changes ?? 0) > 0;
    }
    async listRecent(params) {
        const limit = Math.max(1, Math.min(200, params?.limit ?? 50));
        const offset = Math.max(0, params?.offset ?? 0);
        if (params?.userId) {
            const stmt = this.db.prepare(`SELECT id, user_id as userId, text, source, created_at as createdAt
         FROM memory_chunks WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`);
            return stmt.all(params.userId, limit, offset);
        }
        const stmt = this.db.prepare(`SELECT id, user_id as userId, text, source, created_at as createdAt
       FROM memory_chunks
       ORDER BY created_at DESC LIMIT ? OFFSET ?`);
        return stmt.all(limit, offset);
    }
    async getStats() {
        const totalRow = this.db.prepare("SELECT COUNT(*) as c FROM memory_chunks").get();
        const userRow = this.db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM memory_chunks").get();
        const byUser = this.db
            .prepare(`SELECT user_id as userId, COUNT(*) as chunks FROM memory_chunks
         GROUP BY user_id ORDER BY chunks DESC LIMIT 50`)
            .all();
        return {
            totalChunks: totalRow?.c ?? 0,
            userCount: userRow?.c ?? 0,
            byUser,
        };
    }
}
