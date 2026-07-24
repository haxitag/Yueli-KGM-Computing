import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND_INDEX = path.join(__dirname, "../../playground/index.html");

/** Paths that browsers sometimes open by mistake; always send them to Playground. */
const PLAYGROUND_ALIASES = new Set(["/dynamic", "/app", "/playground", "/ui"]);

function isApiOrProbePath(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname === "/metrics" ||
    pathname === "/openapi.json" ||
    pathname === "/v1/openapi.json" ||
    pathname.startsWith("/generated-")
  );
}

function wantsHtml(req: Request): boolean {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

/**
 * Before the KGM JSON catch-all: redirect known mistaken URLs and serve
 * Playground HTML for browser navigations to unknown extension-less paths.
 */
export function createPlaygroundSpaFallbackMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }
    const pathname = (req.path || "/").split("?")[0] || "/";

    if (PLAYGROUND_ALIASES.has(pathname)) {
      return res.redirect(302, "/");
    }

    if (!wantsHtml(req) || isApiOrProbePath(pathname)) {
      return next();
    }

    // Static assets (*.js / *.css / …) are already handled; leftover bare paths
    // from bookmarks / extensions should land on Playground, not JSON 404.
    if (pathname.includes(".")) {
      return next();
    }

    return res.sendFile(PLAYGROUND_INDEX);
  };
}
