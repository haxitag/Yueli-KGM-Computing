import type { ConfigStore } from "../core/configStore.js";
import { resolveFrontStationConfig } from "../frontstation/types.js";
import { resolveWorkerAutoRestartConfig } from "../models/workerRestartPolicy.js";
import { circuitBreakerGroup } from "../observability/circuitBreaker.js";
import { parseStreamIdleMs } from "../openai/sseStreamNormalize.js";
import { resolveDs4ServingHints } from "../runtime/ds4SessionKv.js";
import { probeTokenSpeedDeploy } from "../runtime/tokenspeedDeploy.js";
import { getAgenticMetricsSnapshot } from "../agentic/metrics.js";
import { resolveCorsPolicy } from "./corsPolicy.js";
import { createHttpAccessConfigFromEnv } from "./httpAccess.js";

type ProcessSetting<T> = {
  value: T;
  source: "env" | "default";
  restartRequired: true;
};

function setting<T>(envKey: string, value: T): ProcessSetting<T> {
  return {
    value,
    source: process.env[envKey] == null ? "default" : "env",
    restartRequired: true,
  };
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function csvNumbers(raw: string | undefined, fallback: number[]): number[] {
  if (!raw?.trim()) return fallback;
  const parsed = raw
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter(Number.isFinite);
  return parsed.length > 0 ? parsed : fallback;
}

/** Non-secret effective process/config status for Playground operator panels. */
export function buildControlPlaneStatus(configStore: ConfigStore) {
  const access = createHttpAccessConfigFromEnv();
  const cors = resolveCorsPolicy();
  const frontstation = resolveFrontStationConfig();
  const workerRestart = resolveWorkerAutoRestartConfig();
  const ds4 = resolveDs4ServingHints();
  const config = configStore.get();

  return {
    generatedAt: new Date().toISOString(),
    note: "env/default 项在进程启动时读取；修改环境变量后需重启。ConfigStore 项由 /v1/kgm/config 管理。",
    security: {
      mode: setting("KGM_HTTP_SECURITY_MODE", access.securityMode),
      masterKeyConfigured: Boolean(access.apiKey),
      rateLimit: setting("KGM_HTTP_RATE_LIMIT_MAX", access.rateLimit),
      trustProxy: setting("KGM_HTTP_TRUST_PROXY", access.trustProxy),
      exemptPathPrefixes: setting("KGM_HTTP_AUTH_EXEMPT", access.exemptPathPrefixes),
    },
    frontstation: {
      mode: setting("KGM_FRONTSTATION_MODE", frontstation.mode),
      intentMode: setting("KGM_FRONTSTATION_INTENT_MODE", frontstation.intentMode),
      rerankMode: setting("KGM_FRONTSTATION_RERANK_MODE", frontstation.rerankMode),
      summaryMode: setting("KGM_FRONTSTATION_SUMMARY_MODE", frontstation.summaryMode),
      preferOnnx: setting("KGM_FRONTSTATION_PREFER_ONNX", frontstation.preferOnnx),
      onnxModelId: setting("KGM_FRONTSTATION_ONNX_MODEL", frontstation.onnxModelId),
      onnxDevice: setting("KGM_FRONTSTATION_ONNX_DEVICE", frontstation.onnxDevice ?? null),
      intentHttpConfigured: Boolean(frontstation.intentHttpUrl),
      rerankHttpConfigured: Boolean(frontstation.rerankHttpUrl),
      summaryHttpConfigured: Boolean(frontstation.summaryHttpUrl),
      timeoutMs: setting("KGM_FRONTSTATION_TIMEOUT_MS", frontstation.timeoutMs),
    },
    resilience: {
      autoRoutingWeights: {
        value: config.autoRouting.weights,
        source: "configStore" as const,
        restartRequired: false,
      },
      circuitBreaker: {
        timeoutMs: setting(
          "KGM_CIRCUIT_BREAKER_TIMEOUT_MS",
          intEnv("KGM_CIRCUIT_BREAKER_TIMEOUT_MS", 10_000),
        ),
        errorThreshold: setting(
          "KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD",
          intEnv("KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD", 5),
        ),
        resetTimeoutMs: setting(
          "KGM_CIRCUIT_BREAKER_RESET_TIMEOUT_MS",
          intEnv("KGM_CIRCUIT_BREAKER_RESET_TIMEOUT_MS", 60_000),
        ),
        /** Live opossum states keyed by upstream host bucket (e.g. llm:api.openai.com). */
        liveStates: circuitBreakerGroup.getAllStates(),
      },
      streamIdleMs: setting("KGM_STREAM_IDLE_MS", parseStreamIdleMs()),
      agentic: {
        value: getAgenticMetricsSnapshot(),
        source: "runtime" as const,
        restartRequired: false,
        note: "in-process agentic counters (not Prometheus SLA); see docs/worker-provider-session-tools-slo-eval-audit.md",
      },
    },
    workers: {
      gates: {
        value: config.workers,
        source: "configStore" as const,
        restartRequired: false,
      },
      autoRestart: {
        value: workerRestart,
        source:
          process.env.KGM_WORKER_AUTO_RESTART == null &&
          process.env.KGM_WORKER_RESTART_MAX_ATTEMPTS == null &&
          process.env.KGM_WORKER_RESTART_BASE_MS == null &&
          process.env.KGM_WORKER_RESTART_MAX_MS == null
            ? ("default" as const)
            : ("env" as const),
        restartRequired: true as const,
      },
      tokenspeed: {
        value: probeTokenSpeedDeploy({
          enabled: config.workers.tokenspeed?.enabled,
          command: config.workers.tokenspeed?.command,
          installHint: config.workers.tokenspeed?.installHint,
          baseUrl: config.workers.tokenspeed?.baseUrl,
          port: config.workers.tokenspeed?.port,
        }),
        source: "env+configStore" as const,
        restartRequired: true as const,
        note: "Optional OpenAI-compat worker; default off — not KGM intent/skills layer",
      },
      ds4: {
        value: {
          ...ds4,
          connection: {
            enabled: config.workers.ds4.enabled,
            command: config.workers.ds4.command,
            chdir: config.workers.ds4.chdir ?? process.env.KGM_DS4_CHDIR ?? null,
            port: intEnv("KGM_DS4_PORT", 8090),
            baseUrl:
              process.env.DS4_BASE_URL?.trim() ||
              process.env.KGM_DS4_BASE_URL?.trim() ||
              `http://127.0.0.1:${intEnv("KGM_DS4_PORT", 8090)}/v1`,
            envCommand: process.env.KGM_DS4_SERVER_CMD ?? null,
            installHintConfigured: Boolean(
              config.workers.ds4.installHint || process.env.KGM_DS4_INSTALL_HINT,
            ),
          },
        },
        source:
          process.env.KGM_DS4_KV_DISK_DIR == null &&
          process.env.KGM_DS4_SSD_STREAMING == null &&
          process.env.KGM_DS4_BATCHED_SESSION == null &&
          process.env.KGM_DS4_PORT == null &&
          process.env.KGM_DS4_BASE_URL == null &&
          process.env.DS4_BASE_URL == null &&
          process.env.KGM_DS4_CTX == null
            ? ("default" as const)
            : ("env" as const),
        restartRequired: true as const,
      },
    },
    platform: {
      native: {
        servingBackend: setting(
          "KGM_NATIVE_SERVING_BACKEND",
          process.env.KGM_NATIVE_SERVING_BACKEND ?? "auto",
        ),
        gpuSimulated: setting("KGM_NATIVE_GPU_SIMULATED", boolEnv("KGM_NATIVE_GPU_SIMULATED")),
        nativeCoreConfigured: Boolean(
          process.env.KGM_NATIVE_CORE_LIBRARY || process.env.KGM_NATIVE_CORE_ADDON,
        ),
        promptCacheSize: setting(
          "KGM_NATIVE_PROMPT_CACHE_SIZE",
          intEnv("KGM_NATIVE_PROMPT_CACHE_SIZE", 8),
        ),
        sessionCacheSize: setting(
          "KGM_NATIVE_SESSION_CACHE_SIZE",
          intEnv("KGM_NATIVE_SESSION_CACHE_SIZE", 64),
        ),
      },
      cors: {
        value: cors,
        source:
          process.env.KGM_CORS_ORIGINS == null ? ("default" as const) : ("env" as const),
        restartRequired: true as const,
      },
      discovery: {
        enabled: setting(
          "KGM_DISCOVERY_ENABLED",
          process.env.KGM_DISCOVERY_ENABLED === "1",
        ),
        ports: setting(
          "KGM_DISCOVERY_PORTS",
          csvNumbers(process.env.KGM_DISCOVERY_PORTS, [11434, 8002, 8080, 1234, 8000, 5000]),
        ),
        timeoutMs: setting(
          "KGM_DISCOVERY_TIMEOUT_MS",
          intEnv("KGM_DISCOVERY_TIMEOUT_MS", 2_000),
        ),
      },
    },
  };
}
