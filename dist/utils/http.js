export async function postJson(url, body, options = {}) {
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
export async function getJson(url, options = {}) {
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
