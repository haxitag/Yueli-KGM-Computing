import type { IncomingMessage, ServerResponse } from "node:http";
import { KgmJsonParseError, KgmRequestValidationError } from "../utils/kgmHttpErrors.js";

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** 与 `createKgmServer` 请求体上限一致，可由 `KGM_HTTP_MAX_BODY_SIZE_MB` 覆盖。 */
export function getKgmHttpMaxBodyBytes(): number {
  const envMb = process.env.KGM_HTTP_MAX_BODY_SIZE_MB;
  if (envMb) {
    const mb = Number(envMb);
    if (!Number.isNaN(mb) && mb > 0) {
      return mb * 1024 * 1024;
    }
  }
  return DEFAULT_MAX_BODY_BYTES;
}

/**
 * 读取 Node HTTP 请求体为 JSON。若上游已解析（如 Express `req.body`）则直接返回。
 * 超过 `maxBytes` 时抛出 `KgmRequestValidationError`（413）。
 */
export async function readKgmHttpJsonBody(
  req: IncomingMessage & { body?: unknown },
  maxBytes: number = getKgmHttpMaxBodyBytes(),
): Promise<unknown> {
  if (req.body !== undefined && req.body !== null) {
    return req.body as unknown;
  }
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    totalSize += buffer.length;

    if (totalSize > maxBytes) {
      throw new KgmRequestValidationError(
        "request_too_large",
        `Request body too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))}MB`,
        413,
      );
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new KgmJsonParseError();
  }
}

export function sendKgmHttpJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    console.warn("Attempted to send JSON response after headers were already sent");
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

export function sendKgmHttpText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  if (res.headersSent) {
    console.warn("Attempted to send text response after headers were already sent");
    return;
  }
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
