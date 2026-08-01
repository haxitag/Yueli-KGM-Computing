/**
 * 第三方 LLM 在 JSON 响应体中返回的业务错误，或 Ollama 等非 postJson 路径上的失败。
 * 与传输层（超时、DNS）区分：便于日志聚合与 `instanceof` 分流。
 */
export class LlmProviderApiError extends Error {
  readonly provider: string;
  /** 上游类型/code（如 OpenAI 风格 type、HTTP API code） */
  readonly upstreamCode?: string;
  /** 非 2xx 且走 fetch 等路径时记录 */
  readonly httpStatus?: number;
  override readonly name = "LlmProviderApiError";

  constructor(
    provider: string,
    message: string,
    options?: { upstreamCode?: string; httpStatus?: number },
  ) {
    let text = `[${provider}] ${message}`;
    if (options?.upstreamCode) {
      text += ` (code: ${options.upstreamCode})`;
    }
    if (options?.httpStatus != null) {
      text += ` (http: ${options.httpStatus})`;
    }
    super(text);
    Object.setPrototypeOf(this, new.target.prototype);
    this.provider = provider;
    this.upstreamCode = options?.upstreamCode;
    this.httpStatus = options?.httpStatus;
  }
}

/** 将上游 `error` 字段规范为可读字符串（string 或 `{ message }` 等）。 */
export function stringifyLlmProviderErrorPayload(error: unknown): string {
  if (error == null) return "unknown_error";
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const o = error as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Parse http status from legacy Error messages like `http 401: ...` / `HTTP error: 401 - ...`. */
export function parseHttpStatusFromErrorMessage(message: string): number | undefined {
  const m =
    message.match(/\bhttp(?:\s+error)?[:\s]+(\d{3})\b/i) ||
    message.match(/\(http:\s*(\d{3})\)/i);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}
