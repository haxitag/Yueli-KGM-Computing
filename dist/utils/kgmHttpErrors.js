/**
 * 结构化 API 错误：HTTP 层可区分 4xx/5xx 与可机读 code，便于监控与排障。
 */
export class KgmJsonParseError extends Error {
    code = "invalid_json";
    status = 400;
    name = "KgmJsonParseError";
    constructor(message = "Request body is not valid JSON") {
        super(message);
    }
}
export function kgmErrorBody(code, message, status) {
    return {
        error: {
            code,
            message,
            status,
        },
    };
}
