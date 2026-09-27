/**
 * Control-plane policy for ds4 long-session disk KV + SSD streaming + micro-batch.
 * KGM does not implement KV kernels — only configures/spawns ds4-server flags and exposes metrics labels.
 */

export type Ds4SessionKvPolicy = {
  enabled: boolean;
  diskDir?: string;
  diskSpaceMb: number;
  notes: string[];
};

export type Ds4ServingHints = {
  ssdStreaming: boolean;
  ssdStreamingCacheExperts?: string;
  batchedSession: number;
  ctxTokens: number;
  sessionKv: Ds4SessionKvPolicy;
  /** Labels for metrics / capabilities — real token interleaving stays inside ds4-server */
  microBatchLabel: "ds4_server_batched_session";
  tokenInterleaveOwner: "worker";
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return fallback;
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function resolveDs4SessionKvPolicy(env: NodeJS.ProcessEnv = process.env): Ds4SessionKvPolicy {
  const diskDir = (env.KGM_DS4_KV_DISK_DIR ?? "").trim() || undefined;
  const diskSpaceMb = Math.max(0, parseIntEnv(env.KGM_DS4_KV_DISK_SPACE_MB, 8192));
  const enabled = Boolean(diskDir) || parseBool(env.KGM_DS4_KV_DISK_ENABLED, false);
  return {
    enabled: enabled && Boolean(diskDir),
    diskDir,
    diskSpaceMb,
    notes: [
      "Disk KV is owned by ds4-server (--kv-disk-dir / --kv-disk-space-mb), not KGM native kernels.",
      "Set KGM_DS4_KV_DISK_DIR to enable long-session checkpointing for Agent/coding workloads.",
    ],
  };
}

export function resolveDs4ServingHints(env: NodeJS.ProcessEnv = process.env): Ds4ServingHints {
  const ssdStreaming = parseBool(env.KGM_DS4_SSD_STREAMING, false);
  const cache = (env.KGM_DS4_SSD_STREAMING_CACHE_EXPERTS ?? "").trim() || undefined;
  return {
    ssdStreaming,
    ssdStreamingCacheExperts: cache,
    batchedSession: Math.max(1, parseIntEnv(env.KGM_DS4_BATCHED_SESSION, 8)),
    ctxTokens: Math.max(1024, parseIntEnv(env.KGM_DS4_CTX, 32768)),
    sessionKv: resolveDs4SessionKvPolicy(env),
    microBatchLabel: "ds4_server_batched_session",
    tokenInterleaveOwner: "worker",
  };
}

/** Spawn CLI flags for ds4-server (OpenAI-compatible). */
export function buildDs4ServerArgs(params: {
  modelPath: string;
  host: string;
  port: number;
  hints?: Ds4ServingHints;
}): string[] {
  const hints = params.hints ?? resolveDs4ServingHints();
  const args = [
    "--model",
    params.modelPath,
    "--host",
    params.host,
    "--port",
    String(params.port),
    "--ctx",
    String(hints.ctxTokens),
    "--batched-session",
    String(hints.batchedSession),
  ];
  if (hints.ssdStreaming) {
    args.push("--ssd-streaming");
    if (hints.ssdStreamingCacheExperts) {
      args.push("--ssd-streaming-cache-experts", hints.ssdStreamingCacheExperts);
    }
  }
  if (hints.sessionKv.enabled && hints.sessionKv.diskDir) {
    args.push("--kv-disk-dir", hints.sessionKv.diskDir);
    if (hints.sessionKv.diskSpaceMb > 0) {
      args.push("--kv-disk-space-mb", String(hints.sessionKv.diskSpaceMb));
    }
  }
  const chdir = (process.env.KGM_DS4_CHDIR ?? "").trim();
  if (chdir) {
    args.push("--chdir", chdir);
  }
  return args;
}

export type Ds4QualityGate = {
  family: string;
  preferredQuantTiers: string[];
  continuationGolden: {
    enabled: boolean;
    note: string;
  };
  imatrixRecommended: boolean;
  notes: string[];
};

/** P1 quality gates surfaced in capabilities (operator guidance). */
export function getDs4QualityGates(): Ds4QualityGate[] {
  return [
    {
      family: "deepseek-v4-flash",
      preferredQuantTiers: ["q2-imatrix", "iq2-imatrix", "q4-imatrix"],
      continuationGolden: {
        enabled: true,
        note: "Prefer antirez imatrix GGUFs scored against official DeepSeek V4 Flash continuations (ds4 gguf-tools/quality-testing).",
      },
      imatrixRecommended: true,
      notes: [
        "Asymmetric routed-MoE quant (experts IQ2/Q2, shared/projections higher precision).",
        "Do not load arbitrary GGUF into ds4 — layout/metadata are specialized.",
      ],
    },
    {
      family: "deepseek-v4-pro",
      preferredQuantTiers: ["q2-imatrix", "q4-imatrix"],
      continuationGolden: {
        enabled: true,
        note: "PRO quants need high-RAM or distributed/SSD streaming; validate with ds4 QA matrix.",
      },
      imatrixRecommended: true,
      notes: ["Often requires SSD streaming or multi-host pipeline parallelism."],
    },
    {
      family: "glm-5.2",
      preferredQuantTiers: ["iq2-imatrix", "q2", "q4"],
      continuationGolden: {
        enabled: true,
        note: "Use GLM GGUFs tested by ds4 branch; unsupported quant layouts should be rejected before eval.",
      },
      imatrixRecommended: true,
      notes: ["Routed expert gate/up/down dtype mixes are ds4-specific."],
    },
  ];
}
