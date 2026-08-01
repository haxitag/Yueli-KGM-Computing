/**
 * OpenAI-compatible media thin proxy: images (generations/edits/variations),
 * audio (speech/transcriptions/translations), video async jobs, optional rerank.
 * Does not enter chat/tool-loop compatibility; hosts call these routes on the KGM gateway.
 */

import type { KgmConfig, MediaConfig, MediaEndpointConfig } from "../core/configStore.js";
import { kgmErrorBody, type KgmErrorBody } from "../utils/kgmHttpErrors.js";
import { getMediaJobStore } from "./mediaJobs.js";

export type MediaKind = "image" | "speech" | "transcription" | "video" | "rerank";

export type ResolvedMediaUpstream = {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  path: string;
  timeoutMs: number;
  maxDurationSec?: number;
  resultMode?: "url" | "b64";
  maxConcurrent?: number;
  statusPath?: string;
};

export type MediaProxyResult =
  | { ok: true; status: number; json?: unknown; binary?: Buffer; contentType?: string }
  | { ok: false; status: number; body: KgmErrorBody };

const DEFAULT_PATHS: Record<MediaKind, string> = {
  image: "/images/generations",
  speech: "/audio/speech",
  transcription: "/audio/transcriptions",
  video: "/videos/generations",
  rerank: "/rerank",
};

const NOT_CONFIGURED_CODES: Record<MediaKind, string> = {
  image: "image_generation_provider_not_configured",
  speech: "text_to_speech_provider_not_configured",
  transcription: "speech_to_text_provider_not_configured",
  video: "video_generation_provider_not_configured",
  rerank: "rerank_provider_not_configured",
};

function envPrefix(kind: MediaKind): string {
  if (kind === "image") return "KGM_IMAGE";
  if (kind === "speech") return "KGM_TTS";
  if (kind === "transcription") return "KGM_STT";
  if (kind === "video") return "KGM_VIDEO";
  return "KGM_RERANK";
}

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  const base = trimBase(baseUrl);
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && p.startsWith("/v1/")) {
    return `${base}${p.slice(3)}`;
  }
  return `${base}${p}`;
}

/** Resolve upstream for one media kind: env overrides config; optional LLM credential reuse. */
export function resolveMediaUpstream(
  kind: MediaKind,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): ResolvedMediaUpstream | null {
  const prefix = envPrefix(kind);
  const fromConfig: MediaEndpointConfig | undefined = config?.media?.[kind];
  let baseUrl =
    process.env[`${prefix}_BASE_URL`]?.trim() ||
    fromConfig?.baseUrl?.trim() ||
    "";
  let apiKey =
    process.env[`${prefix}_API_KEY`]?.trim() ||
    fromConfig?.apiKey?.trim() ||
    undefined;
  let model =
    process.env[`${prefix}_MODEL`]?.trim() ||
    fromConfig?.model?.trim() ||
    undefined;
  const path =
    process.env[`${prefix}_PATH`]?.trim() ||
    fromConfig?.path?.trim() ||
    DEFAULT_PATHS[kind];
  const timeoutRaw =
    process.env[`${prefix}_TIMEOUT_MS`]?.trim() ||
    (fromConfig?.timeoutMs != null ? String(fromConfig.timeoutMs) : "");
  const timeoutMs = Number.parseInt(timeoutRaw || "120000", 10);

  if (process.env.KGM_MEDIA_USE_LLM_CREDENTIALS === "1" && config?.llm) {
    if (!baseUrl) baseUrl = config.llm.baseUrl?.trim() || "";
    if (!apiKey) apiKey = config.llm.apiKey?.trim() || undefined;
  }

  if (!baseUrl) return null;
  const fromVideo = kind === "video" ? config?.media?.video : undefined;
  const maxDurEnv = Number.parseInt(process.env.KGM_VIDEO_MAX_DURATION_SEC?.trim() || "", 10);
  const maxConcEnv = Number.parseInt(process.env.KGM_VIDEO_MAX_CONCURRENT?.trim() || "", 10);
  return {
    baseUrl: trimBase(baseUrl),
    apiKey: apiKey || undefined,
    model: model || undefined,
    path: path.startsWith("/") ? path : `/${path}`,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
    maxDurationSec:
      Number.isFinite(maxDurEnv) && maxDurEnv > 0 ? maxDurEnv : fromVideo?.maxDurationSec,
    resultMode: fromVideo?.resultMode,
    maxConcurrent:
      Number.isFinite(maxConcEnv) && maxConcEnv > 0 ? maxConcEnv : fromVideo?.maxConcurrent,
    statusPath:
      process.env.KGM_VIDEO_STATUS_PATH?.trim() ||
      fromVideo?.statusPath?.trim() ||
      undefined,
  };
}

export function listConfiguredMediaModels(
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Array<{
  id: string;
  capabilities: string[];
  model_type: string;
  kind: MediaKind;
}> {
  const out: Array<{
    id: string;
    capabilities: string[];
    model_type: string;
    kind: MediaKind;
  }> = [];
  const specs: Array<{ kind: MediaKind; cap: string; modelType: string; fallbackId: string }> = [
    { kind: "image", cap: "image_generation", modelType: "image_generation", fallbackId: "kgm-image" },
    { kind: "speech", cap: "text_to_speech", modelType: "text_to_speech", fallbackId: "kgm-tts" },
    {
      kind: "transcription",
      cap: "speech_to_text",
      modelType: "speech_to_text",
      fallbackId: "kgm-stt",
    },
    { kind: "video", cap: "video_generation", modelType: "video_generation", fallbackId: "kgm-video" },
    { kind: "rerank", cap: "rerank", modelType: "task_specific", fallbackId: "kgm-rerank" },
  ];
  for (const s of specs) {
    const up = resolveMediaUpstream(s.kind, config);
    if (!up) continue;
    out.push({
      id: up.model || s.fallbackId,
      capabilities: [s.cap],
      model_type: s.modelType,
      kind: s.kind,
    });
  }
  return out;
}

function notConfigured(kind: MediaKind): MediaProxyResult {
  const code = NOT_CONFIGURED_CODES[kind];
  return {
    ok: false,
    status: 501,
    body: kgmErrorBody(
      code,
      `Media upstream for ${kind} is not configured. Set ${envPrefix(kind)}_BASE_URL or config.media.${kind}.baseUrl.`,
      501,
    ),
  };
}

async function proxyJson(
  kind: MediaKind,
  upstream: ResolvedMediaUpstream,
  body: Record<string, unknown>,
): Promise<MediaProxyResult> {
  const url = joinUrl(upstream.baseUrl, upstream.path);
  const payload = { ...body };
  if (upstream.model && payload.model == null) {
    payload.model = upstream.model;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (upstream.apiKey) {
    headers.authorization = `Bearer ${upstream.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstream.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json") || kind === "image" || kind === "transcription") {
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* keep text */
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status >= 400 ? res.status : 502,
          body:
            typeof json === "object" && json && "error" in (json as object)
              ? (json as KgmErrorBody)
              : kgmErrorBody(
                  "media_upstream_error",
                  typeof json === "string" ? json : `Upstream ${kind} failed with HTTP ${res.status}`,
                  res.status >= 400 ? res.status : 502,
                ),
        };
      }
      return { ok: true, status: res.status, json };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      return {
        ok: false,
        status: res.status >= 400 ? res.status : 502,
        body: kgmErrorBody(
          "media_upstream_error",
          `Upstream ${kind} failed with HTTP ${res.status}`,
          res.status >= 400 ? res.status : 502,
        ),
      };
    }
    return {
      ok: true,
      status: res.status,
      binary: buf,
      contentType: contentType || "application/octet-stream",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      body: kgmErrorBody("media_upstream_unreachable", message, 502),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function proxyRaw(
  kind: MediaKind,
  upstream: ResolvedMediaUpstream,
  rawBody: Buffer,
  contentType: string,
): Promise<MediaProxyResult> {
  const url = joinUrl(upstream.baseUrl, upstream.path);
  const headers: Record<string, string> = {
    "content-type": contentType,
    accept: "application/json",
  };
  if (upstream.apiKey) {
    headers.authorization = `Bearer ${upstream.apiKey}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstream.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: new Uint8Array(rawBody),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* keep */
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status >= 400 ? res.status : 502,
        body:
          typeof json === "object" && json && "error" in (json as object)
            ? (json as KgmErrorBody)
            : kgmErrorBody(
                "media_upstream_error",
                typeof json === "string" ? json : `Upstream ${kind} failed with HTTP ${res.status}`,
                res.status >= 400 ? res.status : 502,
              ),
      };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      body: kgmErrorBody("media_upstream_unreachable", message, 502),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function proxyImagesGenerations(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("image", config);
  if (!upstream) return notConfigured("image");
  return proxyJson("image", upstream, body);
}

export async function proxyAudioSpeech(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("speech", config);
  if (!upstream) return notConfigured("speech");
  return proxyJson("speech", upstream, body);
}

/**
 * JSON body: OpenAI-shaped fields plus optional `file_base64` / `file` (base64) + `filename`.
 * Multipart: pass raw buffer + content-type via `proxyAudioTranscriptionsMultipart`.
 */
export async function proxyAudioTranscriptions(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("transcription", config);
  if (!upstream) return notConfigured("transcription");

  const b64 =
    (typeof body.file_base64 === "string" && body.file_base64) ||
    (typeof body.file === "string" && body.file) ||
    "";
  if (b64) {
    const filename = typeof body.filename === "string" ? body.filename : "audio.webm";
    const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)]), filename);
    if (upstream.model || typeof body.model === "string") {
      form.append("model", String(body.model || upstream.model));
    }
    if (typeof body.language === "string") form.append("language", body.language);
    if (typeof body.prompt === "string") form.append("prompt", body.prompt);
    if (typeof body.response_format === "string") form.append("response_format", body.response_format);
    if (typeof body.temperature === "number") form.append("temperature", String(body.temperature));

    const url = joinUrl(upstream.baseUrl, upstream.path);
    const headers: Record<string, string> = { accept: "application/json" };
    if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstream.timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers, body: form, signal: controller.signal });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* keep */
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status >= 400 ? res.status : 502,
          body: kgmErrorBody(
            "media_upstream_error",
            typeof json === "string" ? json : `Upstream transcription failed with HTTP ${res.status}`,
            res.status >= 400 ? res.status : 502,
          ),
        };
      }
      return { ok: true, status: res.status, json };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 502, body: kgmErrorBody("media_upstream_unreachable", message, 502) };
    } finally {
      clearTimeout(timer);
    }
  }

  return proxyJson("transcription", upstream, body);
}

export async function proxyAudioTranscriptionsMultipart(
  rawBody: Buffer,
  contentType: string,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("transcription", config);
  if (!upstream) return notConfigured("transcription");
  return proxyRaw("transcription", upstream, rawBody, contentType);
}

export async function proxyImagesEdits(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("image", config);
  if (!upstream) return notConfigured("image");
  return proxyJson("image", { ...upstream, path: "/images/edits" }, body);
}

export async function proxyImagesVariations(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("image", config);
  if (!upstream) return notConfigured("image");
  return proxyJson("image", { ...upstream, path: "/images/variations" }, body);
}

export async function proxyAudioTranslations(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("transcription", config);
  if (!upstream) return notConfigured("transcription");
  const withPath = { ...upstream, path: "/audio/translations" };
  const b64 =
    (typeof body.file_base64 === "string" && body.file_base64) ||
    (typeof body.file === "string" && body.file) ||
    "";
  if (b64) {
    const filename = typeof body.filename === "string" ? body.filename : "audio.webm";
    const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)]), filename);
    if (withPath.model || typeof body.model === "string") {
      form.append("model", String(body.model || withPath.model));
    }
    const url = joinUrl(withPath.baseUrl, withPath.path);
    const headers: Record<string, string> = { accept: "application/json" };
    if (withPath.apiKey) headers.authorization = `Bearer ${withPath.apiKey}`;
    try {
      const res = await fetch(url, { method: "POST", headers, body: form });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* keep */
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status >= 400 ? res.status : 502,
          body: kgmErrorBody(
            "media_upstream_error",
            typeof json === "string" ? json : `Upstream translation failed with HTTP ${res.status}`,
            res.status >= 400 ? res.status : 502,
          ),
        };
      }
      return { ok: true, status: res.status, json };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 502,
        body: kgmErrorBody("media_upstream_unreachable", message, 502),
      };
    }
  }
  return proxyJson("transcription", withPath, body);
}

export async function proxyRerank(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("rerank", config);
  if (!upstream) return notConfigured("rerank");
  return proxyJson("rerank", upstream, body);
}

/**
 * Start an async video generation job. Returns 501 if video upstream missing,
 * 400 if duration exceeds max, 429 if concurrency saturated.
 */
export async function startVideoGenerationJob(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
  store = getMediaJobStore(),
): Promise<MediaProxyResult> {
  const upstream = resolveMediaUpstream("video", config);
  if (!upstream) return notConfigured("video");

  const maxDur = upstream.maxDurationSec ?? config?.media?.video?.maxDurationSec ?? 30;
  const seconds =
    typeof body.seconds === "number"
      ? body.seconds
      : typeof body.duration === "number"
        ? body.duration
        : undefined;
  if (seconds != null && seconds > maxDur) {
    return {
      ok: false,
      status: 400,
      body: kgmErrorBody(
        "video_duration_exceeded",
        `Requested duration ${seconds}s exceeds maxDurationSec=${maxDur}`,
        400,
      ),
    };
  }

  const maxConcurrent = upstream.maxConcurrent ?? config?.media?.video?.maxConcurrent ?? 2;
  if (!store.tryAcquireSlot(maxConcurrent)) {
    return {
      ok: false,
      status: 429,
      body: kgmErrorBody(
        "video_concurrency_limit",
        `Too many in-flight video jobs (max=${maxConcurrent})`,
        429,
      ),
    };
  }

  const job = store.create({
    kind: "video",
    model: typeof body.model === "string" ? body.model : upstream.model,
    request: body,
  });

  void runVideoJob(job.id, body, upstream, store).finally(() => store.releaseSlot());

  return {
    ok: true,
    status: 202,
    json: store.get(job.id),
  };
}

async function runVideoJob(
  jobId: string,
  body: Record<string, unknown>,
  upstream: ResolvedMediaUpstream,
  store: ReturnType<typeof getMediaJobStore>,
): Promise<void> {
  store.update(jobId, { status: "processing" });
  const result = await proxyJson("video", upstream, body);
  if (!result.ok) {
    store.update(jobId, {
      status: "failed",
      error: { code: result.body.error.code, message: result.body.error.message },
    });
    return;
  }

  const json = result.json;
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const upstreamStatus = typeof obj.status === "string" ? obj.status : "";
    const upstreamId = typeof obj.id === "string" ? obj.id : undefined;
    if (
      upstreamId &&
      upstream.statusPath &&
      (upstreamStatus === "queued" ||
        upstreamStatus === "processing" ||
        upstreamStatus === "in_progress" ||
        upstreamStatus === "pending")
    ) {
      store.update(jobId, { upstream_job_id: upstreamId });
      const polled = await pollUpstreamVideoJob(upstream, upstreamId);
      if (!polled.ok) {
        store.update(jobId, {
          status: "failed",
          error: { code: polled.body.error.code, message: polled.body.error.message },
        });
        return;
      }
      store.update(jobId, { status: "completed", result: polled.json });
      return;
    }
  }

  store.update(jobId, { status: "completed", result: json });
}

async function pollUpstreamVideoJob(
  upstream: ResolvedMediaUpstream,
  upstreamId: string,
): Promise<MediaProxyResult> {
  const template = upstream.statusPath || "/videos/{id}";
  const path = template.replace("{id}", encodeURIComponent(upstreamId));
  const url = joinUrl(upstream.baseUrl, path);
  const headers: Record<string, string> = { accept: "application/json" };
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`;

  const deadline = Date.now() + Math.min(upstream.timeoutMs, 10 * 60_000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* keep */
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status >= 400 ? res.status : 502,
          body: kgmErrorBody(
            "media_upstream_error",
            `Upstream video status failed with HTTP ${res.status}`,
            res.status >= 400 ? res.status : 502,
          ),
        };
      }
      const status =
        json && typeof json === "object" && typeof (json as { status?: unknown }).status === "string"
          ? String((json as { status: string }).status)
          : "completed";
      if (
        status === "completed" ||
        status === "succeeded" ||
        status === "ready" ||
        status === "failed" ||
        status === "error"
      ) {
        if (status === "failed" || status === "error") {
          return {
            ok: false,
            status: 502,
            body: kgmErrorBody("video_upstream_failed", `Upstream job ${upstreamId} status=${status}`, 502),
          };
        }
        return { ok: true, status: 200, json };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 502, body: kgmErrorBody("media_upstream_unreachable", message, 502) };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return {
    ok: false,
    status: 504,
    body: kgmErrorBody("video_poll_timeout", `Timed out polling upstream job ${upstreamId}`, 504),
  };
}

export function emptyMediaConfig(): MediaConfig {
  return {
    image: { baseUrl: "" },
    speech: { baseUrl: "" },
    transcription: { baseUrl: "" },
    video: { baseUrl: "" },
    rerank: { baseUrl: "" },
  };
}
