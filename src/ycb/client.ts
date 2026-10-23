import type { ConfigStore, YcbConfig } from "../core/configStore.js";
import type { Evidence, KgmRequest } from "../core/types.js";
import { joinUrl } from "../utils/url.js";
import { generateId } from "../utils/id.js";
import { logger } from "../observability/logger.js";

/** 归一后的证据块。真实 YCB 响应形状不一，先归一再映射。 */
export type YcbContextBlock = {
  source: string;
  text: string;
  score?: number;
  segmentIds?: string[];
  compressed?: boolean;
  metadata?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceLabel(source: unknown, fallback: string): string {
  if (typeof source === "string" && source.trim()) {
    return source.trim();
  }
  if (isRecord(source)) {
    const type = typeof source.type === "string" ? source.type : "";
    const id = typeof source.id === "string" ? source.id : "";
    const title = typeof source.title === "string" ? source.title : "";
    const joined = [type, id || title].filter(Boolean).join(":");
    if (joined) {
      return joined;
    }
  }
  return fallback;
}

function asScore(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function blockFromRecord(value: unknown, fallbackSource: string): YcbContextBlock | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text =
    (typeof value.text === "string" && value.text) ||
    (typeof value.content === "string" && value.content) ||
    "";
  if (!text.trim()) {
    return undefined;
  }
  return {
    source: sourceLabel(value.source, fallbackSource),
    text,
    score: asScore(value.score) ?? asScore(value.relevance),
    compressed: typeof value.compressed === "boolean" ? value.compressed : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

/**
 * 解析真实 YCB / ContextBuilder 响应：
 * - KGM 文档：`{ blocks: [{ source, text }] }`
 * - resolve pack：`{ blocks: [{ content, source, score }] }` 或 `{ pack: { blocks, compressedText } }`
 * - consume：`{ contextBlock: { text, source } }` 或 `{ data: { contextBlock } }`
 * - build：`{ result: { text, source } }`
 */
export function parseYcbResponse(data: unknown): YcbContextBlock[] {
  if (!isRecord(data)) {
    return [];
  }
  const nested = isRecord(data.data) ? data.data : data;
  const pack = isRecord(nested.pack) ? nested.pack : nested;
  const fromArray = (items: unknown, fallback: string): YcbContextBlock[] =>
    Array.isArray(items)
      ? items
          .map((item, index) => blockFromRecord(item, `${fallback}_${index}`))
          .filter((block): block is YcbContextBlock => Boolean(block))
      : [];

  const blocks = fromArray(pack.blocks, "block");
  if (blocks.length > 0) {
    return blocks;
  }
  const consume = blockFromRecord(nested.contextBlock, "consume");
  if (consume) {
    return [consume];
  }
  const built = blockFromRecord(nested.result, "build");
  if (built) {
    return [built];
  }
  if (typeof pack.compressedText === "string" && pack.compressedText.trim()) {
    return [{ source: "compressed", text: pack.compressedText }];
  }
  return [];
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

    const collectionIds = collectionId && /^\d+$/.test(collectionId) ? [Number(collectionId)] : undefined;
    const body = {
      query: request.input,
      semanticQuery: { query: request.input, collectionIds },
      userId: request.userId,
      sessionId: request.sessionId,
      buildRef: buildRef ?? undefined,
      buildId: buildRef ?? undefined,
      collectionId: collectionId ?? undefined,
      collectionIds,
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
        throw new Error(`ycb_http_${response.status}`);
      }
      const data = (await response.json()) as unknown;
      const blocks = parseYcbResponse(data);
      if (blocks.length === 0) {
        throw new Error("ycb_invalid_response");
      }
      return blocks.map((block, index) => mapBlockToEvidence(block, index));
    } catch (error) {
      const reason = error instanceof Error && error.message.startsWith("ycb_")
        ? error.message : "ycb_request_failed";
      logger.warn({ traceId, reason }, "YCB context request failed");
      if (c.failOpen) {
        return [];
      }
      throw new Error(reason);
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
