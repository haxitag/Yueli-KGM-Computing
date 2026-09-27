import { generateId } from "../utils/id.js";
import { LlmProviderApiError, parseHttpStatusFromErrorMessage } from "../llm/providerApiError.js";
import { canonicalizePublicErrorStatus } from "../utils/kgmHttpErrors.js";

export type KgmStandardErrorCode =
  | "EMBEDDING_API_KEY_MISSING"
  | "LLM_API_KEY_MISSING"
  | "LLM_UPSTREAM_UNREACHABLE"
  | "LLM_UPSTREAM_ERROR"
  | "CIRCUIT_BREAKER_OPEN"
  | "PROVIDER_NOT_CONFIGURED"
  | "ROUTE_NO_CANDIDATE"
  | "NATIVE_MODEL_NOT_LOADED"
  | "MOCK_MODE_ACTIVE_FOR_PROD"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST";

export type KgmStructuredErrorOptions = {
  code: KgmStandardErrorCode | string;
  message: string;
  type?: string;
  param?: string | null;
  status?: number;
  details?: Record<string, unknown>;
  stage: string;
  path?: string | null;
  routeAttempted?: boolean;
  selectedRoute?: string | null;
  suggestedFix: string;
  affectedFeatures?: string[];
  traceId?: string;
};

export class KgmStructuredError extends Error {
  readonly code: string;
  readonly type: string;
  readonly param: string | null;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly kgm: {
    stage: string;
    path: string | null;
    routeAttempted: boolean;
    selectedRoute: string | null;
    suggestedFix: string;
    affectedFeatures: string[];
    traceId: string;
    logRef: string;
  };

  constructor(options: KgmStructuredErrorOptions) {
    super(options.message || options.code);
    this.name = "KgmStructuredError";
    this.code = options.code;
    this.type = options.type ?? defaultErrorType(options.code);
    this.param = options.param ?? null;
    this.status = options.status ?? defaultStatus(options.code);
    this.details = options.details ?? {};
    const traceId = options.traceId ?? generateId("req");
    this.kgm = {
      stage: options.stage || "runtime.unknown",
      path: options.path ?? null,
      routeAttempted: options.routeAttempted ?? false,
      selectedRoute: options.selectedRoute ?? null,
      suggestedFix: options.suggestedFix || "Inspect /v1/runtime/diagnostics for configuration guidance.",
      affectedFeatures: options.affectedFeatures ?? [],
      traceId,
      logRef: `/v1/logs?trace=${traceId}`,
    };
  }
}

export function structuredErrorBody(error: KgmStructuredError | Error | unknown): {
  error: {
    code: string;
    message: string;
    status: number;
    type: string;
    param: string | null;
    details: Record<string, unknown>;
    kgm: KgmStructuredError["kgm"];
  };
} {
  const structured = toKgmStructuredError(error);
  return {
    error: {
      code: structured.code || "INTERNAL_ERROR",
      message: structured.message || "KGM internal error",
      status: canonicalizePublicErrorStatus(structured.status),
      type: structured.type || "kgm_internal_error",
      param: structured.param,
      details: structured.details,
      kgm: {
        ...structured.kgm,
        stage: structured.kgm.stage || "runtime.unknown",
        suggestedFix: structured.kgm.suggestedFix || "Inspect /v1/runtime/diagnostics for configuration guidance.",
      },
    },
  };
}

/** Host-facing envelope: KgmError fields + structured type/kgm; vendor status only in details. */
export function toHostKgmError(error: unknown): {
  status: number;
  body: ReturnType<typeof structuredErrorBody>;
} {
  if (error instanceof LlmProviderApiError && error.httpStatus != null) {
    const structured = toKgmStructuredError(error);
    const body = structuredErrorBody(structured);
    return { status: body.error.status, body };
  }
  const structured = toKgmStructuredError(error);
  const body = structuredErrorBody(structured);
  return { status: body.error.status, body };
}

export function toKgmStructuredError(error: KgmStructuredError | Error | unknown): KgmStructuredError {
  if (error instanceof KgmStructuredError) {
    return error;
  }
  if (error instanceof LlmProviderApiError) {
    const upstreamStatus = error.httpStatus;
    if (upstreamStatus != null) {
      return new KgmStructuredError({
        code: "LLM_UPSTREAM_ERROR",
        message: error.message || "LLM upstream returned an error",
        type: "kgm_upstream_error",
        status: 502,
        details: {
          upstreamStatus,
          provider: error.provider,
          ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
        },
        stage: "inference.llm_provider",
        path: "llmProvider",
        routeAttempted: true,
        suggestedFix:
          "Check provider credentials/baseUrl; vendor HTTP status is in error.details.upstreamStatus (not the host HTTP code).",
        affectedFeatures: ["chat", "completions", "responses"],
      });
    }
    return new KgmStructuredError({
      code: "LLM_UPSTREAM_UNREACHABLE",
      message: error.message || "LLM upstream is unreachable",
      type: "kgm_upstream_error",
      status: 502,
      details: { provider: error.provider },
      stage: "inference.llm_provider",
      path: "llmProvider",
      routeAttempted: true,
      suggestedFix: "Check KGM_LLM_BASE_URL, KGM_LLM_PATH, network reachability, and /v1/runtime/discovery.",
      affectedFeatures: ["chat", "completions", "responses"],
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const parsedStatus = parseHttpStatusFromErrorMessage(message);
  if (parsedStatus != null && parsedStatus >= 400) {
    return new KgmStructuredError({
      code: "LLM_UPSTREAM_ERROR",
      message: message || "LLM upstream returned an error",
      type: "kgm_upstream_error",
      status: 502,
      details: { upstreamStatus: parsedStatus },
      stage: "inference.llm_provider",
      path: "llmProvider",
      routeAttempted: true,
      suggestedFix:
        "Vendor HTTP status is in error.details.upstreamStatus; host always returns 502 for upstream failures.",
      affectedFeatures: ["chat", "completions", "responses"],
    });
  }
  const lower = message.toLowerCase();
  if (lower.includes("embedding") && lower.includes("apikey")) {
    return new KgmStructuredError({
      code: "EMBEDDING_API_KEY_MISSING",
      message: "Embedding provider is openai but apiKey is missing",
      type: "kgm_configuration_error",
      param: "KGM_EMBEDDING_API_KEY",
      status: 500,
      stage: "context.memory_search",
      path: "llmProvider",
      routeAttempted: true,
      suggestedFix: "Set KGM_EMBEDDING_* environment variables, or disable memory retrieval via options.memory=false",
      affectedFeatures: ["memory_search", "rag", "context_builder"],
    });
  }
  if (lower.includes("llm") && lower.includes("apikey")) {
    return new KgmStructuredError({
      code: "LLM_API_KEY_MISSING",
      message: "LLM provider is openai but apiKey is missing",
      type: "kgm_configuration_error",
      param: "KGM_LLM_API_KEY",
      status: 500,
      stage: "inference.llm_provider",
      path: "llmProvider",
      routeAttempted: true,
      suggestedFix: "Set KGM_LLM_API_KEY, or point KGM_LLM_BASE_URL to an OpenAI-compatible local engine.",
      affectedFeatures: ["chat", "completions", "responses"],
    });
  }
  if (lower.includes("breaker is open") || (lower.includes("circuit") && lower.includes("open"))) {
    return new KgmStructuredError({
      code: "CIRCUIT_BREAKER_OPEN",
      message: message || "LLM upstream circuit breaker is open",
      type: "kgm_upstream_error",
      status: 503,
      stage: "inference.llm_provider",
      path: "llmProvider",
      routeAttempted: true,
      suggestedFix:
        "Wait for circuit reset (KGM_CIRCUIT_BREAKER_RESET_TIMEOUT_MS) and verify upstream health via /v1/runtime/diagnostics.",
      affectedFeatures: ["chat", "completions", "responses"],
    });
  }
  if (lower.includes("fetch") || lower.includes("econnrefused") || lower.includes("upstream") || lower.includes("abort")) {
    return new KgmStructuredError({
      code: "LLM_UPSTREAM_UNREACHABLE",
      message: message || "LLM upstream is unreachable",
      type: "kgm_upstream_error",
      status: 502,
      stage: "inference.llm_provider",
      path: "llmProvider",
      routeAttempted: true,
      suggestedFix: "Check KGM_LLM_BASE_URL, KGM_LLM_PATH, network reachability, and /v1/runtime/discovery.",
      affectedFeatures: ["chat", "completions", "responses"],
    });
  }
  return new KgmStructuredError({
    code: "INTERNAL_ERROR",
    message: message || "KGM internal error",
    type: "kgm_internal_error",
    status: 500,
    stage: "runtime.internal",
    suggestedFix: "Inspect server logs and /v1/runtime/diagnostics for the failing stage.",
  });
}

function defaultStatus(code: string): number {
  if (code === "ROUTE_NO_CANDIDATE" || code === "PROVIDER_NOT_CONFIGURED" || code === "NATIVE_MODEL_NOT_LOADED") {
    return 400;
  }
  if (code === "LLM_UPSTREAM_UNREACHABLE" || code === "LLM_UPSTREAM_ERROR") {
    return 502;
  }
  if (code === "CIRCUIT_BREAKER_OPEN") {
    return 503;
  }
  return 500;
}

function defaultErrorType(code: string): string {
  if (code.includes("API_KEY") || code === "PROVIDER_NOT_CONFIGURED" || code === "MOCK_MODE_ACTIVE_FOR_PROD") {
    return "kgm_configuration_error";
  }
  if (code.includes("UPSTREAM")) {
    return "kgm_upstream_error";
  }
  return "kgm_runtime_error";
}
