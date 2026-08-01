import { hashJson } from "../utils/hash.js";

export type SchemaStatus = "draft" | "active" | "deprecated" | "retired";

export type SchemaRecord = {
  schemaId: string;
  version: string;
  status: SchemaStatus;
  schemaHash: string;
  schema: Record<string, unknown>;
  createdAt: string;
};

export class SchemaRegistry {
  private records: Map<string, SchemaRecord[]> = new Map();

  register(input: Omit<SchemaRecord, "schemaHash" | "createdAt">): SchemaRecord {
    const record: SchemaRecord = {
      ...input,
      schemaHash: hashJson(input.schema),
      createdAt: new Date().toISOString(),
    };

    const list = this.records.get(record.schemaId) ?? [];
    list.push(record);
    this.records.set(record.schemaId, list);
    return record;
  }

  get(schemaId: string, version?: string): SchemaRecord | undefined {
    const list = this.records.get(schemaId) ?? [];
    if (!version) {
      const active = list.filter((item) => item.status === "active");
      return active[active.length - 1] ?? list[list.length - 1];
    }
    return list.find((item) => item.version === version);
  }

  list(schemaId?: string): SchemaRecord[] {
    if (schemaId) {
      return [...(this.records.get(schemaId) ?? [])];
    }
    const all: SchemaRecord[] = [];
    for (const items of this.records.values()) {
      all.push(...items);
    }
    return all;
  }
}
