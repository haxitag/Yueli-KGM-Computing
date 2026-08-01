/**
 * 请求追踪 ID 解析与对齐。
 *
 * 优先级（高→低）：
 * 1. 请求体 `kgm.ops.traceId` / `metadata.traceId` / `metadata.trace_id`
 * 2. 请求头 `x-trace-id` / `traceparent`（W3C 取 trace-id 段）
 * 3. 请求头 `x-request-id` / `x-correlation-id`
 * 4. 缺省：`generateId("trace")`
 *
 * requestId：
 * 1. 体 `requestId` / `metadata.request_id`
 * 2. 头 `x-kgm-request-id`
 * 3. 与 trace 共用的 `x-request-id`（若未被当作仅 trace）
 * 4. 缺省：`generateId("req")`
 */
import { generateId } from "../utils/id.js";

export type RequestTraceIds = {
  requestId: string;
  traceId: string;
  /** 是否由集成方显式传入（非服务端新生） */
  traceFromIntegrator: boolean;
  requestFromIntegrator: boolean;
};

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseTraceparent(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // version-traceid-spanid-flags
  const parts = value.trim().split("-");
  if (parts.length >= 3 && /^[0-9a-f]{32}$/i.test(parts[1]!)) {
    return parts[1];
  }
  return undefined;
}

function readBodyTraceId(body: {
  kgm?: { ops?: { traceId?: string } };
  metadata?: Record<string, unknown>;
} | undefined): string | undefined {
  const fromOps = body?.kgm?.ops?.traceId;
  if (typeof fromOps === "string" && fromOps.trim()) return fromOps.trim();
  const md = body?.metadata;
  if (!md) return undefined;
  for (const key of ["traceId", "trace_id", "x-trace-id"]) {
    const v = md[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function readBodyRequestId(body: {
  requestId?: string;
  metadata?: Record<string, unknown>;
} | undefined): string | undefined {
  if (typeof body?.requestId === "string" && body.requestId.trim()) {
    return body.requestId.trim();
  }
  const md = body?.metadata;
  if (!md) return undefined;
  for (const key of ["requestId", "request_id", "kgm_request_id"]) {
    const v = md[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function resolveRequestTraceIds(params: {
  headers?: Record<string, string | string[] | undefined>;
  body?: {
    requestId?: string;
    kgm?: { ops?: { traceId?: string } };
    metadata?: Record<string, unknown>;
  };
  /** 兼容层内部已生成的 id，仅作最后回退前的候选 */
  fallbackRequestId?: string;
}): RequestTraceIds {
  const headers = params.headers;
  const body = params.body;

  const bodyTrace = readBodyTraceId(body);
  const headerTrace =
    headerValue(headers, "x-trace-id") ??
    parseTraceparent(headerValue(headers, "traceparent")) ??
    headerValue(headers, "x-correlation-id");

  let traceFromIntegrator = false;
  let traceId: string;
  if (bodyTrace) {
    traceId = bodyTrace;
    traceFromIntegrator = true;
  } else if (headerTrace) {
    traceId = headerTrace;
    traceFromIntegrator = true;
  } else {
    traceId = generateId("trace");
  }

  const bodyReq = readBodyRequestId(body);
  const headerKgmReq = headerValue(headers, "x-kgm-request-id");
  const headerReq = headerValue(headers, "x-request-id");

  let requestFromIntegrator = false;
  let requestId: string;
  if (bodyReq) {
    requestId = bodyReq;
    requestFromIntegrator = true;
  } else if (headerKgmReq) {
    requestId = headerKgmReq;
    requestFromIntegrator = true;
  } else if (headerReq && headerReq !== traceId) {
    requestId = headerReq;
    requestFromIntegrator = true;
  } else if (params.fallbackRequestId?.trim()) {
    requestId = params.fallbackRequestId.trim();
  } else {
    requestId = generateId("req");
  }

  // 集成方只传了一个 id：允许 requestId === traceId（常见于网关）
  if (!bodyTrace && !headerTrace && requestFromIntegrator && bodyReq) {
    // request 有、trace 无：用 request 作 trace 以对齐链路
    traceId = requestId;
    traceFromIntegrator = true;
  }

  return { requestId, traceId, traceFromIntegrator, requestFromIntegrator };
}

/** 写出响应侧追踪头，便于集成方 closure */
export function traceResponseHeaders(ids: Pick<RequestTraceIds, "requestId" | "traceId">): Record<string, string> {
  return {
    "x-trace-id": ids.traceId,
    "x-kgm-request-id": ids.requestId,
  };
}
