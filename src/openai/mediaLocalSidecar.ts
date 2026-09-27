/**
 * Sidecar convention: expose OpenAI-shaped /v1/audio/transcriptions in front of
 * video-audio-URL2txt (/api/transcribe), then point KGM_STT_* or media.providers at it.
 *
 * Example env:
 *   KGM_STT_BASE_URL=http://127.0.0.1:48689/v1
 *   KGM_STT_PATH=/audio/transcriptions
 *   KGM_STT_MODEL=whisper-large-v3-turbo
 *
 * Or copy `local-stt-sidecar` from docs/media-providers.examples.json into config.media.providers.
 *
 * Avoid cycles: if the ASR app also calls KGM for LLM polish, do not route STT back into the same loop.
 */

export const VIDEO_AUDIO_URL2TXT_SIDECAR = {
  id: "local-stt-sidecar",
  modality: "transcription" as const,
  models: ["whisper-large-v3-turbo", "whisper*"],
  priority: 10,
  baseUrl: "http://127.0.0.1:48689/v1",
  auth: { type: "none" as const },
  timeoutMs: 600_000,
  create: { method: "POST" as const, path: "/audio/transcriptions" },
  response: { sync: true, passthrough: true, text: "$.text" },
};
