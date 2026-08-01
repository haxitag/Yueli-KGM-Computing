/**
 * Optional llama.cpp deployment gate.
 * Product decision: operators come from llama.cpp — but installs are optional per host.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type LlamaCppEnableMode = "on" | "off" | "auto";

export type LlamaCppDeployConfig = {
  /** on = must use when selected; off = never; auto = enable only if binary found */
  enabled: LlamaCppEnableMode;
  /** Absolute or PATH command for llama-server */
  command: string;
  /** Optional install docs URL / hint for operators */
  installHint: string;
};

export type LlamaCppDeployStatus = {
  config: LlamaCppDeployConfig;
  /** Soft gate: whether KGM may attempt spawn */
  selectable: boolean;
  /** Hard gate: binary resolved and executable */
  installed: boolean;
  resolvedCommand?: string;
  version?: string;
  reason: string;
  remediation: string[];
};

const DEFAULT_INSTALL_HINT =
  "Install llama.cpp llama-server (https://github.com/ggerganov/llama.cpp), " +
  "set KGM_LLAMA_SERVER_CMD to the binary path, and KGM_LLAMA_CPP_ENABLED=on|auto.";

export function parseLlamaCppEnableMode(raw: string | undefined): LlamaCppEnableMode {
  const value = String(raw ?? "auto").trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off" || value === "disabled" || value === "no") {
    return "off";
  }
  if (value === "1" || value === "true" || value === "on" || value === "enabled" || value === "yes") {
    return "on";
  }
  return "auto";
}

export function resolveLlamaCppDeployConfig(overrides?: Partial<LlamaCppDeployConfig>): LlamaCppDeployConfig {
  const envEnabled = process.env.KGM_LLAMA_CPP_ENABLED;
  const envCmd = process.env.KGM_LLAMA_SERVER_CMD;
  const envHint = process.env.KGM_LLAMA_CPP_INSTALL_HINT;
  // ConfigStore / UI overrides win over env so Playground 门闩可即时生效
  return {
    enabled:
      overrides?.enabled !== undefined
        ? overrides.enabled
        : envEnabled !== undefined && String(envEnabled).trim() !== ""
          ? parseLlamaCppEnableMode(envEnabled)
          : "auto",
    command: (overrides?.command?.trim() || envCmd?.trim() || "llama-server"),
    installHint: (overrides?.installHint?.trim() || envHint?.trim() || DEFAULT_INSTALL_HINT),
  };
}

export function probeLlamaCppDeploy(overrides?: Partial<LlamaCppDeployConfig>): LlamaCppDeployStatus {
  const config = resolveLlamaCppDeployConfig(overrides);
  if (config.enabled === "off") {
    return {
      config,
      selectable: false,
      installed: false,
      reason: "llama_cpp_disabled_by_deploy_config",
      remediation: [
        "Set KGM_LLAMA_CPP_ENABLED=on|auto (or workers.llamaCpp.enabled) if this host should run GGUF via llama.cpp.",
        config.installHint,
      ],
    };
  }

  const attachRaw = process.env.KGM_LLAMA_CPP_ATTACH?.trim().toLowerCase();
  const attachForced = attachRaw === "1" || attachRaw === "true" || attachRaw === "on" || attachRaw === "yes";
  const attachBase =
    process.env.KGM_LLAMA_CPP_BASE_URL?.trim() || process.env.LLAMA_CPP_BASE_URL?.trim() || undefined;
  if (attachForced && attachBase) {
    return {
      config,
      selectable: true,
      installed: true,
      reason: "llama_cpp_attach_base_url",
      remediation: [
        "Attached via KGM_LLAMA_CPP_ATTACH=1 + BASE_URL. Omit ATTACH (or set 0) to force local spawn.",
      ],
    };
  }

  const resolved = resolveCommandPath(config.command);
  if (!resolved) {
    const reason = "llama_cpp_binary_not_found";
    return {
      config,
      selectable: config.enabled === "on" ? false : false,
      installed: false,
      reason,
      remediation: [
        `Binary not found for command "${config.command}".`,
        "Install llama-server and ensure it is on PATH, or set KGM_LLAMA_SERVER_CMD=/abs/path/to/llama-server.",
        config.installHint,
        config.enabled === "on"
          ? "KGM_LLAMA_CPP_ENABLED=on requires a working install before starting llama.cpp runtimes."
          : "With enabled=auto, other workers (vLLM/SGLang/openai-compatible) remain available; llama.cpp will be skipped in auto resolve.",
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
    reason: "llama_cpp_ready",
    remediation: [],
  };
}

/** Throw if llama.cpp cannot be used on this host. */
export function assertLlamaCppCallable(overrides?: Partial<LlamaCppDeployConfig>): LlamaCppDeployStatus {
  const status = probeLlamaCppDeploy(overrides);
  if (status.selectable && status.installed) {
    return status;
  }
  const detail = [status.reason, ...status.remediation].join(" | ");
  throw new Error(`llama_cpp_unavailable:${detail}`);
}

export function isLlamaCppSelectable(overrides?: Partial<LlamaCppDeployConfig>): boolean {
  const status = probeLlamaCppDeploy(overrides);
  return status.selectable && status.installed;
}

function resolveCommandPath(command: string): string | undefined {
  if (!command) return undefined;
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, fsConstants.X_OK);
      return path.resolve(command);
    } catch {
      try {
        accessSync(command, fsConstants.F_OK);
        return path.resolve(command);
      } catch {
        return undefined;
      }
    }
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (which.status === 0) {
    const line = String(which.stdout ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return line || undefined;
  }
  return undefined;
}

function probeVersion(resolvedCommand: string): string | undefined {
  const result = spawnSync(resolvedCommand, ["--version"], {
    encoding: "utf8",
    timeout: 4000,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!text) return undefined;
  return text.split(/\r?\n/)[0]?.slice(0, 200);
}
