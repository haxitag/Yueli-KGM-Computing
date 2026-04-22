import fs from "node:fs";
import path from "node:path";
export class RoutingHistoryStore {
    filePath;
    maxEntries;
    constructor(filePath, maxEntries = 50) {
        this.filePath = filePath;
        this.maxEntries = maxEntries;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    list(limit) {
        const entries = this.loadEntries();
        if (limit && limit > 0) {
            return entries.slice(0, limit);
        }
        return entries;
    }
    get(version) {
        return this.loadEntries().find((entry) => entry.version === version);
    }
    record(entry) {
        const entries = this.loadEntries();
        const nextEntries = [entry, ...entries].slice(0, this.maxEntries);
        this.writeEntries(nextEntries);
    }
    loadEntries() {
        if (!fs.existsSync(this.filePath)) {
            return [];
        }
        const raw = fs.readFileSync(this.filePath, "utf8").trim();
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed;
            }
            if (parsed.items && Array.isArray(parsed.items)) {
                return parsed.items;
            }
            return [];
        }
        catch {
            return [];
        }
    }
    writeEntries(entries) {
        const payload = { items: entries };
        fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
    }
}
