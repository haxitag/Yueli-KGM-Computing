import fs from "node:fs";
import path from "node:path";

export type SessionLogEntry = {
  timestamp: string;
  role: "user" | "assistant" | "tool";
  type: "input" | "final" | "tool";
  name?: string;
  content?: string;
  output?: Record<string, unknown>;
};

export type SessionStoreRef = {
  id: string;
  sizeBytes: number;
  preview: string;
  updatedAt: string;
};

export class SessionStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
  }

  append(sessionId: string, entry: SessionLogEntry): SessionStoreRef {
    const filePath = this.filePath(sessionId);
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(filePath, line);
    return this.getRef(sessionId, 240);
  }

  getRef(sessionId: string, previewChars: number): SessionStoreRef {
    const filePath = this.filePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return {
        id: sessionId,
        sizeBytes: 0,
        preview: "",
        updatedAt: new Date().toISOString(),
      };
    }
    const stat = fs.statSync(filePath);
    const preview = readTail(filePath, previewChars);
    return {
      id: sessionId,
      sizeBytes: stat.size,
      preview,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  read(
    sessionId: string,
    options?: { offset?: number; limit?: number },
  ): { id: string; content: string; truncated: boolean } {
    const filePath = this.filePath(sessionId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`session_not_found:${sessionId}`);
    }
    const raw = fs.readFileSync(filePath);
    let start = options?.offset ?? 0;
    let end = options?.limit ? start + options.limit : raw.length;
    if (start < 0) {
      start = Math.max(0, raw.length + start);
    }
    end = Math.min(raw.length, end);
    const sliced = raw.subarray(start, end);
    return { id: sessionId, content: sliced.toString("utf8"), truncated: end < raw.length };
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^\w\-\.]/g, "_");
    return path.join(this.baseDir, `${safe}.log.jsonl`);
  }
}

function readTail(filePath: string, maxChars: number): string {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const offset = Math.max(0, size - maxChars);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
