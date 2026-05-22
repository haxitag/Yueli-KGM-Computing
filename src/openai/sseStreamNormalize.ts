import type { ServerResponse } from "node:http";

/** Copilot / OpenAI 客户端识别的推理增量字段 */
const REASONING_DELTA_KEYS = ["reasoning_content", "reasoning", "thinking", "thought"] as const;

export type SseReasoningNormalizeMode = "reasoning_content" | "merge_content" | "off";

export function resolveSseReasoningNormalizeMode(): SseReasoningNormalizeMode {
  const raw = (process.env.KGM_SSE_REASONING_NORMALIZE ?? "reasoning_content").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  if (raw === "merge_content" || raw === "merge") return "merge_content";
  return "reasoning_content";
}

/**
 * 将上游 SSE `data:` 行中的 `delta.reasoning` 等字段规范为 OpenAI 兼容形状。
 */
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

/**
 * 中继上游 SSE，并按行归一化 delta；支持空闲超时与客户端断开时 abort 上游。
 */
export async function relayUpstreamSseNormalized(
  res: ServerResponse,
  upstream: Response,
  opts?: { idleMs?: number; normalizeMode?: SseReasoningNormalizeMode },
): Promise<void> {
  const idleMs = opts?.idleMs ?? parseStreamIdleMs();
  const mode = opts?.normalizeMode ?? resolveSseReasoningNormalizeMode();

  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let lineBuffer = "";
  let lastActivity = Date.now();

  const upstreamAbort = new AbortController();
  const onClientClose = () => {
    upstreamAbort.abort();
    void reader.cancel().catch(() => undefined);
  };
  res.on("close", onClientClose);

  try {
    while (true) {
      if (idleMs > 0 && Date.now() - lastActivity > idleMs) {
        break;
      }

      const readPromise = reader.read();
      const timeoutPromise =
        idleMs > 0
          ? new Promise<{ done: true; value?: undefined }>((resolve) => {
              const wait = idleMs - (Date.now() - lastActivity);
              setTimeout(() => resolve({ done: true }), Math.max(1, wait));
            })
          : null;

      const result = timeoutPromise
        ? await Promise.race([readPromise, timeoutPromise])
        : await readPromise;

      if (result.done) {
        break;
      }

      lastActivity = Date.now();
      lineBuffer += decoder.decode(result.value!, { stream: true });

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
          res.write("data: [DONE]\n\n");
          continue;
        }
        const normalized = normalizeOpenAiSseDataPayload(payload, mode);
        res.write(`data: ${normalized}\n\n`);
      }
    }

    if (lineBuffer.trim()) {
      res.write(lineBuffer.endsWith("\n") ? lineBuffer : `${lineBuffer}\n`);
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
