import { createHash } from "node:crypto";
import { stableStringify } from "./stableStringify.js";

export function hashJson(value: unknown): string {
  const payload = stableStringify(value);
  return createHash("sha256").update(payload).digest("hex");
}
