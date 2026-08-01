/**
 * Optional TokenSpeed OpenAI-compat worker gate (via_worker).
 * Default enabled=off so default builds/CI are not polluted.
 * Production: prefer attach (BASE_URL / KGM_TOKENSPEED_ATTACH) like Ollama; spawn only when needed.
 * Kernels stay in TokenSpeed — never merged into KGM native-gpu.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type TokenSpeedEnableMode = "on" | "off" | "auto";

export type TokenSpeedDeployConfig = {
  /** on = must use when selected; off = never (default); auto = enable only if binary/BASE_URL found */
  enabled: TokenSpeedEnableMode;
  command: string;
  installHint: string;
  baseUrl?: string;
  port: number;
  /** Prefer attach over spawn (like KGM_OLLAMA_AUTOSTART inverted) */
  attach?: boolean;
  toolCallParser?: string;
  reasoningParser?: string;
  enablePrefixCaching?: boolean;
  extraArgs?: string[];
};

export type TokenSpeedDeployStatus = {
  config: TokenSpeedDeployConfig;
  selectable: boolean;
  installed: boolean;
  resolvedCommand?: string;
  version?: string;
  reason: string;
  remediation: string[];
  attachPreferred: boolean;
};

const DEFAULT_INSTALL_HINT =
  "Install TokenSpeed (https://github.com/lightseekorg/tokenspeed), " +
  "set KGM_TOKENSPEED_SERVER_CMD or prefer KGM_TOKENSPEED_BASE_URL attach (Ollama-style). " +
  "Production: KGM_TOKENSPEED_ENABLED=auto + BASE_URL. Default remains off for CI. " +
  "TokenSpeed is an optional inference backend — not KGM intent/skills.";

export function parseTokenSpeedEnableMode(raw: string | undefined): TokenSpeedEnableMode {
  const value = String(raw ?? "off").trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on" || value === "enabled" || value === "yes") {
    return "on";
  }
  if (value === "auto") {
    return "auto";
  }
  return "off";
}

export function shouldAttachTokenSpeed(overrides?: Partial<TokenSpeedDeployConfig>): boolean {
  if (overrides?.baseUrl?.trim()) return true;
  if (overrides?.attach === true) return true;
  if (overrides?.attach === false) return false;
  const raw = process.env.KGM_TOKENSPEED_ATTACH?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (process.env.KGM_TOKENSPEED_BASE_URL?.trim()) return true;
  return false;
}

export function resolveTokenSpeedDeployConfig(
  overrides?: Partial<TokenSpeedDeployConfig>,
): TokenSpeedDeployConfig {
  const envEnabled = process.env.KGM_TOKENSPEED_ENABLED;
  const envCmd = process.env.KGM_TOKENSPEED_SERVER_CMD;
  const envHint = process.env.KGM_TOKENSPEED_INSTALL_HINT;
  const envBase = process.env.KGM_TOKENSPEED_BASE_URL;
  const envPort = process.env.KGM_TOKENSPEED_PORT;
  const parsedPort = Number.parseInt(envPort ?? "", 10);
  const envToolParser = process.env.KGM_TOKENSPEED_TOOL_CALL_PARSER;
  const envReasoningParser = process.env.KGM_TOKENSPEED_REASONING_PARSER;
  const envPrefix = process.env.KGM_TOKENSPEED_PREFIX_CACHING;
  const envExtra = process.env.KGM_TOKENSPEED_EXTRA_ARGS;
  const extraFromEnv = envExtra
    ?.split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled:
      overrides?.enabled !== undefined
        ? overrides.enabled
        : envEnabled !== undefined && String(envEnabled).trim() !== ""
          ? parseTokenSpeedEnableMode(envEnabled)
          : "off",
    command: overrides?.command?.trim() || envCmd?.trim() || "tokenspeed",
    installHint: overrides?.installHint?.trim() || envHint?.trim() || DEFAULT_INSTALL_HINT,
    baseUrl: overrides?.baseUrl?.trim() || envBase?.trim() || undefined,
    port:
      overrides?.port ??
      (Number.isFinite(parsedPort) ? parsedPort : 8095),
    attach: overrides?.attach ?? shouldAttachTokenSpeed(overrides),
    toolCallParser: overrides?.toolCallParser?.trim() || envToolParser?.trim() || undefined,
    reasoningParser: overrides?.reasoningParser?.trim() || envReasoningParser?.trim() || undefined,
    enablePrefixCaching:
      overrides?.enablePrefixCaching ??
      (envPrefix == null || envPrefix.trim() === ""
        ? true
        : ["1", "true", "yes", "on"].includes(envPrefix.trim().toLowerCase())),
    extraArgs: overrides?.extraArgs?.length ? overrides.extraArgs : extraFromEnv,
  };
}

export function probeTokenSpeedDeploy(
  overrides?: Partial<TokenSpeedDeployConfig>,
): TokenSpeedDeployStatus {
  const config = resolveTokenSpeedDeployConfig(overrides);
  const attachPreferred = Boolean(config.baseUrl) || Boolean(config.attach);

  if (config.enabled === "off") {
    return {
      config,
      selectable: false,
      installed: false,
      reason: "tokenspeed_disabled_by_deploy_config",
      attachPreferred,
      remediation: [
        "Production: set KGM_TOKENSPEED_ENABLED=auto|on and KGM_TOKENSPEED_BASE_URL (attach, Ollama-style).",
        "Or set KGM_TOKENSPEED_SERVER_CMD to spawn a local OpenAI-compat process.",
        config.installHint,
      ],
    };
  }

  if (config.baseUrl) {
    return {
      config,
      selectable: true,
      installed: true,
      reason: "tokenspeed_attach_base_url",
      attachPreferred: true,
      remediation: [],
      version: `baseUrl:${config.baseUrl}`,
    };
  }

  if (attachPreferred && !config.baseUrl) {
    return {
      config,
      selectable: false,
      installed: false,
      reason: "tokenspeed_attach_requires_base_url",
      attachPreferred: true,
      remediation: [
        "KGM_TOKENSPEED_ATTACH is set but KGM_TOKENSPEED_BASE_URL is missing.",
        "Set BASE_URL to an already-running TokenSpeed OpenAI-compat endpoint (e.g. http://127.0.0.1:8095/v1).",
      ],
    };
  }

  const resolved = resolveCommandPath(config.command);
  if (!resolved) {
    return {
      config,
      selectable: false,
      installed: false,
      reason: "tokenspeed_binary_not_found",
      attachPreferred,
      remediation: [
        `Binary not found for command "${config.command}".`,
        "Prefer attach: set KGM_TOKENSPEED_BASE_URL to a running OpenAI-compat server.",
        "Or install TokenSpeed and set KGM_TOKENSPEED_SERVER_CMD=/abs/path.",
        config.installHint,
        config.enabled === "on"
          ? "KGM_TOKENSPEED_ENABLED=on requires BASE_URL or a working binary."
          : "With enabled=auto, other workers remain available until TokenSpeed is installed or attached.",
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
    reason: "tokenspeed_ready",
    attachPreferred: false,
    remediation: [],
  };
}

export function assertTokenSpeedCallable(
  overrides?: Partial<TokenSpeedDeployConfig>,
): TokenSpeedDeployStatus {
  const status = probeTokenSpeedDeploy(overrides);
  if (status.selectable && status.installed) {
    return status;
  }
  const detail = [status.reason, ...status.remediation].join(" | ");
  throw new Error(`tokenspeed_unavailable:${detail}`);
}

export function isTokenSpeedSelectable(overrides?: Partial<TokenSpeedDeployConfig>): boolean {
  const status = probeTokenSpeedDeploy(overrides);
  return status.selectable && status.installed;
}

export type TokenSpeedServerArgParams = {
  host: string;
  port: number;
  modelPath?: string;
  toolCallParser?: string;
  reasoningParser?: string;
  enablePrefixCaching?: boolean;
  extraArgs?: string[];
};

/** Spawn recipe for optional local TokenSpeed OpenAI-compat server. */
export function buildTokenSpeedServerArgs(params: TokenSpeedServerArgParams): string[] {
  const args = ["--host", params.host, "--port", String(params.port)];
  if (params.modelPath) {
    args.push("--model", params.modelPath);
  }
  if (params.toolCallParser?.trim()) {
    args.push("--tool-call-parser", params.toolCallParser.trim());
  }
  if (params.reasoningParser?.trim()) {
    args.push("--reasoning-parser", params.reasoningParser.trim());
  }
  if (params.enablePrefixCaching === false) {
    args.push("--no-enable-prefix-caching");
  } else if (params.enablePrefixCaching === true) {
    args.push("--enable-prefix-caching");
  }
  if (params.extraArgs?.length) {
    args.push(...params.extraArgs);
  }
  return args;
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
