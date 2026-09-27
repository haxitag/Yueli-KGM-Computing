import type { SkillRegistry } from "../skills/runtime.js";
import type { ToolDefinition } from "../core/types.js";
import { ToolRegistry } from "./registry.js";

const listToolsDefinition: ToolDefinition = {
  name: "list_tools",
  kind: "function",
  description: "List available tools by name",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: { tools: { type: "array" } },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    integration: "builtin",
  },
};

const describeToolDefinition: ToolDefinition = {
  name: "describe_tool",
  kind: "function",
  description: "Get tool definition by name",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      kind: { type: "string" },
      description: { type: "string" },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      metadata: { type: "object" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    integration: "builtin",
  },
};

const listSkillsDefinition: ToolDefinition = {
  name: "list_skills",
  kind: "function",
  description: "List available skills by name",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: { skills: { type: "array" } },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    integration: "builtin",
  },
};

const describeSkillDefinition: ToolDefinition = {
  name: "describe_skill",
  kind: "function",
  description: "Get skill definition by name",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      steps: { type: "array" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    integration: "builtin",
  },
};

export function registerCatalogTools(
  toolRegistry: ToolRegistry,
  skillRegistry?: SkillRegistry,
): void {
  toolRegistry.register(listToolsDefinition, async () => {
    const tools = toolRegistry.listDefinitions().map((def) => def.name);
    return { tools };
  });

  toolRegistry.register(describeToolDefinition, async (args) => {
    const name = String(args.name ?? "");
    const def = toolRegistry.getDefinition(name);
    if (!def) {
      throw new Error(`tool_not_found:${name}`);
    }
    return {
      name: def.name,
      kind: def.kind ?? "tool",
      description: def.description,
      input_schema: def.inputSchema,
      output_schema: def.outputSchema,
      metadata: def.metadata ?? {},
    };
  });

  if (skillRegistry) {
    toolRegistry.register(listSkillsDefinition, async () => {
      return { skills: skillRegistry.listNames() };
    });

    toolRegistry.register(describeSkillDefinition, async (args) => {
      const name = String(args.name ?? "");
      const skill = skillRegistry.get(name);
      if (!skill) {
        throw new Error(`skill_not_found:${name}`);
      }
      return {
        name: skill.name,
        description: skill.description,
        steps: skill.steps,
      };
    });
  }
}
