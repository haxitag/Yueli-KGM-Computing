/**
 * 最小 MCP JSON-RPC（HTTP POST）客户端。
 * url 应为完整端点（例如网关提供的 /mcp 或 Streamable HTTP 映射地址）。
 */

export async function mcpJsonRpc(
  url: string,
  method: string,
  params: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const body = { jsonrpc: "2.0", id, method, params: params ?? {} };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`mcp_http_${res.status}:${await res.text()}`);
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message?: string; code?: number };
  };
  if (json.error) {
    throw new Error(json.error.message ?? `mcp_rpc_error:${json.error.code ?? ""}`);
  }
  return json.result;
}
