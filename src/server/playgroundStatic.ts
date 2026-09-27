import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND_ROOT = path.resolve(SERVER_DIR, "../../playground");
const KCE_ENGINE_CANDIDATES = [
  path.resolve(SERVER_DIR, "../../src/kce/kce-engine.js"),
  path.resolve(SERVER_DIR, "../kce/kce-engine.js"),
];

/** 浏览器常打开的别名。Express Playground 会把它们送回首页。 */
const PLAYGROUND_ALIASES = new Set(["/playground", "/playground/", "/dynamic", "/app", "/ui"]);

/**
 * 全局 CSP 是 default-src 'self'。Playground 首页有内联脚本，并引用 jsDelivr 上的 Mermaid。
 * 只放宽 HTML 页面；接口响应不走这里。
 */
const PLAYGROUND_HTML_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  contentType: string,
  relaxCsp: boolean,
): void {
  const body = fs.readFileSync(file);
  if (relaxCsp) {
    res.setHeader("Content-Security-Policy", PLAYGROUND_HTML_CSP);
  }
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * Forge 拉起的是原生 HTTP 网关，不经 Express 静态目录。
 * 模型管理页「返回 Playground」指向 `/`，这里补上首页、别名和 playground 静态文件。
 * 未命中的路径返回 false，仍走原来的 JSON 404。
 */
export function tryServePlayground(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  if (PLAYGROUND_ALIASES.has(pathname)) {
    res.writeHead(302, { Location: "/" });
    res.end();
    return true;
  }

  if (pathname === "/src/kce/kce-engine.js") {
    const file = KCE_ENGINE_CANDIDATES.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!file) return false;
    sendFile(req, res, file, "text/javascript; charset=utf-8", false);
    return true;
  }

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return false;
  const file = path.resolve(PLAYGROUND_ROOT, rel);
  if (!isInside(PLAYGROUND_ROOT, file)) return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  sendFile(req, res, file, MIME[ext] ?? "application/octet-stream", ext === ".html");
  return true;
}
