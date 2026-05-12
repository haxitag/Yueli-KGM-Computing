import type { MetadataRecord, MetadataStore } from "./metadataStore.js";

export class SqliteMetadataStore implements MetadataStore {
  private db: any;
  private insertStmt: any;
  private getManyStmt: (ids: string[]) => MetadataRecord[];

  private constructor(db: any) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO memory_chunks (id, user_id, text, source, created_at, metadata)
       VALUES (@id, @user_id, @text, @source, @created_at, @metadata)
       ON CONFLICT(id) DO UPDATE SET
         user_id=excluded.user_id,
         text=excluded.text,
         source=excluded.source,
         created_at=excluded.created_at,
         metadata=excluded.metadata`
    );
    this.getManyStmt = (ids: string[]) => {
      if (ids.length === 0) {
        return [];
      }
      const placeholders = ids.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT id, user_id as userId, text, source, created_at as createdAt FROM memory_chunks WHERE id IN (${placeholders})`
      );
      return stmt.all(...ids) as MetadataRecord[];
    };
  }

  static async connect(params: { filePath: string; journalMode?: "WAL" | "DELETE" }): Promise<SqliteMetadataStore> {
    const module = (await import("better-sqlite3")) as { default: new (path: string) => any };
    const db = new module.default(params.filePath);
    if (params.journalMode) {
      db.pragma(`journal_mode = ${params.journalMode}`);
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_chunks(user_id);`
    );
    return new SqliteMetadataStore(db);
  }

  async upsert(record: MetadataRecord): Promise<void> {
    this.insertStmt.run({
      id: record.id,
      user_id: record.userId,
      text: record.text,
      source: record.source,
      created_at: record.createdAt,
      metadata: null,
    });
  }

  async getMany(ids: string[]): Promise<MetadataRecord[]> {
    return this.getManyStmt(ids);
  }

  async deleteById(id: string): Promise<boolean> {
    const stmt = this.db.prepare("DELETE FROM memory_chunks WHERE id = ?");
    const info = stmt.run(id);
    return (info.changes ?? 0) > 0;
  }
}
