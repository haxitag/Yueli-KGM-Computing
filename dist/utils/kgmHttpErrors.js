/**
 * 结构化 API 错误：HTTP 层可区分 4xx/5xx 与可机读 code，便于监控与排障。
 */
/** 请求体验证失败（可机读 code + HTTP status），供 HTTP 层与 JSON 解析共用。 */
export class KgmRequestValidationError extends Error {
    code;
    status;
    name = "KgmRequestValidationError";
    constructor(code, message, status = 400) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.code = code;
        this.status = status;
    }
}
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
