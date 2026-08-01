/**
 * Virtual-key model allow-list checks shared by chat / responses / media routes.
 */

import { kgmErrorBody, type KgmErrorBody } from "../utils/kgmHttpErrors.js";
import type { OpsAuthContext } from "../admin/opsAuthContext.js";

export type ModelAllowResult =
  | { ok: true }
  | { ok: false; status: 403; body: KgmErrorBody };

/**
 * When virtual key has allowedModels, request model must match one of them
 * (or an alias that resolves into the list). Empty/missing allow-list = unrestricted.
 */
export function assertVirtualKeyModelAllowed(
  auth: OpsAuthContext,
  candidates: Array<string | undefined | null>,
): ModelAllowResult {
  if (auth.kind !== "virtual" || !auth.virtualKey?.allowedModels?.length) {
    return { ok: true };
  }
  const allowed = auth.virtualKey.allowedModels;
  const present = candidates
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  // No model on the request → nothing to enforce (e.g. multipart without model field).
  if (present.length === 0) {
    return { ok: true };
  }
  const ok = present.some((c) => allowed.includes(c));
  if (ok) return { ok: true };
  return {
    ok: false,
    status: 403,
    body: kgmErrorBody(
      "model_not_allowed",
      "Virtual key is not allowed to call this model",
      403,
      { allowedModels: allowed },
    ),
  };
}

export function modelFromBody(body: Record<string, unknown> | { model?: unknown }): string | undefined {
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}
