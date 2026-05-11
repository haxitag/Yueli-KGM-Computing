import { generateId } from "../utils/id.js";

export type KgmStandardErrorCode =
  | "EMBEDDING_API_KEY_MISSING"
  | "LLM_API_KEY_MISSING"
  | "LLM_UPSTREAM_UNREACHABLE"
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

export function toKgmStructuredError(error: KgmStructuredError | Error | unknown): KgmStructuredError {
  if (error instanceof KgmStructuredError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
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
  if (lower.includes("fetch") || lower.includes("econnrefused") || lower.includes("upstream")) {
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
  if (code === "LLM_UPSTREAM_UNREACHABLE") {
    return 502;
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
