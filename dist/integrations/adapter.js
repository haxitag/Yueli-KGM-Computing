import crypto from "node:crypto";
import { joinUrl } from "../utils/url.js";
const normalizeBaseUrl = (baseUrl) => baseUrl.replace(/\/$/, "");
export class AdapterClient {
    store;
    constructor(store) {
        this.store = store;
    }
    buildHeaders(body) {
        const cfg = this.store.get().adapter;
        const headers = {
            "content-type": "application/json",
        };
        if (!cfg.secret) {
            return headers;
        }
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = crypto
            .createHmac("sha256", cfg.secret)
            .update(`${timestamp}.${body}`)
            .digest("hex");
        headers["X-Yueli-Timestamp"] = String(timestamp);
        headers["X-Yueli-Signature"] = `v1=${signature}`;
        return headers;
    }
    async post(path, payload) {
        const cfg = this.store.get().adapter;
        if (!cfg.enabled || !cfg.baseUrl) {
            return;
        }
        const body = JSON.stringify(payload);
        const headers = this.buildHeaders(body);
        const url = joinUrl(normalizeBaseUrl(cfg.baseUrl), path);
        const controller = cfg.timeoutMs ? new AbortController() : undefined;
        const timeout = cfg.timeoutMs
            ? setTimeout(() => controller?.abort(), cfg.timeoutMs)
            : undefined;
        const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: controller?.signal,
        });
        if (timeout) {
            clearTimeout(timeout);
        }
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`adapter http ${response.status}: ${text}`);
        }
    }
    async sendPerformance(record) {
        const cfg = this.store.get().adapter;
        if (!cfg.enabled || !cfg.sendPerformance)
            return;
        await this.post(cfg.performancePath, record);
    }
    async sendContextQuality(event) {
        const cfg = this.store.get().adapter;
        if (!cfg.enabled || !cfg.sendContextQuality)
            return;
        await this.post(cfg.contextQualityPath, event);
    }
}
