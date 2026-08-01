/**
 * Canonical KGM HTTP error envelope for host-facing APIs.
 * Callers always see KGM-controlled status codes — never raw vendor statuses.
 */
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
/** HTTP statuses KGM may return to callers (not vendor passthrough). */
export const KGM_PUBLIC_ERROR_STATUSES = [400, 401, 402, 403, 404, 429, 500, 501, 502, 503, 504];
export function kgmErrorBody(code, message, status, details) {
    const body = {
        error: {
            code,
            message,
            status,
        },
    };
    if (details && Object.keys(details).length > 0) {
        body.error.details = details;
    }
    return body;
}
export function kgmFail(code, message, status, details) {
    const canonical = canonicalizePublicErrorStatus(status);
    return { status: canonical, body: kgmErrorBody(code, message, canonical, details) };
}
/**
 * Force a public HTTP status into the KGM allow-list.
 * Unknown / vendor statuses (Flux 401, 418, 422, …) collapse to 502.
 */
export function canonicalizePublicErrorStatus(status) {
    if (KGM_PUBLIC_ERROR_STATUSES.includes(status)) {
        return status;
    }
    return 502;
}
/**
 * Upstream HTTP failure → always KGM 502, with upstreamStatus in details.
 * Never echo vendor status as the caller-facing HTTP code.
 */
export function kgmUpstreamFail(code, message, upstreamStatus, extra) {
    return kgmFail(code, message, 502, {
        ...extra,
        upstreamStatus,
    });
}
/** Extract a short human message from heterogeneous vendor error JSON. */
export function extractVendorErrorMessage(json, fallback) {
    if (typeof json === "string" && json.trim()) {
        return json.trim().slice(0, 500);
    }
    if (!json || typeof json !== "object") {
        return fallback;
    }
    const record = json;
    const err = record.error;
    if (typeof err === "string" && err.trim()) {
        return err.trim().slice(0, 500);
    }
    if (err && typeof err === "object") {
        const nested = err;
        if (typeof nested.message === "string" && nested.message.trim()) {
            return nested.message.trim().slice(0, 500);
        }
        if (typeof nested.code === "string" && nested.code.trim()) {
            return nested.code.trim().slice(0, 200);
        }
    }
    if (typeof record.message === "string" && record.message.trim()) {
        return record.message.trim().slice(0, 500);
    }
    return fallback;
}
function isCanonicalKgmErrorBody(body) {
    if (!body || typeof body !== "object" || !("error" in body))
        return false;
    const err = body.error;
    return (!!err &&
        typeof err === "object" &&
        typeof err.code === "string" &&
        typeof err.message === "string" &&
        typeof err.status === "number");
}
/**
 * Last-line defense for host responses: allow-listed status + KgmErrorBody only.
 * Vendor-shaped `{ error: ... }` without our `status` field is rewritten to 502.
 */
export function ensureCanonicalKgmError(status, body, fallbackCode = "internal_error") {
    if (isCanonicalKgmErrorBody(body)) {
        const publicOk = KGM_PUBLIC_ERROR_STATUSES.includes(status);
        if (publicOk) {
            const aligned = canonicalizePublicErrorStatus(status);
            return {
                status: aligned,
                body: kgmErrorBody(body.error.code, body.error.message, aligned, {
                    ...body.error.details,
                    ...(body.error.status !== aligned
                        ? { upstreamStatus: body.error.details?.upstreamStatus ?? body.error.status }
                        : {}),
                }),
            };
        }
        // HTTP status was a vendor code → fold into 502 + details
        return kgmUpstreamFail(body.error.code, body.error.message, status, body.error.details);
    }
    return kgmUpstreamFail(fallbackCode, extractVendorErrorMessage(body, "Request failed"), status >= 100 ? status : 502);
}
