import fs from "node:fs";
import path from "node:path";
import type { BusinessRoutingConfig } from "./businessRouting.js";

export type RoutingHistoryEntry = {
  action: "update" | "rollback";
  version: string;
  recordedAt: string;
  config: BusinessRoutingConfig;
  note?: string;
  rollbackFrom?: string;
};

export class RoutingHistoryStore {
  private filePath: string;
  private maxEntries: number;

  constructor(filePath: string, maxEntries = 50) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  list(limit?: number): RoutingHistoryEntry[] {
    const entries = this.loadEntries();
    if (limit && limit > 0) {
      return entries.slice(0, limit);
    }
    return entries;
  }

  get(version: string): RoutingHistoryEntry | undefined {
    return this.loadEntries().find((entry) => entry.version === version);
  }

  record(entry: RoutingHistoryEntry): void {
    const entries = this.loadEntries();
    const nextEntries = [entry, ...entries].slice(0, this.maxEntries);
    this.writeEntries(nextEntries);
  }

  private loadEntries(): RoutingHistoryEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { items?: RoutingHistoryEntry[] } | RoutingHistoryEntry[];
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed.items && Array.isArray(parsed.items)) {
        return parsed.items;
      }
      return [];
    } catch {
      return [];
    }
  }

  private writeEntries(entries: RoutingHistoryEntry[]): void {
    const payload = { items: entries };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }
}
