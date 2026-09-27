import type { ConfigStore, YcbConfig } from "../core/configStore.js";
import type { Evidence, KgmRequest } from "../core/types.js";
import { joinUrl } from "../utils/url.js";
import { generateId } from "../utils/id.js";

/** 与 YCB 仓库约定的最小响应块（见 docs/kgm-haxitag-ycb-alignment.md） */
export type YcbContextBlock = {
  source: string;
  text: string;
  score?: number;
  segmentIds?: string[];
  compressed?: boolean;
  metadata?: Record<string, unknown>;
};

type YcbForKgmResponse = {
  version?: string;
  blocks?: YcbContextBlock[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMetaString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = metadata?.[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * 可选 YCB 客户端：Runtime 汇合点（GW）一侧，将外置上下文块合并进 `ContextPack.evidence`。
 * 失败时默认 fail-open（空数组），不阻塞平面三推理。
 */
export class YcbClient {
  constructor(private store: ConfigStore) {}

  private cfg(): YcbConfig {
    return this.store.get().ycb;
  }

  shouldAttempt(request: KgmRequest): boolean {
    const c = this.cfg();
    if (!c.enabled || !c.baseUrl?.trim()) {
      return false;
    }
    if (request.kgm?.ycb?.skip) {
      return false;
    }
    const buildRef =
      request.kgm?.ycb?.buildRef ??
      readMetaString(request.metadata as Record<string, unknown> | undefined, "ycb_build_ref");
    if (c.requireBuildRef && !buildRef?.trim()) {
      return false;
    }
    return true;
  }

  /**
   * 拉取并映射为 `Evidence[]`（source 前缀 `ycb:`）。与本地检索合并时建议置于列表前部以提高优先级。
   */
  async fetchEvidence(request: KgmRequest): Promise<Evidence[]> {
    if (!this.shouldAttempt(request)) {
      return [];
    }
    const c = this.cfg();
    const traceId = request.kgm?.ops?.traceId ?? request.requestId ?? generateId();
    const buildRef =
      request.kgm?.ycb?.buildRef ??
      readMetaString(request.metadata as Record<string, unknown> | undefined, "ycb_build_ref");
    const collectionId =
      request.kgm?.ycb?.collectionId ??
      readMetaString(request.metadata as Record<string, unknown> | undefined, "ycb_collection_id");

    const body = {
      query: request.input,
      userId: request.userId,
      sessionId: request.sessionId,
      buildRef: buildRef ?? undefined,
      collectionId: collectionId ?? undefined,
      traceId,
      metadata: request.metadata ?? {},
      ycb_context_version: readMetaString(request.metadata as Record<string, unknown> | undefined, "ycb_context_version"),
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-trace-id": traceId,
      "x-kgm-request-id": request.requestId ?? traceId,
    };
    if (c.apiKey?.trim()) {
      headers.authorization = `Bearer ${c.apiKey.trim()}`;
    }

    const controller = c.timeoutMs ? new AbortController() : undefined;
    const timeout = c.timeoutMs ? setTimeout(() => controller?.abort(), c.timeoutMs) : undefined;
    try {
      const url = joinUrl(c.baseUrl, c.path);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      if (!response.ok) {
        if (c.failOpen) {
          return [];
        }
        const text = await response.text();
        throw new Error(`ycb http ${response.status}: ${text}`);
      }
      const data = (await response.json()) as unknown;
      if (!isRecord(data)) {
        return [];
      }
      const blocks = (data as YcbForKgmResponse).blocks;
      if (!Array.isArray(blocks)) {
        return [];
      }
      return blocks
        .filter((b): b is YcbContextBlock => isRecord(b) && typeof b.text === "string" && typeof b.source === "string")
        .map((block, index) => mapBlockToEvidence(block, index));
    } catch {
      if (c.failOpen) {
        return [];
      }
      throw new Error("ycb request failed");
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

function mapBlockToEvidence(block: YcbContextBlock, index: number): Evidence {
  return {
    id: `ycb_${block.source}_${index}`,
    text: block.text,
    score: typeof block.score === "number" && Number.isFinite(block.score) ? block.score : 1,
    source: `ycb:${block.source}`,
    artifact_ref: undefined,
  };
}
