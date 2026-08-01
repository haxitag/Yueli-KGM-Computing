import fs from "node:fs";
import path from "node:path";

import type { ToolDefinition } from "../core/types.js";
import { ToolRegistry } from "./registry.js";

const listFilesDefinition: ToolDefinition = {
  name: "list_files",
  kind: "tool",
  description: "List files under an allowed filesystem root.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      items: { type: "array" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    permission: "filesystem:read",
    integration: "builtin",
    tags: ["filesystem"],
  },
};

const readFileDefinition: ToolDefinition = {
  name: "read_file",
  kind: "tool",
  description: "Read a UTF-8 text file under an allowed filesystem root.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      sizeBytes: { type: "number" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    permission: "filesystem:read",
    integration: "builtin",
    tags: ["filesystem"],
  },
};

const writeFileDefinition: ToolDefinition = {
  name: "write_file",
  kind: "tool",
  description: "Create or overwrite a UTF-8 text file under an allowed filesystem root.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      sizeBytes: { type: "number" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: true,
    costLevel: "low",
    permission: "filesystem:write",
    integration: "builtin",
    tags: ["filesystem"],
  },
};

const deleteFileDefinition: ToolDefinition = {
  name: "delete_file",
  kind: "tool",
  description: "Delete a file under an allowed filesystem root.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      deleted: { type: "boolean" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: true,
    costLevel: "low",
    permission: "filesystem:write",
    integration: "builtin",
    tags: ["filesystem"],
  },
};

const httpRequestDefinition: ToolDefinition = {
  name: "http_request",
  kind: "tool",
  description: "Call an external HTTP JSON/text API.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      method: { type: "string" },
      headers: { type: "object" },
      body: {},
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "number" },
      headers: { type: "object" },
      body: {},
    },
  },
  metadata: {
    latency: "medium",
    sideEffect: true,
    costLevel: "low",
    permission: "network",
    integration: "external",
    tags: ["http", "api"],
  },
};

const externalExecutorDefinition: ToolDefinition = {
  name: "execute_external",
  kind: "tool",
  description: "Run an action through a configured external executor service.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string" },
      input: {},
      metadata: { type: "object" },
    },
  },
  outputSchema: {
    type: "object",
  },
  metadata: {
    latency: "medium",
    sideEffect: true,
    costLevel: "medium",
    permission: "executor:run",
    integration: "external",
    tags: ["executor"],
  },
};

export function registerIoTools(registry: ToolRegistry): void {
  registry.register(listFilesDefinition, async (args) => {
    const resolved = resolveAllowedPath(String(args.path ?? "."));
    const stat = fs.statSync(resolved);
    const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
    return {
      path: dir,
      items: fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
        const entryPath = path.join(dir, entry.name);
        const entryStat = fs.statSync(entryPath);
        return {
          name: entry.name,
          path: entryPath,
          type: entry.isDirectory() ? "directory" : "file",
          sizeBytes: entry.isDirectory() ? undefined : entryStat.size,
          updatedAt: entryStat.mtime.toISOString(),
        };
      }),
    };
  });

  registry.register(readFileDefinition, async (args) => {
    const resolved = resolveAllowedPath(requiredString(args.path, "path"));
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error("path_is_not_file");
    }
    const content = fs.readFileSync(resolved, "utf8");
    const offset = clampNumber(args.offset, 0, content.length, 0);
    const limit = clampNumber(args.limit, 1, 1_000_000, content.length);
    return {
      path: resolved,
      content: content.slice(offset, offset + limit),
      sizeBytes: stat.size,
    };
  });

  registry.register(writeFileDefinition, async (args) => {
    const resolved = resolveAllowedPath(requiredString(args.path, "path"));
    const content = requiredString(args.content, "content");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return {
      path: resolved,
      sizeBytes: Buffer.byteLength(content),
    };
  });

  registry.register(deleteFileDefinition, async (args) => {
    const resolved = resolveAllowedPath(requiredString(args.path, "path"));
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error("path_is_not_file");
    }
    fs.unlinkSync(resolved);
    return { path: resolved, deleted: true };
  });

  registry.register(httpRequestDefinition, async (args) => {
    return executeHttpRequest(args);
  });

  registry.register(externalExecutorDefinition, async (args) => {
    return executeExternal(args);
  });
}

function resolveAllowedPath(input: string): string {
  const resolved = path.resolve(input);
  const roots = allowedRoots();
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`path_outside_allowed_roots:${resolved}`);
  }
  return resolved;
}

function allowedRoots(): string[] {
  const raw = process.env.KGM_FILE_TOOL_ROOTS;
  const values = raw?.split(",").map((item) => item.trim()).filter(Boolean) ?? [process.cwd()];
  return values.map((item) => path.resolve(item));
}

async function executeHttpRequest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = new URL(requiredString(args.url, "url"));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported_url_protocol");
  }
  enforceAllowedOrigin(url);
  const method = String(args.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new Error(`unsupported_http_method:${method}`);
  }
  const headers = normalizeHeaders(args.headers);
  const body = args.body === undefined || method === "GET" ? undefined : serializeBody(args.body, headers);
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: parseResponseBody(text, response.headers.get("content-type") ?? ""),
  };
}

async function executeExternal(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const baseUrl = process.env.KGM_EXECUTOR_URL?.trim();
  if (!baseUrl) {
    throw new Error("external_executor_not_configured");
  }
  const pathPart = process.env.KGM_EXECUTOR_PATH?.trim() || "/execute";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = process.env.KGM_EXECUTOR_API_KEY?.trim();
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/${pathPart.replace(/^\/+/, "")}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: requiredString(args.action, "action"),
      input: args.input ?? {},
      metadata: args.metadata ?? {},
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`external_executor_http_${response.status}:${text}`);
  }
  return parseResponseBody(text, response.headers.get("content-type") ?? "");
}

function enforceAllowedOrigin(url: URL): void {
  const raw = process.env.KGM_HTTP_TOOL_ALLOWED_ORIGINS;
  if (!raw?.trim()) {
    return;
  }
  const allowed = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowed.includes(url.origin)) {
    throw new Error(`origin_not_allowed:${url.origin}`);
  }
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") {
      result[key] = headerValue;
    }
  }
  return result;
}

function serializeBody(value: unknown, headers: Record<string, string>): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  return JSON.stringify(value);
}

function parseResponseBody(text: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    return { value: JSON.parse(text) };
  }
  return { text };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
