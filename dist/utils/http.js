import { protectedFetch } from "../observability/circuitBreaker.js";
import { LlmProviderApiError } from "../llm/providerApiError.js";
function stringifyUpstream(json, text, status) {
    if (json && typeof json === "object") {
        const err = json.error;
        if (typeof err === "string" && err.trim())
            return err.trim().slice(0, 500);
        if (err && typeof err === "object" && typeof err.message === "string") {
            return String(err.message).slice(0, 500);
        }
        if (typeof json.message === "string") {
            return String(json.message).slice(0, 500);
        }
    }
    if (typeof text === "string" && text.trim())
        return text.trim().slice(0, 500);
    return `Upstream failed with HTTP ${status}`;
}
function throwUpstreamHttpError(provider, status, text) {
    let json = text;
    try {
        json = text ? JSON.parse(text) : {};
    }
    catch {
        /* keep text */
    }
    const upstreamCode = json && typeof json === "object" && "error" in json
        ? String((json.error)?.code ??
            (json.error)?.type ??
            "") || undefined
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
export async function postJson(url, body, options = {}) {
    const controller = options.timeoutMs ? new AbortController() : undefined;
    const timeout = options.timeoutMs
        ? setTimeout(() => controller?.abort(), options.timeoutMs)
        : undefined;
    try {
        const response = await protectedFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...(options.headers ?? {}) },
            body: JSON.stringify(body),
            signal: controller?.signal,
        }, { name: options.circuitName, enableBreakerTimeout: false });
        if (!response.ok) {
            throwUpstreamHttpError(options.provider ?? "llm", response.status, await response.text());
        }
        return response.json();
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}
export async function getJson(url, options = {}) {
    const controller = options.timeoutMs ? new AbortController() : undefined;
    const timeout = options.timeoutMs
        ? setTimeout(() => controller?.abort(), options.timeoutMs)
        : undefined;
    try {
        const response = await protectedFetch(url, {
            method: "GET",
            headers: { ...(options.headers ?? {}) },
            signal: controller?.signal,
        }, { name: options.circuitName, enableBreakerTimeout: false });
        if (!response.ok) {
            throwUpstreamHttpError(options.provider ?? "llm", response.status, await response.text());
        }
        return response.json();
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}
