/**
 * Managed worker（vLLM / SGLang / llama.cpp 等 spawn 进程）崩溃自动重启策略。
 * 行业惯例：指数退避 + 上限；主动 stop 不重启。
 */

export type WorkerAutoRestartConfig = {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export function resolveWorkerAutoRestartConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerAutoRestartConfig {
  const raw = (env.KGM_WORKER_AUTO_RESTART ?? "1").trim().toLowerCase();
  const enabled = !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
  const maxAttempts = Math.max(0, parseIntEnv(env.KGM_WORKER_RESTART_MAX_ATTEMPTS, 5));
  const baseDelayMs = Math.max(100, parseIntEnv(env.KGM_WORKER_RESTART_BASE_MS, 1_000));
  const maxDelayMs = Math.max(baseDelayMs, parseIntEnv(env.KGM_WORKER_RESTART_MAX_MS, 60_000));
  return { enabled, maxAttempts, baseDelayMs, maxDelayMs };
}

export function workerRestartDelayMs(attempt: number, config: WorkerAutoRestartConfig): number {
  // attempt 从 1 开始；指数退避 + 少量抖动，避免惊群
  const exp = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(250, Math.floor(exp * 0.1)));
  return Math.min(config.maxDelayMs, exp + jitter);
}

/** 通过本进程 spawn 托管的 runtime 种类才自动重启（不重启 native / 外部 daemon） */
export function isSpawnManagedWorkerKind(kind: string): boolean {
  return (
    kind === "vllm" ||
    kind === "sglang" ||
    kind === "llama.cpp" ||
    kind === "ds4" ||
    kind === "mlx" ||
    kind === "tokenspeed"
  );
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}
