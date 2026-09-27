import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigStore } from "../core/configStore.js";
import { readKgmHttpJsonBody as readJson } from "../server/httpJsonHelpers.js";
import { YUELIAI_V1_MOUNT_PREFIXES, resolveYueliAiConfig } from "./config.js";
import { proxyYueliAiUpstream } from "./upstream.js";
import { appendHttpAccessLog } from "../server/httpRequestRing.js";

const GET_ROUTES = new Set(["/status", "/models"]);
const POST_ROUTES = new Set(["/completions", "/completions/stream", "/search", "/planning", "/embeddings"]);

function resolveSubpath(pathname: string): string | null {
  for (const prefix of YUELIAI_V1_MOUNT_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return pathname.slice(prefix.length) || "/";
    }
  }
  return null;
}

function methodNotAllowed(res: ServerResponse): void {
  const payload = JSON.stringify({
    success: false,
    error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
  });
  res.writeHead(405, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  const payload = JSON.stringify({
    success: false,
    error: { code: "NOT_FOUND", message: "YueliAI v1 endpoint not found" },
  });
  res.writeHead(404, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 处理 `/yueliai/v1/*` 与 `/api/yueliai/v1/*`：配置 `YUELIAI_HOST` + `YUELIAI_API_KEY` 时反向代理至阅粒云端聚合 API。
 * 返回 true 表示已处理（含 404）。
 */
export async function handleYueliaiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options?: { configStore?: ConfigStore },
): Promise<boolean> {
  const subpath = resolveSubpath(pathname);
  if (subpath === null) {
    return false;
  }

  appendHttpAccessLog({
    ts: new Date().toISOString(),
    method: req.method ?? "?",
    pathname,
    channel: "yueliai",
    subpath,
  });

  const method = req.method ?? "GET";
  const config = resolveYueliAiConfig({
    file: options?.configStore?.get().yueliai,
  });

  if (method === "GET" && GET_ROUTES.has(subpath)) {
    await proxyYueliAiUpstream({ config, req, res, subpath, method });
    return true;
  }

  if (method === "POST" && POST_ROUTES.has(subpath)) {
    const body = (await readJson(req)) as Record<string, unknown>;
    const stream = subpath === "/completions/stream" || body.stream === true;
    const upstreamSubpath = stream && subpath === "/completions" ? "/completions/stream" : subpath;
    await proxyYueliAiUpstream({
      config,
      req,
      res,
      subpath: upstreamSubpath,
      method,
      body,
      stream,
    });
    return true;
  }

  if (method === "GET" || method === "POST") {
    notFound(res);
    return true;
  }

  methodNotAllowed(res);
  return true;
}
