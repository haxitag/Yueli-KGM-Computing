import type { ToolDefinition } from "../core/types.js";
import type { SessionStore } from "../context/sessionStore.js";
import { ToolRegistry } from "./registry.js";

const readSessionDefinition: ToolDefinition = {
  name: "read_session",
  kind: "tool",
  description: "Read session log by id with optional offset/limit",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      content: { type: "string" },
      truncated: { type: "boolean" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    permission: "session:read",
    integration: "builtin",
  },
};

export function registerSessionTools(registry: ToolRegistry, store: SessionStore): void {
  registry.register(readSessionDefinition, async (args) => {
    const id = String(args.id ?? "");
    const offset = args.offset !== undefined ? Number(args.offset) : undefined;
    const limit = args.limit !== undefined ? Number(args.limit) : undefined;
    if (!id) {
      throw new Error("session_id_required");
    }
    return store.read(id, { offset, limit });
  });
}
