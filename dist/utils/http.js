import { protectedFetch } from "../observability/circuitBreaker.js";
/**
 * 优化的 HTTP POST：上游经 opossum 熔断；超时用 AbortController。
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
            const text = await response.text();
            throw new Error(`http ${response.status}: ${text}`);
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
            const text = await response.text();
            throw new Error(`http ${response.status}: ${text}`);
        }
        return response.json();
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}
