/**
 * OpenAI-compatible media thin proxy: images (generations/edits/variations),
 * audio (speech/transcriptions/translations), video async jobs, optional rerank.
 * Supports declarative media.providers (model presets × host endpoints) with
 * legacy media.image|speech|… projected as openai-compat providers.
 */

import type { KgmConfig, MediaConfig } from "../core/configStore.js";
import { ensureCanonicalKgmError, type KgmErrorBody } from "../utils/kgmHttpErrors.js";
import { mediaFail, mediaUpstreamHttpFail } from "./mediaErrors.js";
import { getMediaJobStore } from "./mediaJobs.js";
import {
  executeMediaProvider,
  joinMediaUrl,
  normalizeOpenAiImages,
  normalizeOpenAiTranscription,
  pollMediaProvider,
  resolveProviderSecrets,
  type MediaExecResult,
} from "./mediaProviderExecutor.js";
import { listMediaProviderModels, resolveMediaProvider } from "./mediaProviderRegistry.js";
import type { MediaModality, ResolvedMediaProvider } from "./mediaProviderTypes.js";

export type MediaKind = MediaModality;

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

const NOT_CONFIGURED_CODES: Record<MediaKind, string> = {
  image: "image_generation_provider_not_configured",
  speech: "text_to_speech_provider_not_configured",
  transcription: "speech_to_text_provider_not_configured",
  video: "video_generation_provider_not_configured",
  rerank: "rerank_provider_not_configured",
};

const ENV_PREFIX: Record<MediaKind, string> = {
  image: "KGM_IMAGE",
  speech: "KGM_TTS",
  transcription: "KGM_STT",
  video: "KGM_VIDEO",
  rerank: "KGM_RERANK",
};

function notConfigured(kind: MediaKind): MediaProxyResult {
  const code = NOT_CONFIGURED_CODES[kind] as
    | "image_generation_provider_not_configured"
    | "text_to_speech_provider_not_configured"
    | "speech_to_text_provider_not_configured"
    | "video_generation_provider_not_configured"
    | "rerank_provider_not_configured";
  const fail = mediaFail(
    code,
    `Media upstream for ${kind} is not configured. Set ${ENV_PREFIX[kind]}_BASE_URL, config.media.${kind}.baseUrl, or media.providers[].`,
  );
  return { ok: false, status: fail.status, body: fail.body };
}

function providerNotFound(providerId: string): MediaProxyResult {
  const fail = mediaFail(
    "media_provider_not_found",
    `Unknown media provider id "${providerId}". Use a configured media.providers[].id or omit provider for model/legacy selection.`,
    { providerId },
  );
  return { ok: false, status: fail.status, body: fail.body };
}

/** Ensure host always gets allow-listed status + KgmErrorBody (never vendor passthrough). */
export function toCanonicalMediaProxyFailure(
  status: number,
  body: unknown,
): Extract<MediaProxyResult, { ok: false }> {
  const fail = ensureCanonicalKgmError(status, body, "media_upstream_error");
  return { ok: false, status: fail.status, body: fail.body };
}

/** Explicit provider id from OpenAI-shaped body (selection stage, independent of stream). */
export function extractMediaProviderId(body: Record<string, unknown>): string | undefined {
  if (typeof body.provider === "string" && body.provider.trim()) {
    return body.provider.trim();
  }
  if (typeof body.kgm_provider === "string" && body.kgm_provider.trim()) {
    return body.kgm_provider.trim();
  }
  return undefined;
}

function resolveOrFail(
  kind: MediaKind,
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): ResolvedMediaProvider | MediaProxyResult {
  const providerId = extractMediaProviderId(body);
  const resolved = resolveMediaProvider(kind, body, config);
  if (resolved) return resolved;
  if (providerId && providerId !== `legacy-${kind}`) {
    return providerNotFound(providerId);
  }
  return notConfigured(kind);
}

function isProxyFailure(
  value: ResolvedMediaProvider | MediaProxyResult,
): value is MediaProxyResult {
  return "ok" in value && value.ok === false;
}

function execToProxy(result: MediaExecResult, normalize?: "images" | "transcription"): MediaProxyResult {
  if (!result.ok) return toCanonicalMediaProxyFailure(result.status, result.body);
  if (result.binary) {
    return {
      ok: true,
      status: result.status,
      binary: result.binary,
      contentType: result.contentType,
    };
  }
  let json = result.json;
  if (normalize === "images") json = normalizeOpenAiImages(result);
  if (normalize === "transcription") json = normalizeOpenAiTranscription(result);
  return { ok: true, status: result.status, json };
}

/** Resolve upstream for one media kind (legacy shape; used by tests / statusPath helpers). */
export function resolveMediaUpstream(
  kind: MediaKind,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): ResolvedMediaUpstream | null {
  const resolved = resolveMediaProvider(kind, {}, config);
  if (!resolved) return null;
  const p = resolved.provider;
  return {
    baseUrl: p.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model,
    path: p.create.path,
    timeoutMs: p.timeoutMs ?? 120000,
    maxDurationSec: p.maxDurationSec,
    resultMode: p.resultMode,
    maxConcurrent: p.maxConcurrent,
    statusPath: p.response?.poll?.path?.includes("{{taskId}}")
      ? p.response.poll.path.replace("{{taskId}}", "{id}")
      : undefined,
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
  return listMediaProviderModels(config).map((m) => ({
    id: m.id,
    capabilities: m.capabilities,
    model_type: m.model_type,
    kind: m.kind,
  }));
}

function needsImageNormalize(resolved: ResolvedMediaProvider): boolean {
  const r = resolved.provider.response;
  if (!r) return false;
  if (r.passthrough === false) return true;
  return Boolean(r.mediaUrl || r.b64);
}

function needsTranscriptionNormalize(resolved: ResolvedMediaProvider): boolean {
  const r = resolved.provider.response;
  return Boolean(r?.text);
}

export async function proxyImagesGenerations(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("image", body, config);
  if (isProxyFailure(resolved)) return resolved;
  const result = await executeMediaProvider(resolved, body);
  return execToProxy(result, needsImageNormalize(resolved) ? "images" : undefined);
}

export async function proxyAudioSpeech(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("speech", body, config);
  if (isProxyFailure(resolved)) return resolved;
  const result = await executeMediaProvider(resolved, body, { expectBinary: true });
  return execToProxy(result);
}

/**
 * JSON body: OpenAI-shaped fields plus optional `file_base64` / `file` (base64) + `filename`.
 * Multipart: pass raw buffer + content-type via `proxyAudioTranscriptionsMultipart`.
 */
export async function proxyAudioTranscriptions(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("transcription", body, config);
  if (isProxyFailure(resolved)) return resolved;

  const b64 =
    (typeof body.file_base64 === "string" && body.file_base64) ||
    (typeof body.file === "string" && body.file) ||
    "";
  if (b64) {
    return proxyTranscriptionMultipartFromBase64(resolved, body, b64, resolved.provider.create.path);
  }

  const result = await executeMediaProvider(resolved, body);
  return execToProxy(result, needsTranscriptionNormalize(resolved) ? "transcription" : undefined);
}

async function proxyTranscriptionMultipartFromBase64(
  resolved: ResolvedMediaProvider,
  body: Record<string, unknown>,
  b64: string,
  path: string,
): Promise<MediaProxyResult> {
  const filename = typeof body.filename === "string" ? body.filename : "audio.webm";
  const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)]), filename);
  const model = resolved.model || (typeof body.model === "string" ? body.model : undefined);
  if (model) form.append("model", model);
  if (typeof body.language === "string") form.append("language", body.language);
  if (typeof body.prompt === "string") form.append("prompt", body.prompt);
  if (typeof body.response_format === "string") form.append("response_format", body.response_format);
  if (typeof body.temperature === "number") form.append("temperature", String(body.temperature));

  const url = joinMediaUrl(resolved.provider.baseUrl, path);
  const headers: Record<string, string> = { accept: "application/json" };
  if (resolved.apiKey) headers.authorization = `Bearer ${resolved.apiKey}`;
  else if (resolved.provider.auth?.type === "bearer") {
    const envKey =
      "apiKeyEnv" in resolved.provider.auth
        ? process.env[resolved.provider.auth.apiKeyEnv ?? ""]?.trim()
        : undefined;
    const key = envKey || ("apiKey" in resolved.provider.auth ? resolved.provider.auth.apiKey : undefined);
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const timeoutMs = resolved.provider.timeoutMs ?? 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const fail = mediaUpstreamHttpFail(res.status, json);
      return { ok: false, status: fail.status, body: fail.body };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fail = mediaFail("media_upstream_unreachable", message);
    return { ok: false, status: fail.status, body: fail.body };
  } finally {
    clearTimeout(timer);
  }
}

export async function proxyAudioTranscriptionsMultipart(
  rawBody: Buffer,
  contentType: string,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveMediaProvider("transcription", {}, config);
  if (!resolved) return notConfigured("transcription");
  const url = joinMediaUrl(resolved.provider.baseUrl, resolved.provider.create.path);
  const headers: Record<string, string> = {
    "content-type": contentType,
    accept: "application/json",
  };
  if (resolved.apiKey) headers.authorization = `Bearer ${resolved.apiKey}`;
  const timeoutMs = resolved.provider.timeoutMs ?? 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const fail = mediaUpstreamHttpFail(res.status, json);
      return { ok: false, status: fail.status, body: fail.body };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fail = mediaFail("media_upstream_unreachable", message);
    return { ok: false, status: fail.status, body: fail.body };
  } finally {
    clearTimeout(timer);
  }
}

export async function proxyImagesEdits(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("image", body, config);
  if (isProxyFailure(resolved)) return resolved;
  const result = await executeMediaProvider(resolved, body, { pathOverride: "/images/edits" });
  return execToProxy(result, needsImageNormalize(resolved) ? "images" : undefined);
}

export async function proxyImagesVariations(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("image", body, config);
  if (isProxyFailure(resolved)) return resolved;
  const result = await executeMediaProvider(resolved, body, { pathOverride: "/images/variations" });
  return execToProxy(result, needsImageNormalize(resolved) ? "images" : undefined);
}

export async function proxyAudioTranslations(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("transcription", body, config);
  if (isProxyFailure(resolved)) return resolved;
  const path = "/audio/translations";
  const b64 =
    (typeof body.file_base64 === "string" && body.file_base64) ||
    (typeof body.file === "string" && body.file) ||
    "";
  if (b64) {
    return proxyTranscriptionMultipartFromBase64(resolved, body, b64, path);
  }
  const result = await executeMediaProvider(resolved, body, { pathOverride: path });
  return execToProxy(result, needsTranscriptionNormalize(resolved) ? "transcription" : undefined);
}

export async function proxyRerank(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("rerank", body, config);
  if (isProxyFailure(resolved)) return resolved;
  const result = await executeMediaProvider(resolved, body);
  return execToProxy(result);
}

/**
 * Start an async video generation job. Returns 501 if video upstream missing,
 * 400 if duration exceeds max, 429 if concurrency saturated.
 */
export async function startVideoGenerationJob(
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
  store = getMediaJobStore(),
  options?: { ownerKeyId?: string },
): Promise<MediaProxyResult> {
  const resolved = resolveOrFail("video", body, config);
  if (isProxyFailure(resolved)) return resolved;

  const maxDur = resolved.provider.maxDurationSec ?? config?.media?.video?.maxDurationSec ?? 30;
  const seconds =
    typeof body.seconds === "number"
      ? body.seconds
      : typeof body.duration === "number"
        ? body.duration
        : undefined;
  if (seconds != null && seconds > maxDur) {
    const fail = mediaFail(
      "video_duration_exceeded",
      `Requested duration ${seconds}s exceeds maxDurationSec=${maxDur}`,
    );
    return { ok: false, status: fail.status, body: fail.body };
  }

  const maxConcurrent = resolved.provider.maxConcurrent ?? config?.media?.video?.maxConcurrent ?? 2;
  if (!store.tryAcquireSlot(maxConcurrent)) {
    const fail = mediaFail(
      "video_concurrency_limit",
      `Too many in-flight video jobs (max=${maxConcurrent})`,
    );
    return { ok: false, status: fail.status, body: fail.body };
  }

  const job = store.create({
    kind: "video",
    model: typeof body.model === "string" ? body.model : resolved.model,
    request: body,
    owner_key_id: options?.ownerKeyId ?? "anonymous",
  });

  void runVideoJob(job.id, body, resolved, store).finally(() => store.releaseSlot());

  return {
    ok: true,
    status: 202,
    json: store.get(job.id),
  };
}

async function runVideoJob(
  jobId: string,
  body: Record<string, unknown>,
  resolved: ResolvedMediaProvider,
  store: ReturnType<typeof getMediaJobStore>,
): Promise<void> {
  store.update(jobId, { status: "processing" });
  const isAsyncUpstream = resolved.provider.response?.sync === false;
  const result = await executeMediaProvider(resolved, body, { awaitAsync: isAsyncUpstream });
  if (!result.ok) {
    store.update(jobId, {
      status: "failed",
      error: { code: result.body.error.code, message: result.body.error.message },
    });
    return;
  }

  if (result.mediaUrl || result.b64) {
    store.update(jobId, {
      status: "completed",
      result: {
        url: result.mediaUrl,
        b64_json: result.b64,
        raw: result.json,
      },
    });
    return;
  }

  const json = result.json;
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const upstreamStatus = typeof obj.status === "string" ? obj.status : "";
    const upstreamId = typeof obj.id === "string" ? obj.id : undefined;
    const pollCfg = resolved.provider.response?.poll;
    if (
      !isAsyncUpstream &&
      upstreamId &&
      pollCfg &&
      (upstreamStatus === "queued" ||
        upstreamStatus === "processing" ||
        upstreamStatus === "in_progress" ||
        upstreamStatus === "pending")
    ) {
      store.update(jobId, { upstream_job_id: upstreamId });
      const secrets = resolveProviderSecrets(resolved.provider.auth, resolved);
      const polled = await pollMediaProvider(
        resolved.provider,
        pollCfg,
        secrets,
        { ...body, taskId: upstreamId, model: resolved.model },
        resolved.provider.timeoutMs ?? 120000,
      );
      if (!polled.ok) {
        store.update(jobId, {
          status: "failed",
          error: { code: polled.body.error.code, message: polled.body.error.message },
        });
        return;
      }
      store.update(jobId, {
        status: "completed",
        result: polled.mediaUrl || polled.b64
          ? { url: polled.mediaUrl, b64_json: polled.b64, raw: polled.json }
          : polled.json,
      });
      return;
    }
  }

  store.update(jobId, { status: "completed", result: json });
}

export function emptyMediaConfig(): MediaConfig {
  return {
    image: { baseUrl: "" },
    speech: { baseUrl: "" },
    transcription: { baseUrl: "" },
    video: { baseUrl: "" },
    rerank: { baseUrl: "" },
    providers: [],
    modelPresets: [],
  };
}
