/**
 * OpenAI 兼容 SSE 错误帧（headers 已发送后的中游失败语义）。
 * 与同步路径 structuredErrorBody 对齐，便于客户端统一解析 error.code。
 */
import type { ServerResponse } from "node:http";
import { structuredErrorBody, toKgmStructuredError } from "../errors/structuredError.js";

export type SseReasoningNormalizeMode = "reasoning_content" | "merge_content" | "off";

const REASONING_DELTA_KEYS = ["reasoning_content", "reasoning", "thinking", "thought"] as const;

export function resolveSseReasoningNormalizeMode(): SseReasoningNormalizeMode {
  const raw = (process.env.KGM_SSE_REASONING_NORMALIZE ?? "reasoning_content").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  if (raw === "merge_content" || raw === "merge") return "merge_content";
  return "reasoning_content";
}

export function normalizeOpenAiSseDataPayload(
  dataStr: string,
  mode: SseReasoningNormalizeMode = resolveSseReasoningNormalizeMode(),
): string {
  if (mode === "off" || dataStr === "[DONE]") {
    return dataStr;
  }
  try {
    const data = JSON.parse(dataStr) as Record<string, unknown>;
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return dataStr;
    }
    let changed = false;
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const c = choice as Record<string, unknown>;
      const delta = c.delta;
      if (!delta || typeof delta !== "object") continue;
      const d = delta as Record<string, unknown>;
      const content =
        typeof d.content === "string" && d.content.length > 0 ? d.content : "";
      let reasoningText = "";
      for (const key of REASONING_DELTA_KEYS) {
        const v = d[key];
        if (typeof v === "string" && v.length > 0) {
          reasoningText += v;
          if (key !== "reasoning_content") {
            delete d[key];
            changed = true;
          }
        }
      }
      if (!reasoningText) continue;
      if (mode === "merge_content" && !content) {
        d.content = reasoningText;
        delete d.reasoning;
        delete d.thinking;
        changed = true;
        continue;
      }
      if (!d.reasoning_content) {
        d.reasoning_content = reasoningText;
        changed = true;
      }
      if (d.reasoning !== undefined) {
        delete d.reasoning;
        changed = true;
      }
    }
    return changed ? JSON.stringify(data) : dataStr;
  } catch {
    return dataStr;
  }
}

export function parseStreamIdleMs(envValue?: string): number {
  const raw = envValue ?? process.env.KGM_STREAM_IDLE_MS ?? "";
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 格式化为 SSE data 行（不含尾部分隔）；payload 已是 JSON 字符串或 [DONE]。 */
export function formatSseDataLine(payload: string): string {
  return `data: ${payload}\n\n`;
}

export function formatSseStructuredErrorPayload(error: unknown): string {
  return JSON.stringify(structuredErrorBody(error));
}

/**
 * 在已开启的 SSE 响应上写入结构化错误帧，并可选追加 [DONE]。
 * 若连接已销毁则 no-op。
 */
export function writeSseStructuredError(
  res: ServerResponse,
  error: unknown,
  opts?: { appendDone?: boolean },
): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  try {
    res.write(formatSseDataLine(formatSseStructuredErrorPayload(error)));
    if (opts?.appendDone !== false) {
      res.write(formatSseDataLine("[DONE]"));
    }
  } catch {
    /* ignore write failures on half-closed sockets */
  }
}

export type RelayUpstreamSseOptions = {
  idleMs?: number;
  normalizeMode?: SseReasoningNormalizeMode;
  /** 默认 true；Anthropic 原生流设为 false */
  appendDone?: boolean;
};

/** Promise.race 空闲超时哨兵——绝不可与 reader.read() 的 {done:true} 混用 */
export type StreamIdleTimeoutSentinel = { readonly __kgmIdleTimeout: true };
export const STREAM_IDLE_TIMEOUT: StreamIdleTimeoutSentinel = { __kgmIdleTimeout: true };

export function isStreamIdleTimeout(
  value: unknown,
): value is StreamIdleTimeoutSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as StreamIdleTimeoutSentinel).__kgmIdleTimeout === true
  );
}

/**
 * 中继上游 SSE，并按行归一化 delta；支持空闲超时与客户端断开时 abort 上游。
 * 中游失败 / 空闲超时：写入结构化错误帧 + 可选 [DONE]（不再静默截断）。
 */
export async function relayUpstreamSseNormalized(
  res: ServerResponse,
  upstream: Response,
  opts?: RelayUpstreamSseOptions,
): Promise<void> {
  const idleMs = opts?.idleMs ?? parseStreamIdleMs();
  const mode = opts?.normalizeMode ?? resolveSseReasoningNormalizeMode();
  const appendDone = opts?.appendDone !== false;

  if (!res.headersSent) {
    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    writeSseStructuredError(
      res,
      toKgmStructuredError(new Error("upstream SSE has no response body")),
      { appendDone },
    );
    if (!res.destroyed) res.end();
    return;
  }

  const decoder = new TextDecoder();
  let lineBuffer = "";
  let lastActivity = Date.now();
  let endedWithError = false;
  let sawDone = false;

  const upstreamAbort = new AbortController();
  const onClientClose = () => {
    upstreamAbort.abort();
    void reader.cancel().catch(() => undefined);
  };
  res.on("close", onClientClose);

  try {
    while (true) {
      if (idleMs > 0 && Date.now() - lastActivity > idleMs) {
        endedWithError = true;
        writeSseStructuredError(
          res,
          toKgmStructuredError(new Error(`Stream idle timeout after ${idleMs}ms`)),
          { appendDone },
        );
        break;
      }

      const readPromise = reader.read();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise =
        idleMs > 0
          ? new Promise<StreamIdleTimeoutSentinel>((resolve) => {
              const wait = idleMs - (Date.now() - lastActivity);
              idleTimer = setTimeout(
                () => resolve(STREAM_IDLE_TIMEOUT),
                Math.max(1, wait),
              );
            })
          : null;

      let result: ReadableStreamReadResult<Uint8Array> | StreamIdleTimeoutSentinel;
      try {
        result = timeoutPromise
          ? await Promise.race([readPromise, timeoutPromise])
          : await readPromise;
      } catch (error) {
        endedWithError = true;
        writeSseStructuredError(res, error, { appendDone });
        break;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (isStreamIdleTimeout(result)) {
        endedWithError = true;
        writeSseStructuredError(
          res,
          toKgmStructuredError(new Error(`Stream idle timeout after ${idleMs}ms`)),
          { appendDone },
        );
        void reader.cancel().catch(() => undefined);
        break;
      }

      if (result.done) {
        break;
      }

      lastActivity = Date.now();
      lineBuffer += decoder.decode(result.value, { stream: true });

      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf("\n");

        if (!line.startsWith("data:")) {
          if (line.trim()) {
            res.write(`${line}\n`);
          }
          continue;
        }

        const payload = line.startsWith("data: ") ? line.slice(6) : line.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          res.write(formatSseDataLine("[DONE]"));
          continue;
        }
        const normalized = normalizeOpenAiSseDataPayload(payload, mode);
        res.write(formatSseDataLine(normalized));
      }
    }

    if (!endedWithError && lineBuffer.trim()) {
      res.write(lineBuffer.endsWith("\n") ? lineBuffer : `${lineBuffer}\n`);
    }
    // OpenAI 兼容：上游干净 EOF 却未发 [DONE] 时，补齐终结帧（Anthropic appendDone=false 除外）
    if (!endedWithError && appendDone && !sawDone && !res.destroyed && !res.writableEnded) {
      res.write(formatSseDataLine("[DONE]"));
    }
  } finally {
    res.off("close", onClientClose);
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    if (!res.destroyed) {
      res.end();
    }
  }
}
