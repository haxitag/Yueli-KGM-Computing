import { protectedFetch } from "../observability/circuitBreaker.js";

export type HttpOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 是否使用连接池优化（保留字段，当前走全局 fetch/熔断） */
  useConnectionPool?: boolean;
  /** 熔断桶名；默认按 URL host */
  circuitName?: string;
};

/**
 * 优化的 HTTP POST：上游经 opossum 熔断；超时用 AbortController。
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
      const text = await response.text();
      throw new Error(`http ${response.status}: ${text}`);
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
      const text = await response.text();
      throw new Error(`http ${response.status}: ${text}`);
    }
    return response.json();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
