import { joinUrl } from "../utils/url.js";
import type { YueliAiGatewayConfig } from "../core/configStore.js";

/** KGM 对外暴露的 YueliAI v1 路径前缀（短路径，供 L2 网关使用） */
export const YUELIAI_V1_PREFIX = "/yueliai/v1";

/**
 * 与阅粒 backend 一致的完整路径前缀（`baseUrl=https://host/api` + `/yueliai/v1/*`）。
 * 见生产日志：`GET /api/yueliai/v1/status` 等。
 */
export const YUELIAI_V1_API_PREFIX = "/api/yueliai/v1";

/** KGM 本地可挂载的全部 YueliAI v1 前缀 */
export const YUELIAI_V1_MOUNT_PREFIXES = [YUELIAI_V1_PREFIX, YUELIAI_V1_API_PREFIX] as const;

export type YueliAiConfig = {
  /** 是否已配置上游（需 host + apiKey） */
  enabled: boolean;
  host: string;
  apiKey: string;
  /**
   * 插入在 host 与 `/yueliai/v1` 之间的路径段。
   * 生产环境当前 API 在 `https://www.yueli.com/api/yueliai/v1/*`；
   * 若网关已改为根路径 `/yueliai/v1/*`，设为空字符串。
   */
  upstreamPrefix: string;
  timeoutMs: number;
};

function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\/$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/**
 * 构造上游完整 URL。
 * 默认：`{YUELIAI_HOST}{YUELIAI_UPSTREAM_PREFIX}/yueliai/v1{subpath}`
 * 例：`https://www.yueli.com` + `/api` + `/yueliai/v1/status`
 */
export function buildYueliAiUpstreamUrl(config: Pick<YueliAiConfig, "host" | "upstreamPrefix">, subpath: string): string {
  const suffix = subpath.startsWith("/") ? subpath : `/${subpath}`;
  const prefix = config.upstreamPrefix.trim();
  const withPrefix = prefix ? joinUrl(normalizeHost(config.host), prefix.replace(/\/$/, "")) : normalizeHost(config.host);
  return joinUrl(withPrefix, `${YUELIAI_V1_PREFIX}${suffix}`);
}

export function loadYueliAiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YueliAiConfig {
  const host = env.YUELIAI_HOST?.trim() || "https://www.yueli.com";
  const apiKey = env.YUELIAI_API_KEY?.trim() || "";
  const upstreamPrefix =
    env.YUELIAI_UPSTREAM_PREFIX !== undefined ? env.YUELIAI_UPSTREAM_PREFIX.trim() : "/api";
  const timeoutRaw = env.YUELIAI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 120_000;

  return {
    enabled: Boolean(apiKey),
    host,
    apiKey,
    upstreamPrefix,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
  };
}

/**
 * 合并 KgmConfig 持久化与进程环境变量（环境变量优先）。
 * Playground 写入 `configStore.yueliai` 后无需重启即可生效（每次请求重新 resolve）。
 */
export function resolveYueliAiConfig(params?: {
  file?: YueliAiGatewayConfig;
  env?: NodeJS.ProcessEnv;
}): YueliAiConfig {
  const env = params?.env ?? process.env;
  const fromEnv = loadYueliAiConfigFromEnv(env);
  const file = params?.file;

  const host = env.YUELIAI_HOST?.trim() || file?.host?.trim() || fromEnv.host;
  const apiKey = env.YUELIAI_API_KEY?.trim() || file?.apiKey?.trim() || "";
  const upstreamPrefix =
    env.YUELIAI_UPSTREAM_PREFIX !== undefined
      ? env.YUELIAI_UPSTREAM_PREFIX.trim()
      : file?.upstreamPrefix !== undefined
        ? file.upstreamPrefix
        : fromEnv.upstreamPrefix;
  const timeoutMs =
    env.YUELIAI_TIMEOUT_MS?.trim()
      ? Number(env.YUELIAI_TIMEOUT_MS)
      : file?.timeoutMs && file.timeoutMs > 0
        ? file.timeoutMs
        : fromEnv.timeoutMs;

  const fileEnabled = file?.enabled !== false;
  return {
    enabled: fileEnabled && Boolean(apiKey),
    host,
    apiKey,
    upstreamPrefix,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
  };
}
