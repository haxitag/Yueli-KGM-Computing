import { hashJson } from "../utils/hash.js";
export class SchemaRegistry {
    records = new Map();
    register(input) {
        const record = {
            ...input,
            schemaHash: hashJson(input.schema),
            createdAt: new Date().toISOString(),
        };
        const list = this.records.get(record.schemaId) ?? [];
        list.push(record);
        this.records.set(record.schemaId, list);
        return record;
    }
    get(schemaId, version) {
        const list = this.records.get(schemaId) ?? [];
        if (!version) {
            const active = list.filter((item) => item.status === "active");
            return active[active.length - 1] ?? list[list.length - 1];
        }
        return list.find((item) => item.version === version);
    }
    list(schemaId) {
        if (schemaId) {
            return [...(this.records.get(schemaId) ?? [])];
        }
        const all = [];
        for (const items of this.records.values()) {
            all.push(...items);
        }
        return all;
    }
}
