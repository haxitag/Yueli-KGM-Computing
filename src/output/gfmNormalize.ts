import { applyOutputNormalizeIfEnabled } from "@haxitag/markdown-gfm-normalize";
import type { KgmExtensions } from "../core/types.js";

/** compat 层在 finalText 落盘/出 SSE 前按请求开关做 gfm-lite */
export function maybeNormalizeCompatOutput(
  text: string,
  kgm?: KgmExtensions,
  metadata?: Record<string, unknown>,
  requestHeaders?: Record<string, string | string[] | undefined>,
): string {
  if (!text) return text;
  return applyOutputNormalizeIfEnabled(text, kgm, metadata, requestHeaders ?? null);
}

export function normalizeIncomingHttpHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}
