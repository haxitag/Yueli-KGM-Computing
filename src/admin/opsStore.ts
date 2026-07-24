/**
 * KGM Ops Admin: virtual keys, usage ledger, budgets, model aliases.
 * SQLite-backed; no Otari dependency.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { generateId } from "../utils/id.js";

export type VirtualKeyRecord = {
  id: string;
  name: string;
  /** sha256 hex of full key */
  keyHash: string;
  /** last 4 chars for UI */
  keySuffix: string;
  /** optional model/alias allowlist (empty = all) */
  allowedModels: string[];
  enabled: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
};

export type VirtualKeyCreated = VirtualKeyRecord & {
  /** plaintext shown once */
  apiKey: string;
};

export type BudgetPeriod = "day" | "month" | "total";

export type BudgetRecord = {
  id: string;
  /** virtual key id, or "master" / "*" for default */
  keyId: string;
  name: string;
  period: BudgetPeriod;
  /** USD hard limit */
  limitUsd: number;
  mode: "hard" | "soft";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModelAliasRecord = {
  id: string;
  alias: string;
  provider?: string;
  model: string;
  runtimeId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  notes?: string;
};

export type UsageEvent = {
  id: string;
  timestamp: string;
  keyId: string;
  keyName?: string;
  requestId?: string;
  model: string;
  provider?: string;
  runtimeId?: string;
  profile?: string;
  taskType?: string;
  success: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  source: "auto_routing" | "direct" | "manual";
  meta?: Record<string, unknown>;
};

export type UsageSummary = {
  totalRequests: number;
  successRate: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byModel: Array<{ model: string; requests: number; tokens: number; costUsd: number }>;
  byKey: Array<{ keyId: string; keyName?: string; requests: number; tokens: number; costUsd: number }>;
  byDay: Array<{ day: string; requests: number; tokens: number; costUsd: number }>;
};

export type BudgetStatus = {
  budget: BudgetRecord;
  spentUsd: number;
  remainingUsd: number;
  exceeded: boolean;
  periodStart: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqualHash(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function mintCallKey(): string {
  return `kgm_${randomBytes(24).toString("base64url")}`;
}

function periodStartIso(period: BudgetPeriod, now = new Date()): string {
  if (period === "total") return "1970-01-01T00:00:00.000Z";
  if (period === "day") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export class KgmOpsStore {
  private db: any;

  private constructor(db: any) {
    this.db = db;
  }

  static async connect(params?: { filePath?: string; journalMode?: "WAL" | "DELETE" }): Promise<KgmOpsStore> {
    const filePath = params?.filePath ?? process.env.KGM_OPS_DB_PATH ?? process.env.KGM_DB_PATH ?? "data/kgm-ops.sqlite";
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const module = (await import("better-sqlite3")) as { default: new (path: string) => any };
    const db = new module.default(filePath);
    db.pragma(`journal_mode = ${params?.journalMode ?? "WAL"}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_suffix TEXT NOT NULL,
        allowed_models TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        name TEXT NOT NULL,
        period TEXT NOT NULL,
        limit_usd REAL NOT NULL,
        mode TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_budgets_key ON budgets(key_id);
      CREATE TABLE IF NOT EXISTS model_aliases (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        provider TEXT,
        model TEXT NOT NULL,
        runtime_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        key_id TEXT NOT NULL,
        key_name TEXT,
        request_id TEXT,
        model TEXT NOT NULL,
        provider TEXT,
        runtime_id TEXT,
        profile TEXT,
        task_type TEXT,
        success INTEGER NOT NULL,
        latency_ms REAL NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        source TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_events(key_id);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model);
    `);
    return new KgmOpsStore(db);
  }

  /** In-memory store for unit tests without native sqlite */
  static createMemory(): KgmOpsStore {
    const rows = {
      keys: [] as any[],
      budgets: [] as any[],
      aliases: [] as any[],
      usage: [] as any[],
    };
    const fakeDb = {
      __memory: rows,
      prepare(sql: string) {
        return {
          run: (...args: unknown[]) => memoryRun(rows, sql, args),
          get: (...args: unknown[]) => memoryGet(rows, sql, args),
          all: (...args: unknown[]) => memoryAll(rows, sql, args),
        };
      },
      exec() {},
      pragma() {},
    };
    return new KgmOpsStore(fakeDb);
  }

  createVirtualKey(input: {
    name: string;
    allowedModels?: string[];
    expiresAt?: string;
    notes?: string;
  }): VirtualKeyCreated {
    const now = new Date().toISOString();
    const apiKey = mintCallKey();
    const record: VirtualKeyRecord = {
      id: generateId("vkey"),
      name: input.name.trim() || "unnamed",
      keyHash: sha256Hex(apiKey),
      keySuffix: apiKey.slice(-4),
      allowedModels: input.allowedModels ?? [],
      enabled: true,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
      notes: input.notes,
    };
    this.db
      .prepare(
        `INSERT INTO virtual_keys (id, name, key_hash, key_suffix, allowed_models, enabled, expires_at, created_at, updated_at, notes)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.keyHash,
        record.keySuffix,
        JSON.stringify(record.allowedModels),
        record.expiresAt ?? null,
        record.createdAt,
        record.updatedAt,
        record.notes ?? null,
      );
    return { ...record, apiKey };
  }

  listVirtualKeys(): VirtualKeyRecord[] {
    const rows = this.db.prepare(`SELECT * FROM virtual_keys ORDER BY created_at DESC`).all() as any[];
    return rows.map(mapKeyRow);
  }

  getVirtualKey(id: string): VirtualKeyRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM virtual_keys WHERE id = ?`).get(id) as any;
    return row ? mapKeyRow(row) : undefined;
  }

  findVirtualKeyByRaw(rawKey: string): VirtualKeyRecord | undefined {
    if (!rawKey.startsWith("kgm_")) return undefined;
    const hash = sha256Hex(rawKey);
    const rows = this.db.prepare(`SELECT * FROM virtual_keys WHERE enabled = 1`).all() as any[];
    for (const row of rows) {
      if (safeEqualHash(String(row.key_hash), hash)) {
        const rec = mapKeyRow(row);
        if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) return undefined;
        return rec;
      }
    }
    return undefined;
  }

  revokeVirtualKey(id: string): boolean {
    const info = this.db.prepare(`UPDATE virtual_keys SET enabled = 0, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
    return (info.changes ?? 0) > 0;
  }

  deleteVirtualKey(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM virtual_keys WHERE id = ?`).run(id);
    return (info.changes ?? 0) > 0;
  }

  upsertBudget(input: {
    id?: string;
    keyId: string;
    name: string;
    period: BudgetPeriod;
    limitUsd: number;
    mode?: "hard" | "soft";
    enabled?: boolean;
  }): BudgetRecord {
    const now = new Date().toISOString();
    const id = input.id ?? generateId("bud");
    const existing = this.db.prepare(`SELECT * FROM budgets WHERE id = ?`).get(id) as any;
    const record: BudgetRecord = {
      id,
      keyId: input.keyId,
      name: input.name,
      period: input.period,
      limitUsd: Math.max(0, input.limitUsd),
      mode: input.mode ?? "hard",
      enabled: input.enabled ?? true,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO budgets (id, key_id, name, period, limit_usd, mode, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key_id=excluded.key_id, name=excluded.name, period=excluded.period,
           limit_usd=excluded.limit_usd, mode=excluded.mode, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        record.id,
        record.keyId,
        record.name,
        record.period,
        record.limitUsd,
        record.mode,
        record.enabled ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  listBudgets(): BudgetRecord[] {
    return (this.db.prepare(`SELECT * FROM budgets ORDER BY updated_at DESC`).all() as any[]).map(mapBudgetRow);
  }

  deleteBudget(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM budgets WHERE id = ?`).run(id).changes) ?? 0) > 0;
  }

  getBudgetStatuses(keyId: string): BudgetStatus[] {
    const budgets = this.listBudgets().filter((b) => b.enabled && (b.keyId === keyId || b.keyId === "*"));
    return budgets.map((budget) => {
      const start = periodStartIso(budget.period);
      const spent = this.sumCostSince(keyId, start);
      return {
        budget,
        spentUsd: spent,
        remainingUsd: Math.max(0, budget.limitUsd - spent),
        exceeded: spent >= budget.limitUsd,
        periodStart: start,
      };
    });
  }

  /** Hard budget exceeded? */
  assertBudgetAllows(keyId: string): { ok: true } | { ok: false; status: BudgetStatus } {
    for (const status of this.getBudgetStatuses(keyId)) {
      if (status.budget.mode === "hard" && status.exceeded) {
        return { ok: false, status };
      }
    }
    return { ok: true };
  }

  upsertAlias(input: {
    id?: string;
    alias: string;
    model: string;
    provider?: string;
    runtimeId?: string;
    enabled?: boolean;
    notes?: string;
  }): ModelAliasRecord {
    const now = new Date().toISOString();
    const alias = input.alias.trim();
    const existingByAlias = this.db.prepare(`SELECT * FROM model_aliases WHERE alias = ?`).get(alias) as any;
    const id = input.id ?? existingByAlias?.id ?? generateId("alias");
    const existing = this.db.prepare(`SELECT * FROM model_aliases WHERE id = ?`).get(id) as any;
    const record: ModelAliasRecord = {
      id,
      alias,
      model: input.model.trim(),
      provider: input.provider?.trim() || undefined,
      runtimeId: input.runtimeId?.trim() || undefined,
      enabled: input.enabled ?? true,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
      notes: input.notes,
    };
    this.db
      .prepare(
        `INSERT INTO model_aliases (id, alias, provider, model, runtime_id, enabled, created_at, updated_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           alias=excluded.alias, provider=excluded.provider, model=excluded.model,
           runtime_id=excluded.runtime_id, enabled=excluded.enabled, updated_at=excluded.updated_at, notes=excluded.notes`,
      )
      .run(
        record.id,
        record.alias,
        record.provider ?? null,
        record.model,
        record.runtimeId ?? null,
        record.enabled ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        record.notes ?? null,
      );
    return record;
  }

  listAliases(): ModelAliasRecord[] {
    return (this.db.prepare(`SELECT * FROM model_aliases ORDER BY alias ASC`).all() as any[]).map(mapAliasRow);
  }

  resolveAlias(name: string): ModelAliasRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM model_aliases WHERE alias = ? AND enabled = 1`).get(name) as any;
    return row ? mapAliasRow(row) : undefined;
  }

  deleteAlias(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM model_aliases WHERE id = ?`).run(id).changes) ?? 0) > 0;
  }

  recordUsage(event: Omit<UsageEvent, "id" | "timestamp"> & { id?: string; timestamp?: string }): UsageEvent {
    const full: UsageEvent = {
      id: event.id ?? generateId("usage"),
      timestamp: event.timestamp ?? new Date().toISOString(),
      keyId: event.keyId,
      keyName: event.keyName,
      requestId: event.requestId,
      model: event.model,
      provider: event.provider,
      runtimeId: event.runtimeId,
      profile: event.profile,
      taskType: event.taskType,
      success: event.success,
      latencyMs: event.latencyMs,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      totalTokens: event.totalTokens,
      costUsd: event.costUsd,
      source: event.source,
      meta: event.meta,
    };
    this.db
      .prepare(
        `INSERT INTO usage_events (
          id, timestamp, key_id, key_name, request_id, model, provider, runtime_id,
          profile, task_type, success, latency_ms, prompt_tokens, completion_tokens,
          total_tokens, cost_usd, source, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.timestamp,
        full.keyId,
        full.keyName ?? null,
        full.requestId ?? null,
        full.model,
        full.provider ?? null,
        full.runtimeId ?? null,
        full.profile ?? null,
        full.taskType ?? null,
        full.success ? 1 : 0,
        full.latencyMs,
        full.promptTokens,
        full.completionTokens,
        full.totalTokens,
        full.costUsd,
        full.source,
        full.meta ? JSON.stringify(full.meta) : null,
      );
    return full;
  }

  listUsage(params?: { limit?: number; keyId?: string; model?: string; since?: string }): UsageEvent[] {
    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 1000);
    let sql = `SELECT * FROM usage_events WHERE 1=1`;
    const args: unknown[] = [];
    if (params?.keyId) {
      sql += ` AND key_id = ?`;
      args.push(params.keyId);
    }
    if (params?.model) {
      sql += ` AND model = ?`;
      args.push(params.model);
    }
    if (params?.since) {
      sql += ` AND timestamp >= ?`;
      args.push(params.since);
    }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    args.push(limit);
    return (this.db.prepare(sql).all(...args) as any[]).map(mapUsageRow);
  }

  summarizeUsage(params?: { since?: string; keyId?: string }): UsageSummary {
    const since = params?.since ?? new Date(Date.now() - 30 * 86400000).toISOString();
    let sql = `SELECT * FROM usage_events WHERE timestamp >= ?`;
    const args: unknown[] = [since];
    if (params?.keyId) {
      sql += ` AND key_id = ?`;
      args.push(params.keyId);
    }
    const rows = (this.db.prepare(sql).all(...args) as any[]).map(mapUsageRow);
    const totalRequests = rows.length;
    const ok = rows.filter((r) => r.success).length;
    const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
    const totalCostUsd = rows.reduce((s, r) => s + r.costUsd, 0);
    const avgLatencyMs = totalRequests ? rows.reduce((s, r) => s + r.latencyMs, 0) / totalRequests : 0;

    const byModelMap = new Map<string, { requests: number; tokens: number; costUsd: number }>();
    const byKeyMap = new Map<string, { keyName?: string; requests: number; tokens: number; costUsd: number }>();
    const byDayMap = new Map<string, { requests: number; tokens: number; costUsd: number }>();
    for (const r of rows) {
      const m = byModelMap.get(r.model) ?? { requests: 0, tokens: 0, costUsd: 0 };
      m.requests += 1;
      m.tokens += r.totalTokens;
      m.costUsd += r.costUsd;
      byModelMap.set(r.model, m);

      const k = byKeyMap.get(r.keyId) ?? { keyName: r.keyName, requests: 0, tokens: 0, costUsd: 0 };
      k.requests += 1;
      k.tokens += r.totalTokens;
      k.costUsd += r.costUsd;
      k.keyName = k.keyName ?? r.keyName;
      byKeyMap.set(r.keyId, k);

      const day = r.timestamp.slice(0, 10);
      const d = byDayMap.get(day) ?? { requests: 0, tokens: 0, costUsd: 0 };
      d.requests += 1;
      d.tokens += r.totalTokens;
      d.costUsd += r.costUsd;
      byDayMap.set(day, d);
    }

    return {
      totalRequests,
      successRate: totalRequests ? ok / totalRequests : 0,
      totalTokens,
      totalCostUsd,
      avgLatencyMs,
      byModel: [...byModelMap.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.costUsd - a.costUsd),
      byKey: [...byKeyMap.entries()].map(([keyId, v]) => ({ keyId, ...v })).sort((a, b) => b.costUsd - a.costUsd),
      byDay: [...byDayMap.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  private sumCostSince(keyId: string, since: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_events WHERE key_id = ? AND timestamp >= ?`)
      .get(keyId, since) as { total: number };
    return Number(row?.total ?? 0);
  }
}

function mapKeyRow(row: any): VirtualKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    keySuffix: row.key_suffix,
    allowedModels: JSON.parse(row.allowed_models || "[]"),
    enabled: Boolean(row.enabled),
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notes: row.notes ?? undefined,
  };
}

function mapBudgetRow(row: any): BudgetRecord {
  return {
    id: row.id,
    keyId: row.key_id,
    name: row.name,
    period: row.period,
    limitUsd: row.limit_usd,
    mode: row.mode,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAliasRow(row: any): ModelAliasRecord {
  return {
    id: row.id,
    alias: row.alias,
    provider: row.provider ?? undefined,
    model: row.model,
    runtimeId: row.runtime_id ?? undefined,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notes: row.notes ?? undefined,
  };
}

function mapUsageRow(row: any): UsageEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    keyId: row.key_id,
    keyName: row.key_name ?? undefined,
    requestId: row.request_id ?? undefined,
    model: row.model,
    provider: row.provider ?? undefined,
    runtimeId: row.runtime_id ?? undefined,
    profile: row.profile ?? undefined,
    taskType: row.task_type ?? undefined,
    success: Boolean(row.success),
    latencyMs: row.latency_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    source: row.source,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
  };
}

/* ---- minimal memory backend for tests ---- */

function memoryRun(rows: any, sql: string, args: unknown[]) {
  if (sql.includes("INSERT INTO virtual_keys")) {
    rows.keys.push({
      id: args[0],
      name: args[1],
      key_hash: args[2],
      key_suffix: args[3],
      allowed_models: args[4],
      enabled: 1,
      expires_at: args[5],
      created_at: args[6],
      updated_at: args[7],
      notes: args[8],
    });
    return { changes: 1 };
  }
  if (sql.includes("UPDATE virtual_keys SET enabled = 0")) {
    const k = rows.keys.find((x: any) => x.id === args[1]);
    if (k) {
      k.enabled = 0;
      k.updated_at = args[0];
      return { changes: 1 };
    }
    return { changes: 0 };
  }
  if (sql.includes("DELETE FROM virtual_keys")) {
    const n = rows.keys.length;
    rows.keys = rows.keys.filter((x: any) => x.id !== args[0]);
    return { changes: n - rows.keys.length };
  }
  if (sql.includes("INSERT INTO budgets")) {
    const idx = rows.budgets.findIndex((x: any) => x.id === args[0]);
    const row = {
      id: args[0],
      key_id: args[1],
      name: args[2],
      period: args[3],
      limit_usd: args[4],
      mode: args[5],
      enabled: args[6],
      created_at: args[7],
      updated_at: args[8],
    };
    if (idx >= 0) rows.budgets[idx] = row;
    else rows.budgets.push(row);
    return { changes: 1 };
  }
  if (sql.includes("DELETE FROM budgets")) {
    const n = rows.budgets.length;
    rows.budgets = rows.budgets.filter((x: any) => x.id !== args[0]);
    return { changes: n - rows.budgets.length };
  }
  if (sql.includes("INSERT INTO model_aliases")) {
    const idx = rows.aliases.findIndex((x: any) => x.id === args[0]);
    const row = {
      id: args[0],
      alias: args[1],
      provider: args[2],
      model: args[3],
      runtime_id: args[4],
      enabled: args[5],
      created_at: args[6],
      updated_at: args[7],
      notes: args[8],
    };
    if (idx >= 0) rows.aliases[idx] = row;
    else {
      const byAlias = rows.aliases.findIndex((x: any) => x.alias === args[1]);
      if (byAlias >= 0) rows.aliases[byAlias] = row;
      else rows.aliases.push(row);
    }
    return { changes: 1 };
  }
  if (sql.includes("DELETE FROM model_aliases")) {
    const n = rows.aliases.length;
    rows.aliases = rows.aliases.filter((x: any) => x.id !== args[0]);
    return { changes: n - rows.aliases.length };
  }
  if (sql.includes("INSERT INTO usage_events")) {
    rows.usage.push({
      id: args[0],
      timestamp: args[1],
      key_id: args[2],
      key_name: args[3],
      request_id: args[4],
      model: args[5],
      provider: args[6],
      runtime_id: args[7],
      profile: args[8],
      task_type: args[9],
      success: args[10],
      latency_ms: args[11],
      prompt_tokens: args[12],
      completion_tokens: args[13],
      total_tokens: args[14],
      cost_usd: args[15],
      source: args[16],
      meta: args[17],
    });
    return { changes: 1 };
  }
  return { changes: 0 };
}

function memoryGet(rows: any, sql: string, args: unknown[]) {
  if (sql.includes("FROM virtual_keys WHERE id")) {
    return rows.keys.find((x: any) => x.id === args[0]);
  }
  if (sql.includes("FROM budgets WHERE id")) {
    return rows.budgets.find((x: any) => x.id === args[0]);
  }
  if (sql.includes("FROM model_aliases WHERE alias") && sql.includes("enabled")) {
    return rows.aliases.find((x: any) => x.alias === args[0] && x.enabled);
  }
  if (sql.includes("FROM model_aliases WHERE alias")) {
    return rows.aliases.find((x: any) => x.alias === args[0]);
  }
  if (sql.includes("FROM model_aliases WHERE id")) {
    return rows.aliases.find((x: any) => x.id === args[0]);
  }
  if (sql.includes("SUM(cost_usd)")) {
    const keyId = String(args[0]);
    const since = String(args[1]);
    const total = rows.usage
      .filter((x: any) => x.key_id === keyId && x.timestamp >= since)
      .reduce((s: number, x: any) => s + Number(x.cost_usd), 0);
    return { total };
  }
  return undefined;
}

function memoryAll(rows: any, sql: string, args: unknown[]) {
  if (sql.includes("FROM virtual_keys")) {
    if (sql.includes("enabled = 1")) return rows.keys.filter((x: any) => x.enabled);
    return [...rows.keys].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  if (sql.includes("FROM budgets")) {
    return [...rows.budgets].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }
  if (sql.includes("FROM model_aliases")) {
    return [...rows.aliases].sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
  }
  if (sql.includes("FROM usage_events")) {
    let list = [...rows.usage];
    if (args.length >= 1 && sql.includes("timestamp >=") && !sql.includes("LIMIT")) {
      const since = String(args[0]);
      list = list.filter((x: any) => x.timestamp >= since);
      if (args.length >= 2 && sql.includes("key_id = ?")) {
        const keyId = String(args[1]);
        list = list.filter((x: any) => x.key_id === keyId);
      }
      return list;
    }
    // listUsage with filters
    let i = 0;
    if (sql.includes("key_id = ?")) {
      const keyId = String(args[i++]);
      list = list.filter((x: any) => x.key_id === keyId);
    }
    if (sql.includes("model = ?")) {
      const model = String(args[i++]);
      list = list.filter((x: any) => x.model === model);
    }
    if (sql.includes("timestamp >=")) {
      const since = String(args[i++]);
      list = list.filter((x: any) => x.timestamp >= since);
    }
    const limit = Number(args[i] ?? 100);
    return list.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, limit);
  }
  return [];
}

let singleton: KgmOpsStore | undefined;
let singletonPromise: Promise<KgmOpsStore> | undefined;

export async function getOpsStore(): Promise<KgmOpsStore> {
  if (singleton) return singleton;
  if (!singletonPromise) {
    singletonPromise = KgmOpsStore.connect().then((s) => {
      singleton = s;
      return s;
    });
  }
  return singletonPromise;
}

export function setOpsStoreForTests(store: KgmOpsStore | undefined): void {
  singleton = store;
  singletonPromise = store ? Promise.resolve(store) : undefined;
}
