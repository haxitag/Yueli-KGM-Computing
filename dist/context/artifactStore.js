import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const MANIFEST_FILE = "manifest.jsonl";
export class ArtifactStore {
    baseDir;
    manifestPath;
    entries;
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.manifestPath = path.join(baseDir, MANIFEST_FILE);
        this.entries = new Map();
        this.ensureDir();
        this.loadManifest();
    }
    writeJson(prefix, value, previewChars) {
        const body = JSON.stringify(value, null, 2);
        return this.writeContent(prefix, body, "application/json", previewChars);
    }
    writeText(prefix, text, previewChars) {
        return this.writeContent(prefix, text, "text/plain", previewChars);
    }
    read(id, options) {
        const entry = this.entries.get(id);
        if (!entry) {
            throw new Error(`artifact_not_found:${id}`);
        }
        const raw = fs.readFileSync(entry.filePath);
        let start = options?.offset ?? 0;
        let end = options?.limit ? start + options.limit : raw.length;
        if (start < 0) {
            start = Math.max(0, raw.length + start);
        }
        end = Math.min(raw.length, end);
        const sliced = raw.subarray(start, end);
        return { id, content: sliced.toString("utf8"), truncated: end < raw.length };
    }
    writeContent(prefix, text, contentType, previewChars) {
        const id = `${prefix}_${crypto.randomUUID()}`;
        const ext = contentType === "application/json" ? "json" : "txt";
        const filePath = path.join(this.baseDir, `${id}.${ext}`);
        fs.writeFileSync(filePath, text);
        const sha256 = crypto.createHash("sha256").update(text).digest("hex");
        const preview = text.slice(0, previewChars);
        const ref = {
            id,
            contentType,
            sizeBytes: Buffer.byteLength(text),
            sha256,
            preview,
        };
        const entry = { ...ref, filePath };
        this.entries.set(id, entry);
        fs.appendFileSync(this.manifestPath, JSON.stringify(entry) + "\n");
        return ref;
    }
    ensureDir() {
        fs.mkdirSync(this.baseDir, { recursive: true });
    }
    loadManifest() {
        if (!fs.existsSync(this.manifestPath)) {
            return;
        }
        const lines = fs.readFileSync(this.manifestPath, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry?.id && entry?.filePath) {
                    this.entries.set(entry.id, entry);
                }
            }
            catch {
                continue;
            }
        }
    }
}
