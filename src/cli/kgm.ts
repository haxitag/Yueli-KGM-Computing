#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { ManagedModelManager } from "../models/modelManager.js";
import type { ManagedModelSourceType } from "../models/modelManager.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [group, command, ...rest] = args;
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

function printHelp(): void {
  console.log(`Usage:
  kgm models list [--json]
  kgm models ps [--json]
  kgm models pull --source-type <type> --url <url> [--file-path <path>] [--revision <rev>] [--model-name <name>]
  kgm models create --kgmfile <path> [--auto-start]
  kgm models create --source-type <type> --url <url> --runtime <kind> [--file-path <path>] [--model-name <name>] [--port <port>]
  kgm models start <runtime_id>
  kgm models stop <runtime_id>
  kgm models rm <id>
  kgm models metrics <runtime_id|model_name>

Notes:
  source-type supports: huggingface | ollama | github | modelscope | direct | local
  runtime supports: native | llama.cpp | ds4 | ollama | vllm | sglang | mlx | openai-compatible`);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
