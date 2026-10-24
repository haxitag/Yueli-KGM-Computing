#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { ManagedModelManager } from "../models/modelManager.js";
import type { ManagedModelSourceType } from "../models/modelManager.js";
import { createRuntimeWithStorage } from "../runtime.js";
import { createOpenAiChatCompletion } from "../openai/compat.js";
import { OpenAiResponseStore } from "../openai/responseStore.js";
import { DEFAULT_SCHEMA_IDS } from "../core/config.js";
import { ConfigStore } from "../core/configStore.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [group, command, ...rest] = args;
  if (group === "chat") {
    await handleChat([command, ...rest].filter((item): item is string => Boolean(item)));
    return;
  }
  if (group === "task") {
    await handleRemoteGroup("task", command, rest);
    return;
  }
  if (group === "workflow") {
    await handleRemoteGroup("workflow", command, rest);
    return;
  }
  if (group === "usage") {
    await handleRemoteGroup("usage", command, rest);
    return;
  }
  if (group === "mcp") {
    await handleRemoteGroup("mcp", command, rest);
    return;
  }
  if (group === "sandbox") {
    await handleRemoteGroup("sandbox", command, rest);
    return;
  }
  if (group !== "models") {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const manager = new ManagedModelManager();
  try {
    switch (command) {
      case "list":
        await manager.probeAllRuntimes();
        printJsonOrTable(manager.listModels(), rest, renderModelsTable);
        break;
      case "ps":
        await manager.probeAllRuntimes();
        printJsonOrTable(manager.listRunningModels(), rest, renderModelsTable);
        break;
      case "pull":
        await handlePull(manager, rest);
        break;
      case "create":
        await handleCreate(manager, rest);
        break;
      case "start":
        await handleStart(manager, rest);
        break;
      case "stop":
        await handleStop(manager, rest);
        break;
      case "rm":
        handleRemove(manager, rest);
        break;
      case "metrics":
        await handleMetrics(manager, rest);
        break;
      default:
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    manager.close();
  }
}

async function handleChat(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const message = readString(flags, "message");
  if (!message) {
    throw new Error("message_required: kgm chat --message <text> [--model <id>]");
  }
  const configStore = new ConfigStore({
    persistPath: process.env.KGM_CONFIG_PATH ?? "data/kgm.config.json",
    loadFromDisk: true,
  });
  const llm = Object.fromEntries([
    ["provider", process.env.KGM_LLM_PROVIDER],
    ["baseUrl", process.env.KGM_LLM_BASE_URL],
    ["apiKey", process.env.KGM_LLM_API_KEY],
    ["model", process.env.KGM_LLM_MODEL],
    ["path", process.env.KGM_LLM_PATH],
  ].filter(([, value]) => value !== undefined && value !== ""));
  const embedding = Object.fromEntries([
    ["provider", process.env.KGM_EMBEDDING_PROVIDER],
    ["baseUrl", process.env.KGM_EMBEDDING_BASE_URL],
    ["apiKey", process.env.KGM_EMBEDDING_API_KEY],
    ["model", process.env.KGM_EMBEDDING_MODEL],
    ["path", process.env.KGM_EMBEDDING_PATH],
  ].filter(([, value]) => value !== undefined && value !== ""));
  configStore.update({
    ...(Object.keys(llm).length ? { llm } : {}),
    ...(Object.keys(embedding).length ? { embedding } : {}),
    ...(process.env.KGM_VECTOR_BACKEND ? { vector: { backend: process.env.KGM_VECTOR_BACKEND } } : {}),
  } as Parameters<ConfigStore["update"]>[0], { persist: false });
  const runtime = await createRuntimeWithStorage({ configStore });
  try {
    const outputSchema = runtime.schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {};
    const result = await createOpenAiChatCompletion({
      contextBuilder: runtime.contextBuilder,
      llmClient: runtime.llmClient,
      toolRegistry: runtime.toolRegistry,
      configStore: runtime.configStore,
      outputSchema,
      responseStore: new OpenAiResponseStore(),
      skillRuntime: runtime.skillRuntime,
      request: {
        model: readString(flags, "model"),
        messages: [{ role: "user", content: message }],
        stream: false,
        kgm: {
          capabilities: {
            includeBuiltinTools: true,
            executeToolCalls: true,
          },
        },
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    runtime.modelManager.close();
  }
}

async function handlePull(manager: ManagedModelManager, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const artifact = await manager.pull({
    sourceType: readSourceType(flags),
    sourceUrl: readString(flags, "url") ?? readString(flags, "source-url"),
    sourceRef: readString(flags, "ref"),
    filePath: readString(flags, "file-path"),
    revision: readString(flags, "revision"),
    modelName: readString(flags, "model-name"),
    name: readString(flags, "name"),
  });
  console.log(JSON.stringify({ artifact }, null, 2));
}

async function handleCreate(manager: ManagedModelManager, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const kgmfilePath = readString(flags, "kgmfile");
  const kgmfile = kgmfilePath ? fs.readFileSync(path.resolve(kgmfilePath), "utf8") : readString(flags, "kgmfile-text");
  const created = await manager.createModel({
    kgmfile,
    pull: kgmfile
      ? undefined
      : {
          sourceType: readSourceType(flags),
          sourceUrl: readString(flags, "url"),
          sourceRef: readString(flags, "ref"),
          filePath: readString(flags, "file-path"),
          revision: readString(flags, "revision"),
          modelName: readString(flags, "model-name"),
          name: readString(flags, "name"),
        },
    runtime: kgmfile
      ? undefined
      : {
          runtime: (readString(flags, "runtime") ?? "openai-compatible") as any,
          modelName: readString(flags, "model-name"),
          port: readNumber(flags, "port"),
          host: readString(flags, "host"),
          apiPath: readString(flags, "api-path"),
          maxConcurrentRequests: readNumber(flags, "max-concurrent"),
          maxQueueSize: readNumber(flags, "max-queue"),
          retryMaxRetries: readNumber(flags, "retries"),
          circuitBreakerFailures: readNumber(flags, "cb-failures"),
          circuitBreakerCooldownMs: readNumber(flags, "cb-cooldown-ms"),
        },
    autoStart: readBool(flags, "auto-start"),
  });
  console.log(JSON.stringify(created, null, 2));
}

async function handleStart(manager: ManagedModelManager, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    throw new Error("runtime_id_required");
  }
  const runtime = await manager.startRuntime(id);
  console.log(JSON.stringify({ runtime }, null, 2));
}

async function handleStop(manager: ManagedModelManager, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    throw new Error("runtime_id_required");
  }
  const runtime = manager.stopRuntime(id);
  console.log(JSON.stringify({ runtime }, null, 2));
}

function handleRemove(manager: ManagedModelManager, args: string[]): void {
  const id = args[0];
  if (!id) {
    throw new Error("managed_id_required");
  }
  console.log(JSON.stringify(manager.deleteManagedEntity(id), null, 2));
}

async function handleMetrics(manager: ManagedModelManager, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    throw new Error("runtime_or_model_id_required");
  }
  await manager.probeAllRuntimes();
  const metrics =
    manager.getRuntimeMetrics(id)
    ?? manager.listModels().find((item) => item.id === id || item.modelName === id)?.metrics;
  if (!metrics) {
    throw new Error(`model_metrics_not_found:${id}`);
  }
  console.log(JSON.stringify({ metrics }, null, 2));
}

function renderModelsTable(items: Array<Record<string, unknown>>): void {
  const rows = items.map((item) => ({
    id: String(item.id ?? ""),
    model: String(item.modelName ?? ""),
    runtime: String(item.runtime ?? ""),
    status: String(item.status ?? ""),
    running: String(item.running ?? false),
    baseUrl: String(item.baseUrl ?? ""),
  }));
  printTable(rows, ["id", "model", "runtime", "status", "running", "baseUrl"]);
}

function printJsonOrTable<T>(value: T, args: string[], tableRenderer: (rows: any[]) => void): void {
  if (args.includes("--json")) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    tableRenderer(value as any[]);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    index += 1;
  }
  return flags;
}

function readString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSourceType(flags: Map<string, string | boolean>): ManagedModelSourceType | undefined {
  const value = readString(flags, "source-type");
  if (!value) {
    return undefined;
  }
  return value as ManagedModelSourceType;
}

function readNumber(flags: Map<string, string | boolean>, key: string): number | undefined {
  const value = readString(flags, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBool(flags: Map<string, string | boolean>, key: string): boolean | undefined {
  const value = flags.get(key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }
  return undefined;
}

function printTable(rows: Array<Record<string, string>>, columns: string[]): void {
  if (!rows.length) {
    console.log("(empty)");
    return;
  }
  const widths = new Map<string, number>();
  for (const column of columns) {
    widths.set(column, column.length);
  }
  for (const row of rows) {
    for (const column of columns) {
      widths.set(column, Math.max(widths.get(column) ?? 0, String(row[column] ?? "").length));
    }
  }
  const header = columns.map((column) => column.padEnd(widths.get(column) ?? column.length)).join("  ");
  console.log(header);
  console.log(columns.map((column) => "-".repeat(widths.get(column) ?? column.length)).join("  "));
  for (const row of rows) {
    console.log(columns.map((column) => String(row[column] ?? "").padEnd(widths.get(column) ?? column.length)).join("  "));
  }
}

function kgmBaseUrl(): string {
  return (process.env.KGM_BASE_URL ?? "http://127.0.0.1:58691").replace(/\/$/, "");
}

function kgmAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = process.env.KGM_API_KEY?.trim();
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

async function kgmRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${kgmBaseUrl()}${path}`, {
    method,
    headers: kgmAuthHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`kgm_http_${res.status}:${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function handleRemoteGroup(group: string, command: string | undefined, rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  switch (group) {
    case "task":
      await handleTaskCommand(command, rest, flags);
      return;
    case "workflow":
      await handleWorkflowCommand(command, rest, flags);
      return;
    case "usage":
      await handleUsageCommand(command, flags);
      return;
    case "mcp":
      await handleMcpCommand(command, flags);
      return;
    case "sandbox":
      await handleSandboxCommand(command, rest, flags);
      return;
    default:
      printHelp();
      process.exitCode = 1;
  }
}

async function handleTaskCommand(
  command: string | undefined,
  rest: string[],
  flags: Map<string, string | boolean>,
): Promise<void> {
  const id = rest.find((item) => !item.startsWith("--")) ?? readString(flags, "id");
  switch (command) {
    case "create": {
      const input = readString(flags, "input");
      if (!input) {
        throw new Error("kgm task create --input <text> [--type inference|agent_execute] [--agent-id <id>]");
      }
      printRemote(
        await kgmRequest("POST", "/v1/tasks", {
          input,
          type: readString(flags, "type") ?? "inference",
          agent_id: readString(flags, "agent-id"),
          session_id: readString(flags, "session-id"),
        }),
      );
      return;
    }
    case "get":
      if (!id) {
        throw new Error("kgm task get <id>");
      }
      printRemote(await kgmRequest("GET", `/v1/tasks/${id}`));
      return;
    case "list":
      printRemote(await kgmRequest("GET", readString(flags, "status") ? `/v1/tasks?status=${readString(flags, "status")}` : "/v1/tasks"));
      return;
    case "cancel":
      if (!id) {
        throw new Error("kgm task cancel <id>");
      }
      printRemote(await kgmRequest("POST", `/v1/tasks/${id}/cancel`));
      return;
    default:
      throw new Error("kgm task <create|get|list|cancel>");
  }
}

async function handleWorkflowCommand(
  command: string | undefined,
  rest: string[],
  flags: Map<string, string | boolean>,
): Promise<void> {
  switch (command) {
    case "create": {
      const file = readString(flags, "file");
      if (!file) {
        throw new Error("kgm workflow create --file <graph.json>");
      }
      const graph = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      printRemote(await kgmRequest("POST", "/v1/workflows", graph));
      return;
    }
    case "execute": {
      const file = readString(flags, "file");
      const workflowId = readString(flags, "id") ?? rest.find((item) => !item.startsWith("--"));
      const inputRaw = readString(flags, "input");
      const input = inputRaw ? (JSON.parse(inputRaw) as unknown) : {};
      if (file) {
        const graph = JSON.parse(fs.readFileSync(file, "utf8")) as { nodes?: unknown; edges?: unknown; name?: string };
        printRemote(await kgmRequest("POST", "/v1/kgm/workflow/execute", { ...graph, input }));
        return;
      }
      if (!workflowId) {
        throw new Error("kgm workflow execute --id <id> | --file <graph.json> [--input <json>]");
      }
      printRemote(await kgmRequest("POST", `/v1/workflows/${workflowId}/execute`, { input }));
      return;
    }
    case "list":
      printRemote(await kgmRequest("GET", "/v1/workflows"));
      return;
    default:
      throw new Error("kgm workflow <create|execute|list>");
  }
}

async function handleUsageCommand(command: string | undefined, flags: Map<string, string | boolean>): Promise<void> {
  const since = readString(flags, "since");
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  if (command === "summary" || command === undefined) {
    printRemote(await kgmRequest("GET", `/v1/kgm/usage/summary${qs}`));
    return;
  }
  if (command === "events") {
    printRemote(await kgmRequest("GET", `/v1/kgm/usage${qs}`));
    return;
  }
  throw new Error("kgm usage [summary|events] [--since <iso>]");
}

async function handleMcpCommand(command: string | undefined, flags: Map<string, string | boolean>): Promise<void> {
  const connectorId = readString(flags, "connector-id");
  if (!connectorId) {
    throw new Error("kgm mcp <initialize|tools> --connector-id <id>");
  }
  if (command === "initialize") {
    printRemote(await kgmRequest("POST", "/v1/kgm/mcp/initialize", { connector_id: connectorId }));
    return;
  }
  if (command === "tools") {
    printRemote(await kgmRequest("GET", `/v1/kgm/mcp/tools?connector_id=${encodeURIComponent(connectorId)}`));
    return;
  }
  throw new Error("kgm mcp <initialize|tools> --connector-id <id>");
}

async function handleSandboxCommand(
  command: string | undefined,
  rest: string[],
  flags: Map<string, string | boolean>,
): Promise<void> {
  const id = readString(flags, "id") ?? rest.find((item) => !item.startsWith("--"));
  switch (command) {
    case "list":
      printRemote(await kgmRequest("GET", "/v1/kgm/sandboxes"));
      return;
    case "start":
      if (!id) {
        throw new Error("kgm sandbox start --id <id>");
      }
      printRemote(await kgmRequest("POST", `/v1/kgm/sandboxes/${id}/start`));
      return;
    case "stop":
      if (!id) {
        throw new Error("kgm sandbox stop --id <id>");
      }
      printRemote(await kgmRequest("POST", `/v1/kgm/sandboxes/${id}/stop`));
      return;
    case "exec": {
      if (!id) {
        throw new Error("kgm sandbox exec --id <id> --command <cmd>");
      }
      const commandLine = readString(flags, "command");
      if (!commandLine) {
        throw new Error("kgm sandbox exec --id <id> --command <cmd>");
      }
      printRemote(
        await kgmRequest("POST", `/v1/kgm/sandboxes/${id}/exec`, {
          command: commandLine,
          args: readString(flags, "args") ? JSON.parse(readString(flags, "args")!) : undefined,
        }),
      );
      return;
    }
    default:
      throw new Error("kgm sandbox <list|start|stop|exec>");
  }
}

function printRemote(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Usage:
  kgm chat --message <text> [--model <id>]
  kgm models list [--json]
  kgm models ps [--json]
  kgm models pull --source-type <type> --url <url> [--file-path <path>] [--revision <rev>] [--model-name <name>]
  kgm models create --kgmfile <path> [--auto-start]
  kgm models create --source-type <type> --url <url> --runtime <kind> [--file-path <path>] [--model-name <name>] [--port <port>]
  kgm models start <runtime_id>
  kgm models stop <runtime_id>
  kgm models rm <id>
  kgm models metrics <runtime_id|model_name>
  kgm task create --input <text> [--type inference|agent_execute] [--agent-id <id>]
  kgm task get <id>
  kgm task list [--status queued|running|completed|failed]
  kgm task cancel <id>
  kgm workflow create --file <graph.json>
  kgm workflow execute --id <id> | --file <graph.json> [--input <json>]
  kgm workflow list
  kgm usage [summary|events] [--since <iso>]
  kgm mcp initialize --connector-id <id>
  kgm mcp tools --connector-id <id>
  kgm sandbox list
  kgm sandbox start --id <id>
  kgm sandbox stop --id <id>
  kgm sandbox exec --id <id> --command <cmd>

Notes:
  source-type supports: huggingface | ollama | github | modelscope | direct | local
  runtime supports: native | llama.cpp | ds4 | ollama | vllm | sglang | mlx | openai-compatible
  task / workflow / usage / mcp / sandbox talk to a running gateway (KGM_BASE_URL, optional KGM_API_KEY)`);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
