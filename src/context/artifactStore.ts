import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ArtifactRef = {
  id: string;
  contentType: "application/json" | "text/plain";
  sizeBytes: number;
  sha256: string;
  preview: string;
};

type ManifestEntry = ArtifactRef & { filePath: string };

const MANIFEST_FILE = "manifest.jsonl";

export class ArtifactStore {
  private baseDir: string;
  private manifestPath: string;
  private entries: Map<string, ManifestEntry>;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.manifestPath = path.join(baseDir, MANIFEST_FILE);
    this.entries = new Map();
    this.ensureDir();
    this.loadManifest();
  }

  writeJson(prefix: string, value: unknown, previewChars: number): ArtifactRef {
    const body = JSON.stringify(value, null, 2);
    return this.writeContent(prefix, body, "application/json", previewChars);
  }

  writeText(prefix: string, text: string, previewChars: number): ArtifactRef {
    return this.writeContent(prefix, text, "text/plain", previewChars);
  }

  read(id: string, options?: { offset?: number; limit?: number }): { id: string; content: string; truncated: boolean } {
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

  private writeContent(
    prefix: string,
    text: string,
    contentType: ArtifactRef["contentType"],
    previewChars: number,
  ): ArtifactRef {
    const id = `${prefix}_${crypto.randomUUID()}`;
    const ext = contentType === "application/json" ? "json" : "txt";
    const filePath = path.join(this.baseDir, `${id}.${ext}`);
    fs.writeFileSync(filePath, text);
    const sha256 = crypto.createHash("sha256").update(text).digest("hex");
    const preview = text.slice(0, previewChars);
    const ref: ArtifactRef = {
      id,
      contentType,
      sizeBytes: Buffer.byteLength(text),
      sha256,
      preview,
    };
    const entry: ManifestEntry = { ...ref, filePath };
    this.entries.set(id, entry);
    fs.appendFileSync(this.manifestPath, JSON.stringify(entry) + "\n");
    return ref;
  }

  private ensureDir() {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private loadManifest() {
    if (!fs.existsSync(this.manifestPath)) {
      return;
    }
    const lines = fs.readFileSync(this.manifestPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ManifestEntry;
        if (entry?.id && entry?.filePath) {
          this.entries.set(entry.id, entry);
        }
      } catch {
        continue;
      }
    }
  }
}
