import type { ToolDefinition } from "../core/types.js";
import { SandboxManager } from "../sandbox/manager.js";
import { ToolRegistry } from "./registry.js";

const listSandboxesDefinition: ToolDefinition = {
  name: "list_sandboxes",
  kind: "tool",
  description: "List available virtual sandboxes and their preview state.",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: {
      sandboxes: { type: "array" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    permission: "sandbox:read",
    integration: "builtin",
    tags: ["sandbox", "preview"],
  },
};

const startSandboxDefinition: ToolDefinition = {
  name: "start_sandbox",
  kind: "tool",
  description: "Start a sandbox instance by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      sandbox: { type: "object" },
    },
  },
  metadata: {
    latency: "medium",
    sideEffect: true,
    costLevel: "medium",
    permission: "sandbox:control",
    integration: "builtin",
    tags: ["sandbox", "control"],
  },
};

const stopSandboxDefinition: ToolDefinition = {
  name: "stop_sandbox",
  kind: "tool",
  description: "Stop a sandbox instance by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      sandbox: { type: "object" },
    },
  },
  metadata: {
    latency: "medium",
    sideEffect: true,
    costLevel: "medium",
    permission: "sandbox:control",
    integration: "builtin",
    tags: ["sandbox", "control"],
  },
};

const execSandboxDefinition: ToolDefinition = {
  name: "exec_sandbox",
  kind: "tool",
  description:
    "在已配置 exec 适配器的沙箱里执行命令。未配置 KGM_SANDBOX_*_EXEC_CMD 或 endpoint /exec 时会失败，不假装成功。",
  inputSchema: {
    type: "object",
    required: ["id", "command"],
    properties: {
      id: { type: "string" },
      command: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      timeoutMs: { type: "number" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "number" },
    },
  },
  metadata: {
    latency: "slow",
    sideEffect: true,
    costLevel: "medium",
    permission: "sandbox:exec",
    integration: "builtin",
    tags: ["sandbox", "exec"],
  },
};

export function registerSandboxTools(registry: ToolRegistry, sandboxManager: SandboxManager): void {
  registry.register(listSandboxesDefinition, async () => ({ sandboxes: sandboxManager.list() }));
  registry.register(startSandboxDefinition, async (args) => ({ sandbox: sandboxManager.start(String(args.id ?? "")) }));
  registry.register(stopSandboxDefinition, async (args) => ({ sandbox: sandboxManager.stop(String(args.id ?? "")) }));
  registry.register(execSandboxDefinition, async (args) =>
    sandboxManager.exec(String(args.id ?? ""), {
      command: String(args.command ?? ""),
      args: Array.isArray(args.args) ? args.args.map(String) : undefined,
      timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
    }),
  );
}
