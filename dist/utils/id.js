import { randomUUID } from "node:crypto";
export function generateId(prefix = "req") {
    return `${prefix}_${randomUUID()}`;
}
