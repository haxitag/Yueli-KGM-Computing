import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

import type { SandboxInstance, SandboxKind, SandboxPreview } from "../core/types.js";

export type SandboxAdapter = {
  kind: SandboxKind;
  label: string;
  isConfigured(): boolean;
  adapterHint(): string;
  notes(): string[];
  start(instance: SandboxInstance): void;
  stop(instance: SandboxInstance): void;
  isRunning(instance: SandboxInstance): boolean;
  preview(instance: SandboxInstance): Partial<SandboxPreview>;
  /** Optional: preserve detached child PIDs across config reload. */
  exportProcessMap?(): Map<string, number>;
  importProcessMap?(processes: Map<string, number>): void;
};

type SandboxAdapterConfig = {
  label?: string;
  startCommand?: string;
  stopCommand?: string;
  statusCommand?: string;
  endpoint?: string;
  hint?: string;
  note?: string;
  /** From ConfigStore.sandboxAdapters.*.useEmbedded or env USE_EMBEDDED */
  useEmbedded?: boolean;
};

export function createDefaultSandboxAdapters(
  overlay?: Partial<Record<SandboxKind, SandboxAdapterConfig>>,
): Record<SandboxKind, SandboxAdapter> {
  const fileConfig = loadSandboxAdapterConfig();
  const mergeKind = (kind: SandboxKind): SandboxAdapterConfig | undefined => {
    const fromFile = fileConfig[kind];
    const fromOverlay = overlay?.[kind];
    if (!fromFile && !fromOverlay) {
      return undefined;
    }
    return normalizeConfig({ ...(fromFile ?? {}), ...(fromOverlay ?? {}) });
  };
  return {
    computer: new CommandSandboxAdapter({
      kind: "computer",
      label: "VM Runtime Adapter",
      startEnv: "KGM_SANDBOX_COMPUTER_START_CMD",
      stopEnv: "KGM_SANDBOX_COMPUTER_STOP_CMD",
      statusEnv: "KGM_SANDBOX_COMPUTER_STATUS_CMD",
      endpointEnv: "KGM_SANDBOX_COMPUTER_ENDPOINT",
      embeddedFlagEnv: "KGM_SANDBOX_COMPUTER_USE_EMBEDDED",
      embeddedRunner: "bash",
      embeddedScript: "qemu-vm-adapter.sh",
      hint: "Wire this to QEMU, Firecracker, or another VM runtime command. Set KGM_SANDBOX_COMPUTER_USE_EMBEDDED=1 to use the bundled QEMU adapter.",
      note: "If commands are configured, the sandbox manager will start and stop a real VM-side process.",
      config: mergeKind("computer"),
    }),
    browser: new CommandSandboxAdapter({
      kind: "browser",
      label: "Playwright Adapter",
      startEnv: "KGM_SANDBOX_BROWSER_START_CMD",
      stopEnv: "KGM_SANDBOX_BROWSER_STOP_CMD",
      statusEnv: "KGM_SANDBOX_BROWSER_STATUS_CMD",
      endpointEnv: "KGM_SANDBOX_BROWSER_WS_ENDPOINT",
      embeddedFlagEnv: "KGM_SANDBOX_BROWSER_USE_EMBEDDED",
      embeddedRunner: "node",
      embeddedScript: "playwright-browser-adapter.mjs",
      hint: "Wire this to a Playwright worker, browser pool, or browser WebSocket endpoint. Set KGM_SANDBOX_BROWSER_USE_EMBEDDED=1 to use the bundled Playwright adapter.",
      note: "Recommended: point start command at a Playwright adapter process or provide a WS endpoint.",
      config: mergeKind("browser"),
    }),
    mobile: new CommandSandboxAdapter({
      kind: "mobile",
      label: "Android Emulator Adapter",
      startEnv: "KGM_SANDBOX_MOBILE_START_CMD",
      stopEnv: "KGM_SANDBOX_MOBILE_STOP_CMD",
      statusEnv: "KGM_SANDBOX_MOBILE_STATUS_CMD",
      endpointEnv: "KGM_SANDBOX_MOBILE_ENDPOINT",
      embeddedFlagEnv: "KGM_SANDBOX_MOBILE_USE_EMBEDDED",
      embeddedRunner: "bash",
      embeddedScript: "android-emulator-adapter.sh",
      hint: "Wire this to Android Emulator, ADB-managed devices, or another mobile simulator. Set KGM_SANDBOX_MOBILE_USE_EMBEDDED=1 to use the bundled emulator adapter.",
      note: "Recommended: use emulator start/stop commands or an adapter service that fronts the device runtime.",
      config: mergeKind("mobile"),
    }),
  };
}

class CommandSandboxAdapter implements SandboxAdapter {
  kind: SandboxKind;
  label: string;
  private startEnv: string;
  private stopEnv: string;
  private statusEnv: string;
  private endpointEnv: string;
  private embeddedFlagEnv: string;
  private embeddedRunner: "node" | "bash";
  private embeddedScript: string;
  private hint: string;
  private note: string;
  private config?: SandboxAdapterConfig;
  private processes = new Map<string, number>();

  constructor(params: {
    kind: SandboxKind;
    label: string;
    startEnv: string;
    stopEnv: string;
    statusEnv: string;
    endpointEnv: string;
    embeddedFlagEnv: string;
    embeddedRunner: "node" | "bash";
    embeddedScript: string;
    hint: string;
    note: string;
    config?: SandboxAdapterConfig;
  }) {
    this.kind = params.kind;
    this.label = params.config?.label ?? params.label;
    this.startEnv = params.startEnv;
    this.stopEnv = params.stopEnv;
    this.statusEnv = params.statusEnv;
    this.endpointEnv = params.endpointEnv;
    this.embeddedFlagEnv = params.embeddedFlagEnv;
    this.embeddedRunner = params.embeddedRunner;
    this.embeddedScript = params.embeddedScript;
    this.hint = params.config?.hint ?? params.hint;
    this.note = params.config?.note ?? params.note;
    this.config = params.config;
  }

  isConfigured(): boolean {
    return Boolean(this.resolveCommand("start") || this.resolveEndpoint());
  }

  adapterHint(): string {
    return this.hint;
  }

  notes(): string[] {
    return [this.note];
  }

  start(instance: SandboxInstance): void {
    const endpoint = this.resolveEndpoint();
    if (endpoint) {
      return;
    }
    const command = this.resolveCommand("start");
    if (!command) {
      return;
    }
    if (this.isRunning(instance)) {
      return;
    }
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        KGM_SANDBOX_ID: instance.id,
      },
    });
    child.unref();
    this.processes.set(instance.id, child.pid ?? 0);
  }

  stop(instance: SandboxInstance): void {
    const stopCommand = this.resolveCommand("stop");
    if (stopCommand) {
      execSync(stopCommand, {
        stdio: "ignore",
        env: {
          ...process.env,
          KGM_SANDBOX_ID: instance.id,
          KGM_SANDBOX_PID: String(this.processes.get(instance.id) ?? ""),
        },
      });
      this.processes.delete(instance.id);
      return;
    }

    const pid = this.processes.get(instance.id);
    if (!pid) {
      return;
    }
    try {
      process.kill(pid);
    } catch {
      // ignore
    }
    this.processes.delete(instance.id);
  }

  isRunning(instance: SandboxInstance): boolean {
    const endpoint = this.resolveEndpoint();
    if (endpoint) {
      return true;
    }

    const statusCommand = this.resolveCommand("status");
    if (statusCommand) {
      try {
        execSync(statusCommand, {
          stdio: "ignore",
          env: {
            ...process.env,
            KGM_SANDBOX_ID: instance.id,
            KGM_SANDBOX_PID: String(this.processes.get(instance.id) ?? ""),
          },
        });
        return true;
      } catch {
        return false;
      }
    }

    const pid = this.processes.get(instance.id);
    if (!pid) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  preview(instance: SandboxInstance): Partial<SandboxPreview> {
    const endpoint = this.resolveEndpoint();
    if (endpoint) {
      return {
        detail: `${this.label} attached via ${endpoint}`,
        ...this.getSystemMetrics(),
      };
    }
    const pid = this.processes.get(instance.id);
    if (pid) {
      return {
        detail: `${this.label} process pid=${pid}`,
        ...this.getProcessMetrics(pid),
      };
    }
    if (!this.isConfigured()) {
      return {
        detail: `${this.label} not configured — start unavailable until adapter env is set`,
        cpuPercent: 0,
        memoryMb: 0,
        networkKbps: 0,
      };
    }
    const embedded = this.usingEmbeddedAdapter();
    return {
      detail: embedded
        ? `${this.label} ready (bundled adapter); start to launch process`
        : `${this.label} ready (commands configured); start to launch process`,
      cpuPercent: 0,
      memoryMb: 0,
      networkKbps: 0,
    };
  }

  exportProcessMap(): Map<string, number> {
    return new Map(this.processes);
  }

  importProcessMap(processes: Map<string, number>): void {
    for (const [id, pid] of processes) {
      if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
        this.processes.set(id, pid);
      }
    }
  }

  private getSystemMetrics(): Partial<Pick<SandboxPreview, "cpuPercent" | "memoryMb">> {
    const cpus = os.cpus();
    const totalCpuTime = cpus.reduce((acc, cpu) => acc + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle, 0);
    const idleTime = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
    const cpuPercent = Math.round(((totalCpuTime - idleTime) / totalCpuTime) * 100);
    
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemoryMb = Math.round((totalMemory - freeMemory) / (1024 * 1024));
    
    return { cpuPercent, memoryMb: usedMemoryMb };
  }

  private getProcessMetrics(pid: number): Partial<Pick<SandboxPreview, "cpuPercent" | "memoryMb">> {
    try {
      if (process.platform === "linux") {
        const stat = execSync(`cat /proc/${pid}/stat`).toString();
        const parts = stat.split(" ");
        const utime = parseInt(parts[13], 10);
        const stime = parseInt(parts[14], 10);
        const cutime = parseInt(parts[15], 10);
        const cstime = parseInt(parts[16], 10);
        const totalTime = utime + stime + cutime + cstime;
        
        const uptime = parseFloat(execSync("cat /proc/uptime").toString().split(" ")[0]);
        const hz = 100;
        const cpuPercent = Math.round((totalTime / hz / uptime) * 100);
        
        const status = execSync(`cat /proc/${pid}/status`).toString();
        const vmsizeMatch = status.match(/VmSize:\s*(\d+)/);
        const memoryMb = vmsizeMatch ? Math.round(parseInt(vmsizeMatch[1], 10) / 1024) : undefined;
        
        return { cpuPercent, memoryMb };
      } else if (process.platform === "darwin" || process.platform === "win32") {
        return this.getSystemMetrics();
      }
    } catch {
      // Ignore errors when process info is unavailable
    }
    return {};
  }

  private resolveCommand(commandType: "start" | "stop" | "status"): string | undefined {
    const configured =
      commandType === "start"
        ? this.config?.startCommand
        : commandType === "stop"
          ? this.config?.stopCommand
          : this.config?.statusCommand;
    if (configured?.trim()) {
      return configured.trim();
    }
    const envName =
      commandType === "start" ? this.startEnv : commandType === "stop" ? this.stopEnv : this.statusEnv;
    const explicit = process.env[envName];
    if (explicit) {
      return explicit;
    }
    if (!this.usingEmbeddedAdapter()) {
      return undefined;
    }
    const scriptPath = path.resolve(SANDBOX_SCRIPT_DIR, this.embeddedScript);
    if (!existsSync(scriptPath)) {
      return undefined;
    }
    return `${this.embeddedRunner} "${scriptPath}" ${commandType}`;
  }

  private usingEmbeddedAdapter(): boolean {
    if (typeof this.config?.useEmbedded === "boolean") {
      return this.config.useEmbedded;
    }
    return parseBoolEnv(this.embeddedFlagEnv);
  }

  private resolveEndpoint(): string | undefined {
    return this.config?.endpoint?.trim() || process.env[this.endpointEnv];
  }
}

const SANDBOX_SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/sandbox");

function parseBoolEnv(name: string): boolean {
  const value = process.env[name];
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function loadSandboxAdapterConfig(): Record<SandboxKind, SandboxAdapterConfig | undefined> {
  const raw = process.env.KGM_SANDBOX_ADAPTERS_JSON?.trim() || readOptionalConfigFile(process.env.KGM_SANDBOX_ADAPTERS_PATH);
  if (!raw) {
    return { computer: undefined, browser: undefined, mobile: undefined };
  }
  const parsed = JSON.parse(raw) as Partial<Record<SandboxKind, SandboxAdapterConfig>>;
  return {
    computer: normalizeConfig(parsed.computer),
    browser: normalizeConfig(parsed.browser),
    mobile: normalizeConfig(parsed.mobile),
  };
}

function readOptionalConfigFile(filePath: string | undefined): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  const resolved = path.resolve(filePath);
  return existsSync(resolved) ? readFileSync(resolved, "utf8") : undefined;
}

function normalizeConfig(value: SandboxAdapterConfig | undefined): SandboxAdapterConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value;
}
