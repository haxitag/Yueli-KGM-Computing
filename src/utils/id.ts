import { randomUUID } from "node:crypto";

export function generateId(prefix = "req"): string {
  return `${prefix}_${randomUUID()}`;
}
