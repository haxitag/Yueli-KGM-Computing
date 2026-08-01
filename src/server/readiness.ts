/**
 * 进程就绪探针（/ready）——与 /health 存活探针分层。
 * - /health：进程还活着即可 200
 * - /ready：能否接流量（mock 生产红线、可选要求上游）
 */
export type ReadinessCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type ReadinessReport = {
  status: "ready" | "not_ready";
  timestamp: string;
  uptimeSeconds: number;
  checks: ReadinessCheck[];
};

export type ReadinessInput = {
  env?: NodeJS.ProcessEnv;
  now?: number;
  processStartedAtMs?: number;
  /** 是否已配置默认可路由上游（LLM baseUrl / auto-routing） */
  llmConfigured?: boolean;
  /** managed runtime：running / error 数量 */
  workers?: { running: number; error: number; degraded: number; total: number };
};

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  return ["1", "true", "yes", "on"].includes((env[key] ?? "").trim().toLowerCase());
}

/**
 * 评估就绪态。默认宽松：仅 production+mock 拦截；
 * `KGM_READY_REQUIRE_UPSTREAM=1` 时要求 llmConfigured 或有 running worker。
 */
export function evaluateReadiness(input: ReadinessInput = {}): ReadinessReport {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const started = input.processStartedAtMs ?? now - process.uptime() * 1000;
  const checks: ReadinessCheck[] = [];

  checks.push({
    name: "process",
    ok: true,
    detail: "alive",
  });

  const mockMode = envFlag(env, "KGM_MOCK_MODE");
  const isProd =
    (env.NODE_ENV ?? "").trim().toLowerCase() === "production" ||
    (env.KGM_HTTP_SECURITY_MODE ?? "").trim().toLowerCase() === "strict";
  const mockOk = !(isProd && mockMode);
  checks.push({
    name: "mock_mode",
    ok: mockOk,
    detail: mockMode
      ? isProd
        ? "KGM_MOCK_MODE active under production/strict"
        : "mock allowed in non-production"
      : "disabled",
  });

  const requireUpstream = envFlag(env, "KGM_READY_REQUIRE_UPSTREAM");
  const llmConfigured = Boolean(input.llmConfigured);
  const workers = input.workers ?? { running: 0, error: 0, degraded: 0, total: 0 };
  const hasServingCapability = llmConfigured || workers.running > 0;
  const upstreamOk = !requireUpstream || hasServingCapability;
  checks.push({
    name: "upstream",
    ok: upstreamOk,
    detail: requireUpstream
      ? hasServingCapability
        ? `llm=${llmConfigured}; workers.running=${workers.running}`
        : "KGM_READY_REQUIRE_UPSTREAM=1 but no llm/worker ready"
      : `optional; llm=${llmConfigured}; workers.running=${workers.running}`,
  });

  if (workers.total > 0) {
    checks.push({
      name: "managed_workers",
      ok: workers.error < workers.total || workers.running > 0,
      detail: `running=${workers.running} degraded=${workers.degraded} error=${workers.error} total=${workers.total}`,
    });
  }

  const status = checks.every((c) => c.ok) ? "ready" : "not_ready";
  return {
    status,
    timestamp: new Date(now).toISOString(),
    uptimeSeconds: Math.max(0, (now - started) / 1000),
    checks,
  };
}
