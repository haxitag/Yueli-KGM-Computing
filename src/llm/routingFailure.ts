import { LlmProviderApiError, parseHttpStatusFromErrorMessage } from "./providerApiError.js";
import { modelsMatchByAlias } from "../models/cloudModelCatalog.js";

export type RoutingFailureClass =
  | "auth"
  | "payment"
  | "rate_limit"
  | "unavailable"
  | "context_window"
  | "content_policy"
  | "client"
  | "retryable";

export type RoutingFailure = {
  class: RoutingFailureClass;
  httpStatus?: number;
  retryable: boolean;
};

export type FailoverCandidate = {
  routeKey: string;
  model: string;
  source: string;
  provider?: string;
  score?: number;
};

function extractHttpStatus(error: unknown): number | undefined {
  if (error instanceof LlmProviderApiError && error.httpStatus != null) {
    return error.httpStatus;
  }
  if (error instanceof Error) {
    return parseHttpStatusFromErrorMessage(error.message);
  }
  return undefined;
}

/**
 * LiteLLM 把限流 / 窗口 / 安全 / 鉴权拆开再决定组内重试还是组间 fallback。
 * KGM 用同一套分类，供 AutoRouting 与 embed 重试共用。
 */
export function classifyRoutingFailure(error: unknown): RoutingFailure {
  const httpStatus = extractHttpStatus(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();

  if (httpStatus === 401 || httpStatus === 403 || /\b(unauthorized|invalid api key|authentication)\b/i.test(lower)) {
    return { class: "auth", httpStatus, retryable: false };
  }
  if (httpStatus === 402 || /insufficient.*balance|payment required/.test(lower)) {
    return { class: "payment", httpStatus, retryable: true };
  }
  if (httpStatus === 429 || /rate.?limit|too many requests/.test(lower)) {
    return { class: "rate_limit", httpStatus, retryable: true };
  }
  if (httpStatus === 413 || /context.?window|too many tokens|maximum context/.test(lower)) {
    return { class: "context_window", httpStatus, retryable: true };
  }
  if (/content.?policy|safety.*block|blocked by/.test(lower)) {
    return { class: "content_policy", httpStatus, retryable: true };
  }
  if (/unsupported model/.test(lower)) {
    return { class: "client", httpStatus, retryable: true };
  }
  if (httpStatus === 400) {
    return { class: "client", httpStatus, retryable: false };
  }
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || httpStatus === 0) {
    return { class: "unavailable", httpStatus, retryable: true };
  }
  return { class: "retryable", httpStatus, retryable: true };
}

function byScore(a: FailoverCandidate, b: FailoverCandidate): number {
  return (b.score ?? 0) - (a.score ?? 0);
}

/**
 * 组内（同 model）优先消化 429/不可用；鉴权不重试；402/安全策略换 provider；
 * 上下文窗口换不同 model。钉死的请求 model 仍不得被换成别的账本科目。
 */
export function orderFailoverCandidates(params: {
  candidates: FailoverCandidate[];
  failed: FailoverCandidate;
  requestedModel?: string;
  error?: unknown;
}): FailoverCandidate[] {
  const failure = classifyRoutingFailure(params.error);
  if (!failure.retryable) {
    return [];
  }

  const pinned = params.requestedModel?.trim();
  const others = params.candidates.filter((item) => {
    if (item.routeKey === params.failed.routeKey) {
      return false;
    }
    if (pinned && pinned.toLowerCase() !== "auto" && !modelsMatchByAlias(item.model, pinned)) {
      return false;
    }
    return true;
  });

  const sameModel = (item: FailoverCandidate) => modelsMatchByAlias(item.model, params.failed.model);
  const sameProvider = (item: FailoverCandidate) =>
    Boolean(item.provider && params.failed.provider && item.provider === params.failed.provider);
  const isDefault = (item: FailoverCandidate) => item.source === "default";

  let ranked: FailoverCandidate[];
  switch (failure.class) {
    case "auth":
      return [];
    case "rate_limit":
    case "unavailable":
      ranked = [...others.filter(sameModel).sort(byScore), ...others.filter((item) => !sameModel(item)).sort(byScore)];
      break;
    case "payment":
    case "content_policy":
      ranked = others.filter((item) => !sameProvider(item)).sort(byScore);
      break;
    case "context_window":
      ranked = others.filter((item) => !sameModel(item)).sort(byScore);
      break;
    case "client":
    case "retryable":
      ranked = [...others].sort(byScore);
      break;
    default: {
      const exhausted: never = failure.class;
      return exhausted;
    }
  }

  const nonDefault = ranked.filter((item) => !isDefault(item)).slice(0, 2);
  const def = ranked.find(isDefault);
  const ordered = [...nonDefault];
  if (def && !ordered.some((item) => item.routeKey === def.routeKey)) {
    ordered.push(def);
  }
  return ordered;
}
