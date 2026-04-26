/**
 * 结构化 API 错误：HTTP 层可区分 4xx/5xx 与可机读 code，便于监控与排障。
 */

export class KgmJsonParseError extends Error {
  readonly code = "invalid_json" as const;
  readonly status = 400;
  override readonly name = "KgmJsonParseError";
  constructor(message = "Request body is not valid JSON") {
    super(message);
  }
}

export type KgmErrorBody = {
  error: {
    code: string;
    message: string;
    status: number;
  };
};

export function kgmErrorBody(
  code: string,
  message: string,
  status: number,
): KgmErrorBody {
  return {
    error: {
      code,
      message,
      status,
    },
  };
}
