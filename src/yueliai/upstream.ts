import type { IncomingMessage, ServerResponse } from "node:http";
import type { YueliAiConfig } from "./config.js";
import { buildYueliAiUpstreamUrl } from "./config.js";
import type { YueliAiResponse } from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function buildYueliAiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
}

function pickForwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function notConfiguredResponse(): YueliAiResponse {
  return {
    success: false,
    error: {
      code: "YUELIAI_NOT_CONFIGURED",
      message: "Set YUELIAI_HOST and YUELIAI_API_KEY to enable YueliAI v1 upstream proxy.",
    },
  };
}

async function relayResponse(res: ServerResponse, upstream: Response): Promise<void> {
  if (res.headersSent) {
    return;
  }
  const headers: Record<string, string | number | string[]> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

export async function proxyYueliAiUpstream(params: {
  config: YueliAiConfig;
  req: IncomingMessage;
  res: ServerResponse;
  subpath: string;
  method: string;
  body?: unknown;
  stream?: boolean;
}): Promise<void> {
  if (!params.config.enabled) {
    const payload = JSON.stringify(notConfiguredResponse());
    params.res.writeHead(503, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    params.res.end(payload);
    return;
  }

  const url = buildYueliAiUpstreamUrl(params.config, params.subpath);
  const headers: Record<string, string> = {
    ...pickForwardHeaders(params.req),
    ...buildYueliAiAuthHeaders(params.config.apiKey),
    accept: params.stream ? "text/event-stream" : "application/json",
  };

  const init: RequestInit = {
    method: params.method,
    headers,
    signal: AbortSignal.timeout(params.config.timeoutMs),
  };

  if (params.body !== undefined && params.method !== "GET" && params.method !== "HEAD") {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    init.body = JSON.stringify(params.body);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = JSON.stringify({
      success: false,
      error: { code: "YUELIAI_UPSTREAM_ERROR", message },
    } satisfies YueliAiResponse);
    params.res.writeHead(502, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    params.res.end(payload);
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (params.stream || contentType.includes("text/event-stream")) {
    await relayResponse(params.res, upstream);
    return;
  }

  const text = await upstream.text();
  if (contentType.includes("application/json") || text.trim().startsWith("{")) {
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const payload = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    params.res.writeHead(upstream.status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    params.res.end(payload);
    return;
  }

  params.res.writeHead(upstream.status, {
    "content-type": contentType || "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  params.res.end(text);
}
