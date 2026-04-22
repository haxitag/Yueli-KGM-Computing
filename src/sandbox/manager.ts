import type { SandboxInstance, SandboxKind, SandboxPreview, SandboxStatus } from "../core/types.js";
import { createDefaultSandboxAdapters } from "./adapters.js";
import type { SandboxAdapter } from "./adapters.js";
import { generateId } from "../utils/id.js";

export class SandboxManager {
  private sandboxes = new Map<string, SandboxInstance>();
  private adapters: Record<SandboxKind, SandboxAdapter>;

  constructor() {
    this.adapters = createDefaultSandboxAdapters();
    this.ensureDefaults();
  }

  list(): SandboxInstance[] {
    return Array.from(this.sandboxes.values()).map((item) => this.withPreview(item));
  }

  get(id: string): SandboxInstance | undefined {
    const sandbox = this.sandboxes.get(id);
    return sandbox ? this.withPreview(sandbox) : undefined;
  }

  create(params: { kind: SandboxKind; name?: string; notes?: string[] }): SandboxInstance {
    const now = new Date().toISOString();
    const kind = params.kind;
    const adapter = this.adapters[kind];
    const instance: SandboxInstance = {
      id: `sbx_${generateId()}`,
      kind,
      name: params.name ?? defaultName(kind),
      status: "stopped",
      runtimeMode: adapter.isConfigured() ? "external" : "simulated",
      adapterHint: adapter.adapterHint(),
      notes: [
        adapter.isConfigured()
          ? "Sandbox adapter is configured. Start/stop will target a real external runtime."
          : "Minimal embedded sandbox. Replace runtimeMode=simulated with an adapter-backed implementation for real isolation.",
        ...defaultNotes(kind),
        ...adapter.notes(),
        ...(params.notes ?? []),
      ],
      createdAt: now,
      updatedAt: now,
      preview: emptyPreview(kind, "stopped"),
    };
    this.sandboxes.set(instance.id, instance);
    return this.withPreview(instance);
  }

  start(id: string): SandboxInstance {
    const sandbox = this.require(id);
    const adapter = this.adapters[sandbox.kind];
    adapter.start(sandbox);
    const updated: SandboxInstance = {
      ...sandbox,
      status: "running" as SandboxStatus,
      runtimeMode: adapter.isConfigured() ? "external" : "simulated",
      updatedAt: new Date().toISOString(),
    };
    this.sandboxes.set(id, updated);
    return this.withPreview(updated);
  }

  stop(id: string): SandboxInstance {
    const sandbox = this.require(id);
    this.adapters[sandbox.kind].stop(sandbox);
    const updated: SandboxInstance = {
      ...sandbox,
      status: "stopped" as SandboxStatus,
      updatedAt: new Date().toISOString(),
    };
    this.sandboxes.set(id, updated);
    return this.withPreview(updated);
  }

  private require(id: string): SandboxInstance {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      throw new Error(`sandbox_not_found:${id}`);
    }
    return sandbox;
  }

  private withPreview(instance: SandboxInstance): SandboxInstance {
    const adapter = this.adapters[instance.kind];
    const running = instance.runtimeMode === "external" ? adapter.isRunning(instance) : instance.status === "running";
    const preview = buildPreview({
      ...instance,
      status: running ? instance.status : "stopped",
    });
    return {
      ...instance,
      status: running ? instance.status : "stopped",
      preview: {
        ...preview,
        ...adapter.preview(instance),
      },
    };
  }

  private ensureDefaults(): void {
    if (this.sandboxes.size > 0) {
      return;
    }
    this.create({ kind: "computer", name: "Virtual Computer" });
    this.create({ kind: "browser", name: "Virtual Browser" });
    this.create({ kind: "mobile", name: "Virtual Mobile" });
  }
}

function buildPreview(instance: SandboxInstance): SandboxPreview {
  const now = Date.now();
  const updatedAt = new Date(instance.updatedAt).getTime();
  const uptimeSec = instance.status === "running" ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : 0;
  const seed = hash(instance.id);
  const running = instance.status === "running";
  const cpuPercent = running ? 12 + ((seed + Math.floor(now / 3000)) % 48) : 0;
  const memoryMb = running ? 512 + ((seed + Math.floor(now / 5000)) % 2048) : 0;
  const networkKbps = running ? 80 + ((seed + Math.floor(now / 2000)) % 920) : 0;

  return {
    cpuPercent,
    memoryMb,
    networkKbps,
    uptimeSec,
    lastUpdatedAt: new Date(now).toISOString(),
    title: previewTitle(instance.kind, instance.status),
    detail: previewDetail(instance.kind, instance.status),
  };
}

function emptyPreview(kind: SandboxKind, status: SandboxStatus): SandboxPreview {
  return {
    cpuPercent: 0,
    memoryMb: 0,
    networkKbps: 0,
    uptimeSec: 0,
    lastUpdatedAt: new Date().toISOString(),
    title: previewTitle(kind, status),
    detail: previewDetail(kind, status),
  };
}

function previewTitle(kind: SandboxKind, status: SandboxStatus): string {
  return `${kind.toUpperCase()} sandbox ${status}`;
}

function previewDetail(kind: SandboxKind, status: SandboxStatus): string {
  if (status !== "running") {
    return "Sandbox is idle. Start it to expose runtime preview metrics.";
  }
  if (kind === "browser") {
    return "Previewing isolated browsing runtime with page/session telemetry.";
  }
  if (kind === "mobile") {
    return "Previewing mobile emulator runtime with device/app telemetry.";
  }
  return "Previewing isolated compute runtime with desktop/session telemetry.";
}

function defaultName(kind: SandboxKind): string {
  if (kind === "browser") return "Virtual Browser";
  if (kind === "mobile") return "Virtual Mobile";
  return "Virtual Computer";
}

function defaultNotes(kind: SandboxKind): string[] {
  if (kind === "browser") {
    return ["Use this sandbox to stage web automation and screenshot workflows behind an adapter."];
  }
  if (kind === "mobile") {
    return ["Use this sandbox to stage app/mobile-agent workflows behind an emulator adapter."];
  }
  return ["Use this sandbox to stage code execution and desktop-like workflows behind a VM adapter."];
}

function hash(input: string): number {
  let result = 0;
  for (let index = 0; index < input.length; index += 1) {
    result = (result * 31 + input.charCodeAt(index)) >>> 0;
  }
  return result;
}
