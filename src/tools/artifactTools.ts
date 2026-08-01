import type { ToolDefinition } from "../core/types.js";
import type { ArtifactStore } from "../context/artifactStore.js";
import { ToolRegistry } from "./registry.js";

const readArtifactDefinition: ToolDefinition = {
  name: "read_artifact",
  kind: "tool",
  description: "Read an artifact by id with optional offset/limit",
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
    permission: "artifact:read",
    integration: "builtin",
  },
};

export function registerArtifactTools(registry: ToolRegistry, store: ArtifactStore): void {
  registry.register(readArtifactDefinition, async (args) => {
    const id = String(args.id ?? "");
    const offset = args.offset !== undefined ? Number(args.offset) : undefined;
    const limit = args.limit !== undefined ? Number(args.limit) : undefined;
    if (!id) {
      throw new Error("artifact_id_required");
    }
    return store.read(id, { offset, limit });
  });
}
