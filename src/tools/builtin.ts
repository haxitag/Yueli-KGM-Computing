import type { ToolDefinition } from "../core/types.js";
import { ToolRegistry } from "./registry.js";

const searchWebDefinition: ToolDefinition = {
  name: "search_web",
  kind: "tool",
  description: "Search the web for relevant documents",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      top_k: { type: "number" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array" },
    },
  },
  metadata: {
    latency: "medium",
    sideEffect: false,
    costLevel: "medium",
    permission: "network",
    maxRetries: 2,
    tags: ["search", "retrieval"],
    integration: "builtin",
  },
};

const getWeatherDefinition: ToolDefinition = {
  name: "get_weather",
  kind: "tool",
  description: "Get weather for a location",
  inputSchema: {
    type: "object",
    required: ["location"],
    properties: {
      location: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      forecast: { type: "string" },
      temp_c: { type: "number" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    permission: "network",
    maxRetries: 1,
    tags: ["weather"],
    integration: "builtin",
  },
};

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(searchWebDefinition, async (args) => {
    const query = String(args.query ?? "");
    const topK = Number(args.top_k ?? 3);
    const results = Array.from({ length: topK }, (_, idx) => `result_${idx + 1} for ${query}`);
    return { results };
  });

  registry.register(getWeatherDefinition, async (args) => {
    const location = String(args.location ?? "unknown");
    return { location, forecast: "sunny", temp_c: 26 };
  });
}
