/**
 * Media provider registry: resolve by modality + model (+ optional provider id).
 * Legacy media.image|speech|… project to implicit openai-compat providers.
 */

import type { KgmConfig, MediaEndpointConfig, VideoMediaConfig } from "../core/configStore.js";
import type {
  MediaModality,
  MediaModelPreset,
  MediaProviderConfig,
  ResolvedMediaProvider,
} from "./mediaProviderTypes.js";

const KIND_TO_DEFAULT_PATH: Record<MediaModality, string> = {
  image: "/images/generations",
  speech: "/audio/speech",
  transcription: "/audio/transcriptions",
  video: "/videos/generations",
  rerank: "/rerank",
};

const ENV_PREFIX: Record<MediaModality, string> = {
  image: "KGM_IMAGE",
  speech: "KGM_TTS",
  transcription: "KGM_STT",
  video: "KGM_VIDEO",
  rerank: "KGM_RERANK",
};

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function matchModelGlob(pattern: string, model: string): boolean {
  if (pattern === "*" || pattern === model) return true;
  if (pattern.endsWith("*")) {
    return model.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith("*")) {
    return model.endsWith(pattern.slice(1));
  }
  return false;
}

export function resolvePresetAlias(
  model: string | undefined,
  presets: MediaModelPreset[] | undefined,
  modality: MediaModality,
): string | undefined {
  if (!model) return undefined;
  if (!presets?.length) return model;
  for (const p of presets) {
    if (p.modality !== modality) continue;
    if (p.id === model) return p.id;
    if (p.aliases?.some((a) => a === model || matchModelGlob(a, model))) return p.id;
  }
  return model;
}

function readLegacyEndpoint(
  modality: MediaModality,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  path: string;
  timeoutMs: number;
  maxDurationSec?: number;
  maxConcurrent?: number;
  resultMode?: "url" | "b64";
  statusPath?: string;
} | null {
  const prefix = ENV_PREFIX[modality];
  const fromConfig = config?.media?.[modality] as MediaEndpointConfig | VideoMediaConfig | undefined;
  let baseUrl = process.env[`${prefix}_BASE_URL`]?.trim() || fromConfig?.baseUrl?.trim() || "";
  let apiKey = process.env[`${prefix}_API_KEY`]?.trim() || fromConfig?.apiKey?.trim() || undefined;
  let model = process.env[`${prefix}_MODEL`]?.trim() || fromConfig?.model?.trim() || undefined;
  const path =
    process.env[`${prefix}_PATH`]?.trim() || fromConfig?.path?.trim() || KIND_TO_DEFAULT_PATH[modality];
  const timeoutRaw =
    process.env[`${prefix}_TIMEOUT_MS`]?.trim() ||
    (fromConfig?.timeoutMs != null ? String(fromConfig.timeoutMs) : "");
  const timeoutMs = Number.parseInt(timeoutRaw || "120000", 10);

  if (process.env.KGM_MEDIA_USE_LLM_CREDENTIALS === "1" && config?.llm) {
    if (!baseUrl) baseUrl = config.llm.baseUrl?.trim() || "";
    if (!apiKey) apiKey = config.llm.apiKey?.trim() || undefined;
  }
  if (!baseUrl) return null;

  const fromVideo = modality === "video" ? (config?.media?.video as VideoMediaConfig | undefined) : undefined;
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
    maxConcurrent:
      Number.isFinite(maxConcEnv) && maxConcEnv > 0 ? maxConcEnv : fromVideo?.maxConcurrent,
    resultMode: fromVideo?.resultMode,
    statusPath:
      process.env.KGM_VIDEO_STATUS_PATH?.trim() || fromVideo?.statusPath?.trim() || undefined,
  };
}

/** Project legacy single-upstream config into an openai-compat MediaProviderConfig. */
export function projectLegacyProvider(
  modality: MediaModality,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): ResolvedMediaProvider | null {
  const legacy = readLegacyEndpoint(modality, config);
  if (!legacy) return null;

  const poll =
    modality === "video" && legacy.statusPath
      ? {
          method: "GET" as const,
          path: legacy.statusPath.replace("{id}", "{{taskId}}"),
          intervalMs: 1500,
          maxAttempts: 200,
          status: "$.status",
          successWhen: ["completed", "succeeded", "ready"],
          failWhen: ["failed", "error"],
          mediaUrl: "$.url",
        }
      : undefined;

  const provider: MediaProviderConfig = {
    id: `legacy-${modality}`,
    modality,
    models: legacy.model ? [legacy.model, "*"] : ["*"],
    priority: 1000,
    baseUrl: legacy.baseUrl,
    auth: legacy.apiKey ? { type: "bearer", apiKey: legacy.apiKey } : { type: "none" },
    timeoutMs: legacy.timeoutMs,
    create: {
      method: "POST",
      path: legacy.path,
    },
    response: {
      // Host still wraps video in kgm.media_job; upstream create may be sync or async.
      sync: true,
      passthrough: true,
      ...(poll
        ? {
            sync: false,
            taskId: "$.id",
            poll,
          }
        : {}),
    },
    maxDurationSec: legacy.maxDurationSec,
    maxConcurrent: legacy.maxConcurrent,
    resultMode: legacy.resultMode,
  };

  return {
    provider,
    model: legacy.model,
    legacy: true,
    apiKey: legacy.apiKey,
  };
}

function listConfiguredProviders(
  modality: MediaModality,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): MediaProviderConfig[] {
  const fromConfig = (config?.media?.providers ?? []).filter(
    (p) => p && p.enabled !== false && p.modality === modality && Boolean(p.baseUrl?.trim()),
  );
  return fromConfig.map((p) => ({
    ...p,
    baseUrl: trimBase(p.baseUrl),
    priority: p.priority ?? 100,
  }));
}

export type ResolveMediaProviderOptions = {
  /** Explicit provider id from body.provider / body.kgm_provider. */
  providerId?: string;
  model?: string;
};

/**
 * Resolve which host endpoint to use for a modality request.
 * Preference: explicit provider id → matching declarative providers → legacy single upstream.
 */
export function resolveMediaProvider(
  modality: MediaModality,
  body: Record<string, unknown>,
  config?: Pick<KgmConfig, "media" | "llm"> | null,
  options?: ResolveMediaProviderOptions,
): ResolvedMediaProvider | null {
  const providerId =
    options?.providerId ||
    (typeof body.provider === "string" ? body.provider : undefined) ||
    (typeof body.kgm_provider === "string" ? body.kgm_provider : undefined);

  const rawModel =
    options?.model ||
    (typeof body.model === "string" ? body.model : undefined);

  const presets = config?.media?.modelPresets;
  const model = resolvePresetAlias(rawModel, presets, modality);

  const providers = listConfiguredProviders(modality, config);

  if (providerId) {
    const hit = providers.find((p) => p.id === providerId);
    if (hit) {
      return {
        provider: hit,
        model: model || hit.models?.[0],
        legacy: false,
        apiKey: hit.auth && "apiKey" in hit.auth ? hit.auth.apiKey : undefined,
      };
    }
    // explicit id may refer to legacy
    if (providerId === `legacy-${modality}`) {
      return projectLegacyProvider(modality, config);
    }
    // Explicit unknown id must not silently fall through to model/legacy match.
    return null;
  }

  if (providers.length > 0) {
    const modelKey = model || "";
    const matched = providers
      .filter((p) => {
        const patterns = p.models?.length ? p.models : ["*"];
        if (!modelKey) return patterns.includes("*");
        return patterns.some((pat) => matchModelGlob(pat, modelKey));
      })
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    if (matched.length > 0) {
      const hit = matched[0]!;
      return {
        provider: hit,
        model: model || undefined,
        legacy: false,
        apiKey: hit.auth && "apiKey" in hit.auth ? hit.auth.apiKey : undefined,
      };
    }

    // Declarative providers exist but none matched this model — try legacy fallback
    const legacy = projectLegacyProvider(modality, config);
    if (legacy) return legacy;
    return null;
  }

  return projectLegacyProvider(modality, config);
}

/** List models exposed via presets + providers + legacy for /v1/models. */
export function listMediaProviderModels(
  config?: Pick<KgmConfig, "media" | "llm"> | null,
): Array<{
  id: string;
  capabilities: string[];
  model_type: string;
  kind: MediaModality;
  providerIds: string[];
}> {
  const capByModality: Record<MediaModality, { cap: string; modelType: string }> = {
    image: { cap: "image_generation", modelType: "image_generation" },
    speech: { cap: "text_to_speech", modelType: "text_to_speech" },
    transcription: { cap: "speech_to_text", modelType: "speech_to_text" },
    video: { cap: "video_generation", modelType: "video_generation" },
    rerank: { cap: "rerank", modelType: "task_specific" },
  };

  const byId = new Map<
    string,
    { id: string; capabilities: string[]; model_type: string; kind: MediaModality; providerIds: string[] }
  >();

  const add = (id: string, kind: MediaModality, providerId: string) => {
    const meta = capByModality[kind];
    const existing = byId.get(id);
    if (existing) {
      if (!existing.providerIds.includes(providerId)) existing.providerIds.push(providerId);
      return;
    }
    byId.set(id, {
      id,
      capabilities: [meta.cap],
      model_type: meta.modelType,
      kind,
      providerIds: [providerId],
    });
  };

  for (const preset of config?.media?.modelPresets ?? []) {
    add(preset.id, preset.modality, "preset");
    for (const a of preset.aliases ?? []) {
      if (!a.includes("*")) add(a, preset.modality, "preset");
    }
  }

  for (const modality of Object.keys(capByModality) as MediaModality[]) {
    for (const p of listConfiguredProviders(modality, config)) {
      const models = p.models?.filter((m) => m !== "*") ?? [];
      if (models.length === 0) {
        add(`kgm-${modality}`, modality, p.id);
      } else {
        for (const m of models) {
          if (!m.includes("*")) add(m, modality, p.id);
        }
      }
    }
    const legacy = projectLegacyProvider(modality, config);
    if (legacy) {
      add(legacy.model || `kgm-${modality}`, modality, legacy.provider.id);
    }
  }

  return [...byId.values()];
}
