export type HttpOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export async function postJson(url: string, body: unknown, options: HttpOptions = {}): Promise<unknown> {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timeout = options.timeoutMs
    ? setTimeout(() => controller?.abort(), options.timeoutMs)
    : undefined;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify(body),
    signal: controller?.signal,
  });
  if (timeout) {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`http ${response.status}: ${text}`);
  }

  return response.json();
}

export async function getJson(url: string, options: HttpOptions = {}): Promise<unknown> {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timeout = options.timeoutMs
    ? setTimeout(() => controller?.abort(), options.timeoutMs)
    : undefined;

  const response = await fetch(url, {
    method: "GET",
    headers: { ...(options.headers ?? {}) },
    signal: controller?.signal,
  });
  if (timeout) {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`http ${response.status}: ${text}`);
  }
  return response.json();
}
