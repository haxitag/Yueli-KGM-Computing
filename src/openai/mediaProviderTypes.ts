/**
 * Declarative media provider config: model presets × host endpoints.
 * Local and cloud hosts share the same schema; only baseUrl differs.
 */

export type MediaModality = "image" | "speech" | "transcription" | "video" | "rerank";

/** Model identity (Flux / Banana / SD / …) — not bound to a single host. */
export type MediaModelPreset = {
  id: string;
  modality: MediaModality;
  aliases?: string[];
  canonicalParams?: string[];
};

export type MediaAuthConfig =
  | { type: "none" }
  | { type: "bearer"; apiKey?: string; apiKeyEnv?: string }
  | { type: "token"; apiKey?: string; apiKeyEnv?: string }
  | { type: "query_key"; apiKey?: string; apiKeyEnv?: string; queryParam?: string }
  | {
      type: "ak_sk_jwt";
      accessKey?: string;
      secretKey?: string;
      accessKeyEnv?: string;
      secretKeyEnv?: string;
      /** JWT lifetime seconds (default 1800). */
      expiresInSec?: number;
    };

export type MediaHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type MediaCreateConfig = {
  method?: MediaHttpMethod;
  path: string;
  headers?: Record<string, string>;
  /**
   * When set, deep-render templates (`{{var}}` / `{{var|default}}`) into the body.
   * When omitted, the inbound OpenAI-shaped JSON body is forwarded (openai-compat).
   */
  body?: Record<string, unknown> | string;
  /** Query string templates merged onto the URL. */
  query?: Record<string, string>;
};

export type MediaPollConfig = {
  method?: MediaHttpMethod;
  path: string;
  headers?: Record<string, string>;
  intervalMs?: number;
  maxAttempts?: number;
  /** JSONPath to status string, e.g. `$.data.task_status`. */
  status?: string;
  successWhen?: string[];
  failWhen?: string[];
  /** JSONPath to result media URL after success. */
  mediaUrl?: string;
  b64?: string;
};

export type MediaResponseConfig = {
  /** Default true. When false, create response is treated as async task. */
  sync?: boolean;
  /** When true (default for openai-compat), return upstream JSON unchanged. */
  passthrough?: boolean;
  /** JSONPath → image/video/audio URL for normalized OpenAI-shaped responses. */
  mediaUrl?: string;
  b64?: string;
  /** JSONPath → upstream task id when sync=false. */
  taskId?: string;
  poll?: MediaPollConfig;
  /** Optional JSONPath for ASR text normalization. */
  text?: string;
};

/**
 * One host endpoint that can serve one or more model ids / globs.
 * `baseUrl` is always used (never hardcoded in executors).
 */
export type MediaProviderConfig = {
  id: string;
  modality: MediaModality;
  /** Model ids or globs (`flux-*`, `banana-*`). Empty = catch-all for modality when selected as default. */
  models?: string[];
  /** Lower = preferred when multiple hosts match (default 100). */
  priority?: number;
  baseUrl: string;
  auth?: MediaAuthConfig;
  timeoutMs?: number;
  create: MediaCreateConfig;
  response?: MediaResponseConfig;
  /** Video extras (also used when projecting legacy media.video). */
  maxDurationSec?: number;
  maxConcurrent?: number;
  resultMode?: "url" | "b64";
  enabled?: boolean;
};

export type ResolvedMediaProvider = {
  provider: MediaProviderConfig;
  /** Effective model id after preset alias resolution. */
  model?: string;
  /** True when projected from legacy media.image|speech|… */
  legacy: boolean;
  apiKey?: string;
  accessKey?: string;
  secretKey?: string;
};
