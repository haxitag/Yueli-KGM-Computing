/**
 * Media API error catalog + helpers.
 * Host-facing status codes are KGM-owned; vendor HTTP codes only appear in details.upstreamStatus.
 */

import {
  extractVendorErrorMessage,
  kgmFail,
  kgmUpstreamFail,
  type KgmFailResult,
} from "../utils/kgmHttpErrors.js";

/** Documented media error codes (OpenAPI / media-api.md). */
export const MEDIA_ERROR_CODES = {
  image_generation_provider_not_configured: {
    status: 501,
    summary: "Image upstream not configured",
  },
  text_to_speech_provider_not_configured: {
    status: 501,
    summary: "TTS upstream not configured",
  },
  speech_to_text_provider_not_configured: {
    status: 501,
    summary: "STT upstream not configured",
  },
  video_generation_provider_not_configured: {
    status: 501,
    summary: "Video upstream not configured",
  },
  rerank_provider_not_configured: {
    status: 501,
    summary: "Rerank upstream not configured",
  },
  media_provider_not_found: {
    status: 400,
    summary: "Explicit media.providers id unknown",
  },
  media_template_missing_var: {
    status: 400,
    summary: "Required template variable missing",
  },
  video_duration_exceeded: {
    status: 400,
    summary: "Requested duration exceeds maxDurationSec",
  },
  video_concurrency_limit: {
    status: 429,
    summary: "Too many in-flight video jobs",
  },
  job_not_found: {
    status: 404,
    summary: "Unknown media job id",
  },
  media_upstream_error: {
    status: 502,
    summary: "Upstream returned an error (vendor status in details.upstreamStatus)",
  },
  media_upstream_unreachable: {
    status: 502,
    summary: "Upstream network/timeout before HTTP response",
  },
  media_upstream_failed: {
    status: 502,
    summary: "Async upstream task failed",
  },
  media_async_misconfigured: {
    status: 502,
    summary: "Async provider missing poll config",
  },
  media_async_missing_task_id: {
    status: 502,
    summary: "Upstream create response missing task id",
  },
  media_poll_timeout: {
    status: 504,
    summary: "Async poll exhausted",
  },
  video_upstream_failed: {
    status: 502,
    summary: "Video job upstream failed",
  },
  video_poll_timeout: {
    status: 504,
    summary: "Video job poll timeout",
  },
} as const;

export type MediaErrorCode = keyof typeof MEDIA_ERROR_CODES;

export function mediaFail(
  code: MediaErrorCode,
  message?: string,
  details?: { upstreamStatus?: number; providerId?: string; cause?: string },
): KgmFailResult {
  const meta = MEDIA_ERROR_CODES[code];
  return kgmFail(code, message ?? meta.summary, meta.status, details);
}

/** Normalize any vendor HTTP failure into media_upstream_error @ 502. */
export function mediaUpstreamHttpFail(
  upstreamStatus: number,
  jsonOrText: unknown,
  providerId?: string,
): KgmFailResult {
  const message = extractVendorErrorMessage(
    jsonOrText,
    `Upstream failed with HTTP ${upstreamStatus}`,
  );
  return kgmUpstreamFail("media_upstream_error", message, upstreamStatus, {
    ...(providerId ? { providerId } : {}),
  });
}
