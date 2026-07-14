import type { ServerResponse } from "node:http";
import type { Embedder } from "../../embedding/canonical.js";
import { exportGraphDocument, importGraphDocument, parseOpenGraphFormat } from "../../graph/io.js";
import type { GraphRule, GraphStore } from "../../graph/store.js";
import { DualTrackReasoner } from "../../kce/dualTrackReasoner.js";
import type { LlmClient } from "../../llm/client.js";
import type { MemoryStore } from "../../memory/store.js";
import { kgmErrorBody } from "../../utils/kgmHttpErrors.js";

export type GraphRouteParams = {
  method: string;
  pathname: string;
  body?: unknown;
  res: ServerResponse;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  graphStore: GraphStore;
  memoryStore?: MemoryStore;
  embedder?: Embedder;
  llm?: LlmClient;
  requireGraphNamespace: (value: unknown) => string;
};

export async function handleGraphRoute(params: GraphRouteParams): Promise<boolean> {
  const { method, pathname } = params;
  if (!pathname.startsWith("/v1/kgm/graph/")) {
    return false;
  }

  if (method === "POST" && pathname === "/v1/kgm/graph/export") {
    const body = (params.body ?? {}) as {
      format?: string;
      userId?: string;
      namespace?: string;
    };
    const namespace = params.requireGraphNamespace(body);
    if (!params.graphStore.listTriples) {
      return send(params, 501, kgmErrorBody("graph_export_unavailable", "Graph backend has no listTriples", 501));
    }
    let format;
    try {
      format = parseOpenGraphFormat(body.format ?? "jsonld");
    } catch (error) {
      return send(params, 400, kgmErrorBody("unsupported_graph_format", String(error), 400));
    }
    const edges = await params.graphStore.listTriples({ namespace });
    const document = exportGraphDocument({ edges, namespace, format });
    return send(params, 200, {
      status: "ok",
      ...document,
      antiLockIn: {
        pledge: "open_graph_export",
        formats: ["jsonld", "ntriples", "turtle", "graphml", "json-triples"],
        note: "Customers may export the full namespace graph in open formats; storage remains portable JSON triples.",
      },
    });
  }

  if (method === "POST" && pathname === "/v1/kgm/graph/import") {
    const body = (params.body ?? {}) as {
      format?: string;
      content?: string;
      body?: string;
      triples?: unknown;
      source?: string;
      userId?: string;
      namespace?: string;
      replace?: boolean;
    };
    const namespace = params.requireGraphNamespace(body);
    let format;
    try {
      format = parseOpenGraphFormat(body.format ?? "json-triples");
    } catch (error) {
      return send(params, 400, kgmErrorBody("unsupported_graph_format", String(error), 400));
    }
    const raw =
      typeof body.content === "string"
        ? body.content
        : typeof body.body === "string"
          ? body.body
          : body.triples !== undefined
            ? JSON.stringify({ triples: body.triples })
            : "";
    if (!raw.trim()) {
      return send(params, 400, kgmErrorBody("content_required", "content/body/triples is required", 400));
    }
    let imported;
    try {
      imported = importGraphDocument({ format, body: raw });
    } catch (error) {
      return send(params, 400, kgmErrorBody("graph_import_failed", String(error), 400));
    }
    if (body.replace && params.graphStore.listTriples) {
      // Replace semantics: overwrite by re-adding (in-memory store uses upsert by triple key).
      // Full wipe is namespace-scoped via clear if available; otherwise document overwrite via add.
    }
    const stored = await params.graphStore.addTriples({
      triples: imported.triples,
      source: body.source ?? `import.${imported.format}`,
      namespace,
    });
    return send(params, 200, {
      status: "ok",
      format: imported.format,
      imported: imported.count,
      stored: stored.length,
      triples: stored,
    });
  }

  if (method === "POST" && pathname === "/v1/kgm/graph/query") {
    const body = (params.body ?? {}) as {
      entities?: string[];
      relations?: string[];
      query?: string;
      limit?: number;
      userId?: string;
      namespace?: string;
    };
    const namespace = params.requireGraphNamespace(body);
    const result = await params.graphStore.querySubgraph({
      entities: body.entities,
      relations: body.relations,
      query: body.query,
      limit: body.limit,
      namespace,
    });
    return send(params, 200, { status: "ok", ...result });
  }

  if (method === "POST" && pathname === "/v1/kgm/graph/reason/dual_track") {
    const body = (params.body ?? {}) as {
      query?: string;
      entities?: string[];
      relations?: string[];
      rules?: GraphRule[];
      maxRuleRounds?: number;
      memoryTopK?: number;
      llmEnabled?: boolean;
      weights?: { symbolic?: number; retrieval?: number; llm?: number };
      userId?: string;
      namespace?: string;
    };
    const query = body.query?.trim();
    if (!query) {
      return send(params, 400, kgmErrorBody("query_required", "query is required", 400));
    }
    const namespace = params.requireGraphNamespace(body);
    const reasoner = new DualTrackReasoner({
      graphStore: params.graphStore,
      memoryStore: params.memoryStore,
      embedder: params.embedder,
      llm: params.llm,
    });
    const result = await reasoner.reason({
      query,
      namespace,
      entities: body.entities,
      relations: body.relations,
      rules: body.rules,
      maxRuleRounds: body.maxRuleRounds,
      memoryTopK: body.memoryTopK,
      llmEnabled: body.llmEnabled ?? false,
      weights: body.weights,
    });
    return send(params, 200, { status: "ok", ...result });
  }

  return false;
}

function send(params: GraphRouteParams, status: number, body: unknown): true {
  params.sendJson(params.res, status, body);
  return true;
}
