import fs from "node:fs";
import type { ConfigStore } from "../core/configStore.js";
import { probeLlamaCppDeploy } from "./llamaCppDeploy.js";
import { probeDs4Deploy } from "./ds4Deploy.js";
import { probeTokenSpeedDeploy } from "./tokenspeedDeploy.js";

export type RuntimeIssue = {
  code: string;
  severity: "error" | "warning" | "info";
  stage: string;
  message: string;
  affectedFeatures: string[];
  suggestedFix: string;
};

export type ConfigSource = "env" | "playground" | "discovery" | "config-file" | "default";

export function collectRuntimeDiagnostics(configStore: ConfigStore): { issues: RuntimeIssue[] } {
  const config = configStore.get();
  const issues: RuntimeIssue[] = [];
  if (config.embedding.provider === "openai" && !config.embedding.apiKey) {
    issues.push({
      code: "EMBEDDING_API_KEY_MISSING",
      severity: "error",
      stage: "context.memory_search",
      message: "Embedding provider is openai but apiKey is missing",
      affectedFeatures: ["memory_search", "rag", "context_builder"],
      suggestedFix: "Set KGM_EMBEDDING_BASE_URL/API_KEY/MODEL, or disable memory retrieval",
    });
  }
  if (config.llm.provider === "openai" && !config.llm.apiKey) {
    issues.push({
      code: "LLM_API_KEY_MISSING",
      severity: "error",
      stage: "inference.llm_provider",
      message: "LLM provider is openai but apiKey is missing",
      affectedFeatures: ["chat", "completions", "responses"],
      suggestedFix: "Set KGM_LLM_API_KEY, or configure KGM_LLM_BASE_URL/MODEL for a local OpenAI-compatible engine",
    });
  }
  if (process.env.NODE_ENV === "production" && process.env.KGM_MOCK_MODE === "1") {
    issues.push({
      code: "MOCK_MODE_ACTIVE_FOR_PROD",
      severity: "error",
      stage: "runtime.startup",
      message: "KGM_MOCK_MODE=1 is active in production",
      affectedFeatures: ["chat", "completions", "responses"],
      suggestedFix: "Unset KGM_MOCK_MODE or set KGM_MOCK_MODE=0 for production deployments",
    });
  }

  const llama = probeLlamaCppDeploy({
    enabled: config.workers.llamaCpp.enabled,
    command: config.workers.llamaCpp.command,
    installHint: config.workers.llamaCpp.installHint,
  });
  if (config.workers.llamaCpp.enabled === "on" && !llama.installed) {
    issues.push({
      code: "LLAMA_CPP_REQUIRED_BUT_MISSING",
      severity: "error",
      stage: "workers.llama_cpp",
      message: "llama.cpp is required by deploy config but llama-server was not found",
      affectedFeatures: ["runtime.llama.cpp", "gguf_local_ops"],
      suggestedFix: llama.remediation.join(" "),
    });
  } else if (config.workers.llamaCpp.enabled === "auto" && !llama.installed) {
    issues.push({
      code: "LLAMA_CPP_OPTIONAL_NOT_INSTALLED",
      severity: "warning",
      stage: "workers.llama_cpp",
      message: "llama.cpp binary not found; GGUF via llama.cpp worker is unavailable until installed",
      affectedFeatures: ["runtime.llama.cpp", "gguf_local_ops"],
      suggestedFix: llama.remediation.join(" "),
    });
  } else if (config.workers.llamaCpp.enabled === "off") {
    issues.push({
      code: "LLAMA_CPP_DISABLED",
      severity: "info",
      stage: "workers.llama_cpp",
      message: "llama.cpp worker is disabled by deploy config",
      affectedFeatures: ["runtime.llama.cpp"],
      suggestedFix: "Set workers.llamaCpp.enabled=auto|on or KGM_LLAMA_CPP_ENABLED=auto|on to allow local GGUF operators",
    });
  }

  const ds4 = probeDs4Deploy({
    enabled: config.workers.ds4.enabled,
    command: config.workers.ds4.command,
    installHint: config.workers.ds4.installHint,
    chdir: config.workers.ds4.chdir,
  });
  if (config.workers.ds4.enabled === "on" && !ds4.installed) {
    issues.push({
      code: "DS4_REQUIRED_BUT_MISSING",
      severity: "error",
      stage: "workers.ds4",
      message: "ds4 is required by deploy config but ds4-server was not found",
      affectedFeatures: ["runtime.ds4", "deepseek_v4_glm_local"],
      suggestedFix: ds4.remediation.join(" "),
    });
  } else if (config.workers.ds4.enabled === "auto" && !ds4.installed) {
    issues.push({
      code: "DS4_OPTIONAL_NOT_INSTALLED",
      severity: "warning",
      stage: "workers.ds4",
      message: "ds4-server binary not found; DeepSeek V4 / GLM specialized GGUF via ds4 is unavailable until installed",
      affectedFeatures: ["runtime.ds4", "deepseek_v4_glm_local"],
      suggestedFix: ds4.remediation.join(" "),
    });
  } else if (config.workers.ds4.enabled === "off") {
    issues.push({
      code: "DS4_DISABLED",
      severity: "info",
      stage: "workers.ds4",
      message: "ds4 worker is disabled by deploy config",
      affectedFeatures: ["runtime.ds4"],
      suggestedFix: "Set workers.ds4.enabled=auto|on or KGM_DS4_ENABLED=auto|on for DeepSeek V4 / GLM specialized local throughput",
    });
  }

  const tokenspeed = probeTokenSpeedDeploy({
    enabled: config.workers.tokenspeed?.enabled,
    command: config.workers.tokenspeed?.command,
    installHint: config.workers.tokenspeed?.installHint,
    baseUrl: config.workers.tokenspeed?.baseUrl,
    port: config.workers.tokenspeed?.port,
  });
  if (config.workers.tokenspeed?.enabled === "on" && !tokenspeed.installed) {
    issues.push({
      code: "TOKENSPEED_REQUIRED_BUT_MISSING",
      severity: "error",
      stage: "workers.tokenspeed",
      message: "TokenSpeed is required by deploy config but binary/BASE_URL was not found",
      affectedFeatures: ["runtime.tokenspeed"],
      suggestedFix: tokenspeed.remediation.join(" "),
    });
  } else if (config.workers.tokenspeed?.enabled === "auto" && !tokenspeed.installed) {
    issues.push({
      code: "TOKENSPEED_OPTIONAL_NOT_INSTALLED",
      severity: "info",
      stage: "workers.tokenspeed",
      message: "TokenSpeed optional worker not installed; default builds remain unaffected",
      affectedFeatures: ["runtime.tokenspeed"],
      suggestedFix: tokenspeed.remediation.join(" "),
    });
  } else if (config.workers.tokenspeed?.enabled === "off" || config.workers.tokenspeed?.enabled == null) {
    issues.push({
      code: "TOKENSPEED_DISABLED",
      severity: "info",
      stage: "workers.tokenspeed",
      message: "TokenSpeed worker is disabled (default) — optional OpenAI-compat backend, not KGM intent/skills",
      affectedFeatures: ["runtime.tokenspeed"],
      suggestedFix: "Set KGM_TOKENSPEED_ENABLED=on|auto only when intentionally using TokenSpeed",
    });
  }

  return { issues };
}

export function inferConfigSource(kind: "llm" | "embedding", discoveryMatched = false): ConfigSource {
  const prefix = kind === "llm" ? "KGM_LLM_" : "KGM_EMBEDDING_";
  if (Object.keys(process.env).some((key) => key.startsWith(prefix))) {
    return "env";
  }
  if (discoveryMatched) {
    return "discovery";
  }
  const configPath = process.env.KGM_CONFIG_PATH ?? "data/kgm.config.json";
  if (configPath && fs.existsSync(configPath)) {
    return "config-file";
  }
  return "default";
}
