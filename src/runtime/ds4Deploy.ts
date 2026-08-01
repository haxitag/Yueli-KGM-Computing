/**
 * Optional ds4 (DwarfStar) deployment gate.
 * Product path: DeepSeek V4 / GLM specialized local throughput via managed worker —
 * NOT in-process native-gpu kernels (see docs/算子几llamaCPP.md).
 */

import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type Ds4EnableMode = "on" | "off" | "auto";

export type Ds4DeployConfig = {
  /** on = must use when selected; off = never; auto = enable only if binary found */
  enabled: Ds4EnableMode;
  /** Absolute or PATH command for ds4-server */
  command: string;
  installHint: string;
  /** Working directory hint (ds4 prefers --chdir near GGUF / kernels) */
  chdir?: string;
};

export type Ds4DeployStatus = {
  config: Ds4DeployConfig;
  selectable: boolean;
  installed: boolean;
  resolvedCommand?: string;
  version?: string;
  reason: string;
  remediation: string[];
};

const DEFAULT_INSTALL_HINT =
  "Build/install antirez/ds4 (https://github.com/antirez/ds4), " +
  "set KGM_DS4_SERVER_CMD to the ds4-server binary, and KGM_DS4_ENABLED=on|auto. " +
  "Do not merge ds4 kernels into KGM native-gpu.";

export function parseDs4EnableMode(raw: string | undefined): Ds4EnableMode {
  const value = String(raw ?? "auto").trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off" || value === "disabled" || value === "no") {
    return "off";
  }
  if (value === "1" || value === "true" || value === "on" || value === "enabled" || value === "yes") {
    return "on";
  }
  return "auto";
}

export function resolveDs4DeployConfig(overrides?: Partial<Ds4DeployConfig>): Ds4DeployConfig {
  const envEnabled = process.env.KGM_DS4_ENABLED;
  const envCmd = process.env.KGM_DS4_SERVER_CMD;
  const envHint = process.env.KGM_DS4_INSTALL_HINT;
  const envChdir = process.env.KGM_DS4_CHDIR;
  // ConfigStore / UI overrides win over env
  return {
    enabled:
      overrides?.enabled !== undefined
        ? overrides.enabled
        : envEnabled !== undefined && String(envEnabled).trim() !== ""
          ? parseDs4EnableMode(envEnabled)
          : "auto",
    command: (overrides?.command?.trim() || envCmd?.trim() || "ds4-server"),
    installHint: (overrides?.installHint?.trim() || envHint?.trim() || DEFAULT_INSTALL_HINT),
    chdir: (overrides?.chdir?.trim() || envChdir?.trim() || undefined),
  };
}

export function probeDs4Deploy(overrides?: Partial<Ds4DeployConfig>): Ds4DeployStatus {
  const config = resolveDs4DeployConfig(overrides);
  if (config.enabled === "off") {
    return {
      config,
      selectable: false,
      installed: false,
      reason: "ds4_disabled_by_deploy_config",
      remediation: [
        "Set KGM_DS4_ENABLED=on|auto (or workers.ds4.enabled) to serve DeepSeek V4 / GLM via ds4-server.",
        config.installHint,
      ],
    };
  }

  const attachRaw = process.env.KGM_DS4_ATTACH?.trim().toLowerCase();
  const attachForced = attachRaw === "1" || attachRaw === "true" || attachRaw === "on" || attachRaw === "yes";
  const attachBase =
    process.env.KGM_DS4_BASE_URL?.trim() || process.env.DS4_BASE_URL?.trim() || undefined;
  if (attachForced && attachBase) {
    return {
      config,
      selectable: true,
      installed: true,
      reason: "ds4_attach_base_url",
      remediation: [
        "Attached via KGM_DS4_ATTACH=1 + BASE_URL (OpenAI-compat). Omit ATTACH (or set 0) to force local spawn.",
      ],
    };
  }

  const resolved = resolveCommandPath(config.command);
  if (!resolved) {
    return {
      config,
      selectable: false,
      installed: false,
      reason: "ds4_binary_not_found",
      remediation: [
        `Binary not found for command "${config.command}".`,
        "Install ds4-server and ensure it is on PATH, or set KGM_DS4_SERVER_CMD=/abs/path/to/ds4-server.",
        config.installHint,
        config.enabled === "on"
          ? "KGM_DS4_ENABLED=on requires a working install before starting ds4 runtimes."
          : "With enabled=auto, llama.cpp/vLLM/SGLang remain available; ds4 will be skipped in auto resolve.",
      ],
    };
  }

  const version = probeVersion(resolved);
  return {
    config,
    selectable: true,
    installed: true,
    resolvedCommand: resolved,
    version,
    reason: "ds4_ready",
    remediation: [],
  };
}

export function assertDs4Callable(overrides?: Partial<Ds4DeployConfig>): Ds4DeployStatus {
  const status = probeDs4Deploy(overrides);
  if (status.selectable && status.installed) {
    return status;
  }
  const detail = [status.reason, ...status.remediation].join(" | ");
  throw new Error(`ds4_unavailable:${detail}`);
}

export function isDs4Selectable(overrides?: Partial<Ds4DeployConfig>): boolean {
  const status = probeDs4Deploy(overrides);
  return status.selectable && status.installed;
}

function resolveCommandPath(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    try {
      accessSync(trimmed, fsConstants.X_OK);
      return path.resolve(trimmed);
    } catch {
      return undefined;
    }
  }
  const which = spawnSync("which", [trimmed], { encoding: "utf8" });
  if (which.status === 0) {
    const found = which.stdout.trim().split("\n")[0]?.trim();
    return found || undefined;
  }
  return undefined;
}

function probeVersion(resolvedCommand: string): string | undefined {
  const result = spawnSync(resolvedCommand, ["--version"], { encoding: "utf8", timeout: 3000 });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (!text) return undefined;
  return text.split("\n")[0]?.trim().slice(0, 160);
}
