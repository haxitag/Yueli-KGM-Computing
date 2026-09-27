/**
 * Declarative HTTP template executor for media providers:
 * render templates → auth → fetch → JSONPath extract → optional poll.
 */

import { createHmac } from "node:crypto";
import { kgmErrorBody, kgmFail, type KgmErrorBody } from "../utils/kgmHttpErrors.js";
import { mediaUpstreamHttpFail } from "./mediaErrors.js";
import type {
  MediaAuthConfig,
  MediaCreateConfig,
  MediaHttpMethod,
  MediaPollConfig,
  MediaProviderConfig,
  ResolvedMediaProvider,
} from "./mediaProviderTypes.js";

export type MediaExecResult =
  | { ok: true; status: number; json?: unknown; binary?: Buffer; contentType?: string; mediaUrl?: string; b64?: string; text?: string }
  | { ok: false; status: number; body: KgmErrorBody };

export type TemplateContext = Record<string, unknown>;

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*([^}]*))?\s*\}\}/g;

export function renderTemplateString(input: string, ctx: TemplateContext): string {
  return input.replace(TEMPLATE_RE, (_full, key: string, def?: string) => {
    const value = lookupCtx(ctx, key);
    if (value === undefined || value === null || value === "") {
      if (def !== undefined) return def.trim();
      throw Object.assign(new Error(`Missing template variable: ${key}`), {
        code: "media_template_missing_var",
        status: 400,
        varName: key,
      });
    }
    return String(value);
  });
}

function lookupCtx(ctx: TemplateContext, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key];
  if (key.includes(".")) {
    const parts = key.split(".");
    let cur: unknown = ctx;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }
  return undefined;
}

export function renderTemplateValue(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const rendered = renderTemplateString(value, ctx);
    if (/^-?\d+(\.\d+)?$/.test(rendered) && /^\{\{/.test(value.trim())) {
      const n = Number(rendered);
      if (Number.isFinite(n)) return n;
    }
    if (rendered === "true") return true;
    if (rendered === "false") return false;
    return rendered;
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplateValue(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderTemplateValue(v, ctx);
    }
    return out;
  }
  return value;
}

/**
 * Minimal JSONPath: `$.a.b[0].c` / `$['a']['b']`.
 */
export function jsonPathGet(root: unknown, pathExpr: string | undefined): unknown {
  if (!pathExpr || !pathExpr.trim()) return undefined;
  let expr = pathExpr.trim();
  if (expr === "$") return root;
  if (expr.startsWith("$.")) expr = expr.slice(2);
  else if (expr.startsWith("$[")) expr = expr.slice(1);
  else if (expr.startsWith("$")) expr = expr.slice(1);

  const tokens: Array<string | number> = [];
  const re = /\[(\d+)\]|\['([^']+)'\]|\["([^"]+)"\]|\.([a-zA-Z0-9_-]+)|([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    if (m[1] != null) tokens.push(Number(m[1]));
    else if (m[2] != null) tokens.push(m[2]);
    else if (m[3] != null) tokens.push(m[3]);
    else if (m[4] != null) tokens.push(m[4]);
    else if (m[5] != null) tokens.push(m[5]);
  }
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (typeof t === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur;
}

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

export function joinMediaUrl(baseUrl: string, path: string): string {
  const base = trimBase(baseUrl);
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && p.startsWith("/v1/")) {
    return `${base}${p.slice(3)}`;
  }
  return `${base}${p}`;
}

function assertHttpBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Object.assign(new Error(`Invalid media provider baseUrl: ${baseUrl}`), {
      code: "media_invalid_base_url",
      status: 400,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Object.assign(new Error(`media provider baseUrl must be http(s), got ${parsed.protocol}`), {
      code: "media_invalid_base_url",
      status: 400,
    });
  }
}

export function resolveProviderSecrets(
  auth: MediaAuthConfig | undefined,
  resolved: ResolvedMediaProvider,
): { apiKey?: string; accessKey?: string; secretKey?: string } {
  if (!auth || auth.type === "none") return {};
  if (auth.type === "bearer" || auth.type === "token" || auth.type === "query_key") {
    const fromEnv = auth.apiKeyEnv ? process.env[auth.apiKeyEnv]?.trim() : undefined;
    return { apiKey: fromEnv || auth.apiKey?.trim() || resolved.apiKey };
  }
  if (auth.type === "ak_sk_jwt") {
    const accessKey =
      (auth.accessKeyEnv ? process.env[auth.accessKeyEnv]?.trim() : undefined) ||
      auth.accessKey?.trim() ||
      resolved.accessKey;
    const secretKey =
      (auth.secretKeyEnv ? process.env[auth.secretKeyEnv]?.trim() : undefined) ||
      auth.secretKey?.trim() ||
      resolved.secretKey;
    return { accessKey, secretKey };
  }
  const _exhaustive: never = auth;
  return _exhaustive;
}

/** Minimal HS256 JWT for Kling-style AK/SK. */
export function signAkSkJwt(accessKey: string, secretKey: string, expiresInSec = 1800): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss: accessKey, iat: now, nbf: now - 5, exp: now + expiresInSec }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", secretKey).update(data).digest("base64url");
  return `${data}.${sig}`;
}

async function applyAuthHeaders(
  headers: Record<string, string>,
  url: URL,
  auth: MediaAuthConfig | undefined,
  secrets: { apiKey?: string; accessKey?: string; secretKey?: string },
): Promise<void> {
  if (!auth || auth.type === "none") return;
  if (auth.type === "bearer") {
    if (secrets.apiKey) headers.authorization = `Bearer ${secrets.apiKey}`;
    return;
  }
  if (auth.type === "token") {
    if (secrets.apiKey) headers.authorization = `Token ${secrets.apiKey}`;
    return;
  }
  if (auth.type === "query_key") {
    const param = auth.queryParam || "key";
    if (secrets.apiKey) url.searchParams.set(param, secrets.apiKey);
    return;
  }
  if (auth.type === "ak_sk_jwt") {
    if (!secrets.accessKey || !secrets.secretKey) {
      throw Object.assign(new Error("ak_sk_jwt requires accessKey and secretKey"), {
        code: "media_auth_incomplete",
        status: 401,
      });
    }
    const token = signAkSkJwt(secrets.accessKey, secrets.secretKey, auth.expiresInSec ?? 1800);
    headers.authorization = `Bearer ${token}`;
    return;
  }
  const _exhaustive: never = auth;
  void _exhaustive;
}

function buildContext(
  body: Record<string, unknown>,
  resolved: ResolvedMediaProvider,
  extra?: TemplateContext,
): TemplateContext {
  const model = resolved.model ?? (typeof body.model === "string" ? body.model : undefined);
  return {
    ...body,
    model,
    provider: resolved.provider.id,
    size: body.size ?? body.image_size,
    steps: body.steps ?? body.num_inference_steps,
    n: body.n ?? 1,
    prompt: body.prompt ?? body.input,
    ...extra,
  };
}

function errorFromThrown(err: unknown): MediaExecResult {
  if (err && typeof err === "object" && "code" in err && "status" in err) {
    const e = err as { code: string; status: number; message?: string; varName?: string };
    const fail = kgmFail(
      e.code,
      e.message || (e.varName ? `Missing required field for template: ${e.varName}` : "media provider error"),
      e.status,
    );
    return { ok: false, status: fail.status, body: fail.body };
  }
  const message = err instanceof Error ? err.message : String(err);
  const fail = kgmFail("media_upstream_unreachable", message, 502);
  return { ok: false, status: fail.status, body: fail.body };
}

async function httpOnce(params: {
  baseUrl: string;
  method: MediaHttpMethod;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  auth?: MediaAuthConfig;
  secrets: { apiKey?: string; accessKey?: string; secretKey?: string };
  timeoutMs: number;
  ctx: TemplateContext;
  expectBinary?: boolean;
}): Promise<MediaExecResult> {
  assertHttpBaseUrl(params.baseUrl);
  const renderedPath = renderTemplateString(params.path, params.ctx);
  const url = new URL(joinMediaUrl(params.baseUrl, renderedPath));
  if (params.query) {
    for (const [k, v] of Object.entries(params.query)) {
      url.searchParams.set(k, renderTemplateString(v, params.ctx));
    }
  }
  const headers: Record<string, string> = { ...(params.headers ?? {}) };
  for (const [k, v] of Object.entries(headers)) {
    headers[k] = renderTemplateString(v, params.ctx);
  }
  await applyAuthHeaders(headers, url, params.auth, params.secrets);

  let bodyInit: BodyInit | undefined;
  if (params.body !== undefined && params.method !== "GET" && params.method !== "DELETE") {
    if (typeof params.body === "string") {
      bodyInit = renderTemplateString(params.body, params.ctx);
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json";
      }
    } else {
      const rendered = renderTemplateValue(params.body, params.ctx);
      bodyInit = JSON.stringify(rendered);
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json";
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: params.method,
      headers,
      body: bodyInit,
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    const treatAsBinary =
      (params.expectBinary && !contentType.includes("json") && !contentType.includes("text/")) ||
      (contentType.startsWith("audio/") && !contentType.includes("json"));
    if (treatAsBinary) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const fail = mediaUpstreamHttpFail(res.status, `Upstream failed with HTTP ${res.status}`);
        return { ok: false, status: fail.status, body: fail.body };
      }
      return { ok: true, status: res.status, binary: buf, contentType: contentType || "application/octet-stream" };
    }
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      const fail = mediaUpstreamHttpFail(res.status, json);
      return { ok: false, status: fail.status, body: fail.body };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    return errorFromThrown(err);
  } finally {
    clearTimeout(timer);
  }
}

export async function pollMediaProvider(
  provider: MediaProviderConfig,
  poll: MediaPollConfig,
  secrets: { apiKey?: string; accessKey?: string; secretKey?: string },
  ctx: TemplateContext,
  timeoutMs: number,
): Promise<MediaExecResult> {
  const intervalMs = poll.intervalMs ?? 2000;
  const maxAttempts = poll.maxAttempts ?? 60;
  const successWhen = (poll.successWhen ?? ["succeeded", "SUCCEEDED", "completed", "COMPLETED", "ready", "SUCCESS"]).map(
    (s) => s.toLowerCase(),
  );
  const failWhen = (poll.failWhen ?? ["failed", "FAILED", "error", "ERROR", "canceled", "CANCELLED"]).map((s) =>
    s.toLowerCase(),
  );

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await httpOnce({
      baseUrl: provider.baseUrl,
      method: poll.method ?? "GET",
      path: poll.path,
      headers: { accept: "application/json", ...(poll.headers ?? {}) },
      auth: provider.auth,
      secrets,
      timeoutMs,
      ctx,
    });
    if (!result.ok) return result;
    const statusRaw = poll.status ? jsonPathGet(result.json, poll.status) : undefined;
    const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : "";
    if (status && failWhen.includes(status)) {
      return {
        ok: false,
        status: 502,
        body: kgmErrorBody("media_upstream_failed", `Upstream task status=${statusRaw}`, 502),
      };
    }
    if (!status || successWhen.includes(status)) {
      const mediaUrl = poll.mediaUrl ? jsonPathGet(result.json, poll.mediaUrl) : undefined;
      const b64 = poll.b64 ? jsonPathGet(result.json, poll.b64) : undefined;
      return {
        ok: true,
        status: 200,
        json: result.json,
        mediaUrl: typeof mediaUrl === "string" ? mediaUrl : undefined,
        b64: typeof b64 === "string" ? b64 : undefined,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    ok: false,
    status: 504,
    body: kgmErrorBody("media_poll_timeout", `Timed out after ${maxAttempts} poll attempts`, 504),
  };
}

export type ExecuteMediaOptions = {
  /** Override create.path (e.g. /images/edits). */
  pathOverride?: string;
  /** Prefer binary response (TTS). */
  expectBinary?: boolean;
  /** Extra template vars (e.g. taskId). */
  extraCtx?: TemplateContext;
  /** When true, run async poll inline and return final media (used inside job runner). */
  awaitAsync?: boolean;
};

/**
 * Execute a resolved media provider create call (and optional poll when awaitAsync).
 */
export async function executeMediaProvider(
  resolved: ResolvedMediaProvider,
  body: Record<string, unknown>,
  options?: ExecuteMediaOptions,
): Promise<MediaExecResult> {
  const provider = resolved.provider;
  try {
    assertHttpBaseUrl(provider.baseUrl);
  } catch (err) {
    return errorFromThrown(err);
  }

  const secrets = resolveProviderSecrets(provider.auth, resolved);
  const timeoutMs = provider.timeoutMs ?? 120_000;
  const ctx = buildContext(body, resolved, options?.extraCtx);
  const create: MediaCreateConfig = {
    ...provider.create,
    path: options?.pathOverride ?? provider.create.path,
  };

  let requestBody: unknown;
  if (create.body !== undefined) {
    requestBody = create.body;
  } else {
    // openai-compat passthrough: inject default model when missing
    const payload = { ...body };
    if (resolved.model && payload.model == null) payload.model = resolved.model;
    requestBody = payload;
  }

  const createResult = await httpOnce({
    baseUrl: provider.baseUrl,
    method: create.method ?? "POST",
    path: create.path,
    headers: { accept: "application/json", ...(create.headers ?? {}) },
    query: create.query,
    body: requestBody,
    auth: provider.auth,
    secrets,
    timeoutMs,
    ctx,
    expectBinary: options?.expectBinary,
  });
  if (!createResult.ok) return createResult;
  if (createResult.binary) return createResult;

  const responseCfg = provider.response ?? { sync: true, passthrough: true };
  const sync = responseCfg.sync !== false;

  if (!sync) {
    const taskIdRaw = responseCfg.taskId ? jsonPathGet(createResult.json, responseCfg.taskId) : undefined;
    const taskId = taskIdRaw != null ? String(taskIdRaw) : undefined;
    if (!options?.awaitAsync) {
      return {
        ok: true,
        status: 202,
        json: createResult.json,
        mediaUrl: undefined,
        ...(taskId ? { text: taskId } : {}),
      };
    }
    if (!responseCfg.poll) {
      return {
        ok: false,
        status: 502,
        body: kgmErrorBody("media_async_misconfigured", "Async provider missing response.poll", 502),
      };
    }
    if (!taskId) {
      return {
        ok: false,
        status: 502,
        body: kgmErrorBody("media_async_missing_task_id", "Upstream create response missing task id", 502),
      };
    }
    const pollCtx = { ...ctx, taskId };
    return pollMediaProvider(provider, responseCfg.poll, secrets, pollCtx, timeoutMs);
  }

  if (responseCfg.passthrough !== false && !responseCfg.mediaUrl && !responseCfg.b64 && !responseCfg.text) {
    return createResult;
  }

  const mediaUrl = responseCfg.mediaUrl ? jsonPathGet(createResult.json, responseCfg.mediaUrl) : undefined;
  const b64 = responseCfg.b64 ? jsonPathGet(createResult.json, responseCfg.b64) : undefined;
  const text = responseCfg.text ? jsonPathGet(createResult.json, responseCfg.text) : undefined;

  return {
    ok: true,
    status: createResult.status,
    json: createResult.json,
    mediaUrl: typeof mediaUrl === "string" ? mediaUrl : undefined,
    b64: typeof b64 === "string" ? b64 : undefined,
    text: typeof text === "string" ? text : undefined,
  };
}

/** Normalize extracted media into OpenAI images.generations shape when paths configured. */
export function normalizeOpenAiImages(result: Extract<MediaExecResult, { ok: true }>): unknown {
  if (result.mediaUrl || result.b64) {
    const item: Record<string, unknown> = {};
    if (result.mediaUrl) item.url = result.mediaUrl;
    if (result.b64) item.b64_json = result.b64;
    return {
      created: Math.floor(Date.now() / 1000),
      data: [item],
    };
  }
  return result.json;
}

export function normalizeOpenAiTranscription(result: Extract<MediaExecResult, { ok: true }>): unknown {
  if (result.text) {
    return { text: result.text };
  }
  return result.json;
}
