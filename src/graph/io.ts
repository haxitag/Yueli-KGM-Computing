import type { GraphEdge } from "./store.js";
import type { KgmGraphTriple } from "../core/types.js";
import { exportGraphMl, importGraphMl } from "./formats/graphml.js";
import { exportJsonLd, importJsonLd } from "./formats/jsonld.js";
import { exportNTriples, exportTurtle, importNTriplesOrTurtle } from "./formats/rdf.js";
import {
  contentTypeForFormat,
  parseOpenGraphFormat,
  triplesFromEdges,
  type GraphExportDocument,
  type GraphImportResult,
  type OpenGraphFormat,
} from "./formats/types.js";

export type { GraphExportDocument, GraphImportResult, OpenGraphFormat };
export { parseOpenGraphFormat, contentTypeForFormat };

export function exportGraphDocument(params: {
  edges: GraphEdge[];
  namespace: string;
  format: OpenGraphFormat | string;
}): GraphExportDocument {
  const format = typeof params.format === "string" ? parseOpenGraphFormat(params.format) : params.format;
  let body: string;
  switch (format) {
    case "jsonld":
      body = exportJsonLd({ edges: params.edges, namespace: params.namespace });
      break;
    case "ntriples":
      body = exportNTriples(params.edges);
      break;
    case "turtle":
      body = exportTurtle({ edges: params.edges, namespace: params.namespace });
      break;
    case "graphml":
      body = exportGraphMl({ edges: params.edges, namespace: params.namespace });
      break;
    case "json-triples":
      body = JSON.stringify(
        {
          namespace: params.namespace,
          exportedAt: new Date().toISOString(),
          triples: triplesFromEdges(params.edges),
        },
        null,
        2,
      );
      break;
    default: {
      const _exhaustive: never = format;
      throw new Error(`unsupported_graph_format:${_exhaustive}`);
    }
  }
  return {
    format,
    contentType: contentTypeForFormat(format),
    body,
    tripleCount: params.edges.length,
    namespace: params.namespace,
  };
}

export function importGraphDocument(params: {
  format: OpenGraphFormat | string;
  body: string;
}): GraphImportResult {
  const format = typeof params.format === "string" ? parseOpenGraphFormat(params.format) : params.format;
  let triples: KgmGraphTriple[];
  switch (format) {
    case "jsonld":
      triples = importJsonLd(params.body);
      break;
    case "ntriples":
    case "turtle":
      triples = importNTriplesOrTurtle(params.body);
      break;
    case "graphml":
      triples = importGraphMl(params.body);
      break;
    case "json-triples": {
      const parsed = JSON.parse(params.body) as unknown;
      if (Array.isArray(parsed)) {
        triples = parsed as KgmGraphTriple[];
      } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { triples?: unknown }).triples)) {
        triples = (parsed as { triples: KgmGraphTriple[] }).triples;
      } else {
        triples = [];
      }
      break;
    }
    default: {
      const _exhaustive: never = format;
      throw new Error(`unsupported_graph_format:${_exhaustive}`);
    }
  }
  const normalized = triples
    .filter((t) => t && typeof t.subject === "string" && typeof t.predicate === "string" && typeof t.object === "string")
    .map((t) => ({
      subject: String(t.subject).trim(),
      predicate: String(t.predicate).trim(),
      object: String(t.object).trim(),
      ...(typeof t.weight === "number" ? { weight: t.weight } : {}),
    }))
    .filter((t) => t.subject && t.predicate && t.object);
  return { format, triples: normalized, count: normalized.length };
}
