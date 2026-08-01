import { protectedFetch } from "../observability/circuitBreaker.js";
import { LlmProviderApiError } from "../llm/providerApiError.js";

export type HttpOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 是否使用连接池优化（保留字段，当前走全局 fetch/熔断） */
  useConnectionPool?: boolean;
  /** 熔断桶名；默认按 URL host */
  circuitName?: string;
  /** Provider label for LlmProviderApiError */
  provider?: string;
};

function stringifyUpstream(json: unknown, text: string, status: number): string {
  if (json && typeof json === "object") {
    const err = (json as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) return err.trim().slice(0, 500);
    if (err && typeof err === "object" && typeof (err as { message?: string }).message === "string") {
      return String((err as { message: string }).message).slice(0, 500);
    }
    if (typeof (json as { message?: string }).message === "string") {
      return String((json as { message: string }).message).slice(0, 500);
    }
  }
  if (typeof text === "string" && text.trim()) return text.trim().slice(0, 500);
  return `Upstream failed with HTTP ${status}`;
}

function throwUpstreamHttpError(
  provider: string,
  status: number,
  text: string,
): never {
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* keep text */
  }
  const upstreamCode =
    json && typeof json === "object" && "error" in json
      ? String(
          ((json as { error?: { code?: string; type?: string } }).error)?.code ??
            ((json as { error?: { type?: string } }).error)?.type ??
            "",
        ) || undefined
      : undefined;
  throw new LlmProviderApiError(provider, stringifyUpstream(json, text, status), {
    httpStatus: status,
    upstreamCode,
  });
}

/**
 * 优化的 HTTP POST：上游经 opossum 熔断；超时用 AbortController。
 * Non-2xx → LlmProviderApiError（含 httpStatus，供宿主 KgmError.details.upstreamStatus）。
 */
export async function postJson(url: string, body: unknown, options: HttpOptions = {}): Promise<unknown> {
  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timeout = options.timeoutMs
    ? setTimeout(() => controller?.abort(), options.timeoutMs)
    : undefined;

  try {
    const response = await protectedFetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
        body: JSON.stringify(body),
        signal: controller?.signal,
      },
      { name: options.circuitName, enableBreakerTimeout: false },
    );

    if (!response.ok) {
      throwUpstreamHttpError(options.provider ?? "llm", response.status, await response.text());
    }

    return response.json();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function getJson(url: string, options: HttpOptions = {}): Promise<unknown> {
  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timeout = options.timeoutMs
    ? setTimeout(() => controller?.abort(), options.timeoutMs)
    : undefined;

  try {
    const response = await protectedFetch(
      url,
      {
        method: "GET",
        headers: { ...(options.headers ?? {}) },
        signal: controller?.signal,
      },
      { name: options.circuitName, enableBreakerTimeout: false },
    );
    if (!response.ok) {
      throwUpstreamHttpError(options.provider ?? "llm", response.status, await response.text());
    }
    return response.json();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
