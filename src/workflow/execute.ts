import type { SkillRuntime } from "../skills/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SandboxManager } from "../sandbox/manager.js";
import { callMcpConnector } from "../mcp/session.js";
import type { McpConnectorConfigEntry } from "../core/configStore.js";

export type WorkflowNode = {
  id: string;
  type: string;
  agentId?: string;
  tool?: string;
  config?: Record<string, unknown>;
};

export type WorkflowEdge = {
  source: string;
  target: string;
  condition?: string;
};

export type WorkflowGraph = {
  id?: string;
  name?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type WorkflowStepRecord = {
  nodeId: string;
  timestamp: string;
  status: "completed" | "failed" | "skipped";
  output?: unknown;
  error?: string;
};

export type WorkflowRunResult = {
  status: "completed" | "failed";
  output?: unknown;
  error?: string;
  history: WorkflowStepRecord[];
  currentNodeId?: string;
};

export type WorkflowExecuteDeps = {
  toolRegistry: ToolRegistry;
  skillRuntime?: SkillRuntime;
  sandboxManager?: SandboxManager;
  getMcpConnector?: (id: string) => McpConnectorConfigEntry | undefined;
  chat?: (input: { prompt: string; model?: string }) => Promise<unknown>;
};

export class WorkflowNodeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function executeWorkflowGraph(
  graph: WorkflowGraph,
  input: unknown,
  deps: WorkflowExecuteDeps,
): Promise<WorkflowRunResult> {
  const history: WorkflowStepRecord[] = [];
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new WorkflowNodeError("workflow_empty", "Workflow has no nodes.", 400);
  }
  const order = topologicalOrder(graph.nodes, graph.edges);
  let ctx: unknown = input ?? {};

  for (const node of order) {
    const started = new Date().toISOString();
    try {
      ctx = await runNode(node, ctx, deps);
      history.push({ nodeId: node.id, timestamp: started, status: "completed", output: ctx });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof WorkflowNodeError ? error.code : "node_failed";
      history.push({ nodeId: node.id, timestamp: started, status: "failed", error: `${code}:${message}` });
      return { status: "failed", error: `${code}:${message}`, history, currentNodeId: node.id };
    }
  }

  return { status: "completed", output: ctx, history };
}

function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      throw new WorkflowNodeError("workflow_edge_invalid", `Edge ${edge.source}->${edge.target} names a missing node.`, 400);
    }
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  const ordered: WorkflowNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (node) {
      ordered.push(node);
    }
    for (const next of outgoing.get(id) ?? []) {
      const left = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, left);
      if (left === 0) {
        queue.push(next);
      }
    }
  }
  if (ordered.length !== nodes.length) {
    throw new WorkflowNodeError("workflow_cycle", "Workflow graph has a cycle or disconnected inbound edges.", 400);
  }
  return ordered;
}

async function runNode(node: WorkflowNode, ctx: unknown, deps: WorkflowExecuteDeps): Promise<unknown> {
  const type = node.type.trim().toLowerCase();
  const config = (node.config && typeof node.config === "object" ? node.config : {}) as Record<string, unknown>;
  const bag = asRecord(ctx);

  switch (type) {
    case "noop":
      return ctx;
    case "tool": {
      const name = String(node.tool ?? config.tool ?? "").trim();
      if (!name) {
        throw new WorkflowNodeError("tool_name_required", `Node ${node.id} type=tool needs tool.`);
      }
      return deps.toolRegistry.execute(name, mergeInput(bag, config.input));
    }
    case "skill": {
      const name = String(node.tool ?? config.skill ?? "").trim();
      if (!name) {
        throw new WorkflowNodeError("skill_name_required", `Node ${node.id} type=skill needs skill name.`);
      }
      if (!deps.skillRuntime) {
        throw new WorkflowNodeError("skill_runtime_unavailable", "Skill runtime is not configured.", 501);
      }
      return deps.skillRuntime.run(name, mergeInput(bag, config.input));
    }
    case "http": {
      const url = String(config.url ?? "").trim();
      if (!url) {
        throw new WorkflowNodeError("http_url_required", `Node ${node.id} type=http needs config.url.`);
      }
      const method = String(config.method ?? "POST").toUpperCase();
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...(asStringMap(config.headers)) },
        body: method === "GET" ? undefined : JSON.stringify(config.body ?? ctx),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new WorkflowNodeError("http_upstream_failed", `HTTP ${res.status}: ${text.slice(0, 400)}`, 502);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { text };
      }
    }
    case "sandbox_exec": {
      if (!deps.sandboxManager) {
        throw new WorkflowNodeError("sandbox_unavailable", "Sandbox manager is not configured.", 501);
      }
      const sandboxId = String(config.sandboxId ?? bag.sandboxId ?? "").trim();
      const command = String(config.command ?? bag.command ?? "").trim();
      if (!sandboxId || !command) {
        throw new WorkflowNodeError("sandbox_exec_args", `Node ${node.id} needs config.sandboxId and config.command.`);
      }
      return deps.sandboxManager.exec(sandboxId, {
        command,
        args: Array.isArray(config.args) ? config.args.map(String) : undefined,
        timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
      });
    }
    case "mcp": {
      const connectorId = String(config.connectorId ?? "").trim();
      const toolName = String(config.toolName ?? node.tool ?? "").trim();
      if (!connectorId || !toolName) {
        throw new WorkflowNodeError("mcp_args", `Node ${node.id} needs config.connectorId and toolName.`);
      }
      const connector = deps.getMcpConnector?.(connectorId);
      if (!connector) {
        throw new WorkflowNodeError("mcp_connector_not_found", `MCP connector ${connectorId} is missing or disabled.`, 400);
      }
      return callMcpConnector(connector, toolName, mergeInput(bag, config.arguments));
    }
    case "chat":
    case "agent": {
      if (!deps.chat) {
        throw new WorkflowNodeError("chat_unavailable", "Chat executor is not wired for this server.", 501);
      }
      const prompt = String(config.prompt ?? bag.prompt ?? bag.content ?? JSON.stringify(ctx));
      return deps.chat({ prompt, model: typeof config.model === "string" ? config.model : undefined });
    }
    default:
      throw new WorkflowNodeError(
        "node_type_unsupported",
        `Node ${node.id} type=${node.type} is not implemented. Supported: noop, tool, skill, http, sandbox_exec, mcp, chat, agent.`,
      );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mergeInput(ctx: Record<string, unknown>, extra: unknown): Record<string, unknown> {
  const add = extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
  return { ...ctx, ...add };
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
