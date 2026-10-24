import { spawn } from "node:child_process";

import type { McpConnectorConfigEntry } from "../core/configStore.js";
import { mcpJsonRpc } from "./httpMcpClient.js";

export type McpInitializeResult = {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: Record<string, unknown>;
};

export async function initializeMcpConnector(connector: McpConnectorConfigEntry): Promise<McpInitializeResult> {
  const result = await mcpRpc(connector, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "yueli-kgm-computing", version: "0.3.11" },
  });
  const rec = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return {
    protocolVersion: typeof rec.protocolVersion === "string" ? rec.protocolVersion : "2024-11-05",
    capabilities: rec.capabilities && typeof rec.capabilities === "object" ? (rec.capabilities as Record<string, unknown>) : {},
    serverInfo: rec.serverInfo && typeof rec.serverInfo === "object" ? (rec.serverInfo as Record<string, unknown>) : undefined,
  };
}

export async function listMcpTools(connector: McpConnectorConfigEntry): Promise<unknown> {
  return mcpRpc(connector, "tools/list", {});
}

export async function callMcpConnector(
  connector: McpConnectorConfigEntry,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  await initializeMcpConnector(connector);
  return mcpRpc(connector, "tools/call", { name: toolName, arguments: args });
}

export async function mcpRpc(connector: McpConnectorConfigEntry, method: string, params: unknown): Promise<unknown> {
  if (!connector.enabled) {
    throw new Error("mcp_connector_disabled");
  }
  if (connector.transport === "stdio") {
    const command = connector.command?.trim();
    if (!command) {
      throw new Error("mcp_stdio_command_required");
    }
    return mcpStdioJsonRpc(command, connector.args ?? [], method, params);
  }
  if (connector.transport === "http") {
    const url = connector.url?.trim();
    if (!url) {
      throw new Error("mcp_http_url_required");
    }
    return mcpJsonRpc(url, method, params, connector.headers);
  }
  throw new Error(`mcp_unsupported_transport:${String((connector as { transport?: string }).transport)}`);
}

async function mcpStdioJsonRpc(
  command: string,
  args: string[],
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("mcp_stdio_timeout"));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item.startsWith("{"));
      if (!line) {
        reject(new Error(`mcp_stdio_empty:${code ?? "?"}:${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const json = JSON.parse(line) as { result?: unknown; error?: { message?: string; code?: number } };
        if (json.error) {
          reject(new Error(json.error.message ?? `mcp_rpc_error:${json.error.code ?? ""}`));
          return;
        }
        resolve(json.result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.write(`${payload}\n`);
    child.stdin.end();
  });
}
