import crypto from "node:crypto";

import type { ConfigStore } from "../core/configStore.js";
import type { PerformanceRecord } from "../models/performance.js";
import { joinUrl } from "../utils/url.js";

export type ContextQualityEvent = {
  timestamp: string;
  user_id?: string;
  recall_topk: number;
  hit_rate: number;
  embedding_version?: string;
};

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/$/, "");

export class AdapterClient {
  private store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
  }

  private buildHeaders(body: string) {
    const cfg = this.store.get().adapter;
    const headers: Record<string, string> = {
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

  private async post(path: string, payload: unknown) {
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

  async sendPerformance(record: PerformanceRecord): Promise<void> {
    const cfg = this.store.get().adapter;
    if (!cfg.enabled || !cfg.sendPerformance) return;
    await this.post(cfg.performancePath, record);
  }

  async sendContextQuality(event: ContextQualityEvent): Promise<void> {
    const cfg = this.store.get().adapter;
    if (!cfg.enabled || !cfg.sendContextQuality) return;
    await this.post(cfg.contextQualityPath, event);
  }
}
