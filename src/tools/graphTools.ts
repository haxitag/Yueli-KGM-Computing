import type { ToolDefinition } from "../core/types.js";
import type { GraphStore } from "../graph/store.js";
import { ToolRegistry } from "./registry.js";

const retrieveSubgraphDefinition: ToolDefinition = {
  name: "retrieve_subgraph",
  kind: "tool",
  description: "Retrieve a relevant knowledge-graph subgraph by entities, relations, or query.",
  inputSchema: {
    type: "object",
    properties: {
      entities: { type: "array" },
      relations: { type: "array" },
      query: { type: "string" },
      limit: { type: "number" },
      namespace: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      triples: { type: "array" },
      entities: { type: "array" },
      relations: { type: "array" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    permission: "graph:read",
    integration: "graph",
    tags: ["graph", "reasoning", "retrieval"],
  },
};

export function registerGraphTools(registry: ToolRegistry, graphStore: GraphStore): void {
  registry.register(retrieveSubgraphDefinition, async (args) => {
    const entities = Array.isArray(args.entities) ? args.entities.map(String) : undefined;
    const relations = Array.isArray(args.relations) ? args.relations.map(String) : undefined;
    const query = typeof args.query === "string" ? args.query : undefined;
    const limit = args.limit !== undefined ? Number(args.limit) : undefined;
    const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
    return graphStore.querySubgraph({ entities, relations, query, limit, namespace });
  });
}
