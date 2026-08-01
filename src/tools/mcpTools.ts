import type { PlaygroundConfig } from "../core/configStore.js";
import { mcpJsonRpc } from "../mcp/httpMcpClient.js";
import type { ToolRegistry } from "./registry.js";

export function registerMcpPlaygroundTool(
  registry: ToolRegistry,
  getPlayground: () => PlaygroundConfig,
): void {
  registry.register(
    {
      name: "mcp_call",
      kind: "tool",
      description:
        "调用 Playground 中已配置的 MCP HTTP 连接器（JSON-RPC）。参数：connectorId、toolName、arguments（对象）。",
      inputSchema: {
        type: "object",
        required: ["connectorId", "toolName"],
        properties: {
          connectorId: { type: "string" },
          toolName: { type: "string" },
          arguments: { type: "object" },
        },
      },
      outputSchema: { type: "object" },
      metadata: {
        latency: "medium",
        sideEffect: true,
        costLevel: "medium",
        integration: "external",
        tags: ["mcp"],
      },
    },
    async (args) => {
      const connectorId = String(args.connectorId ?? "");
      const toolName = String(args.toolName ?? "");
      const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
      const pg = getPlayground();
      const conn = pg.mcpConnectors.find((c) => c.id === connectorId);
      if (!conn || !conn.enabled) {
        return { ok: false, error: "connector_not_found_or_disabled" };
      }
      if (conn.transport !== "http" || !conn.url?.trim()) {
        return { ok: false, error: "unsupported_or_missing_url", transport: conn.transport };
      }
      const result = await mcpJsonRpc(
        conn.url.trim(),
        "tools/call",
        { name: toolName, arguments: toolArgs },
        conn.headers,
      );
      return { ok: true, result };
    },
  );
}
