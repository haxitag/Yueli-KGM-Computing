import type { KgmGraphTriple } from "../../core/types.js";
import type { GraphEdge } from "../store.js";

export type OpenGraphFormat = "jsonld" | "ntriples" | "turtle" | "graphml" | "json-triples";

export type GraphExportDocument = {
  format: OpenGraphFormat;
  contentType: string;
  body: string;
  tripleCount: number;
  namespace: string;
};

export type GraphImportResult = {
  format: OpenGraphFormat;
  triples: KgmGraphTriple[];
  count: number;
};

export function contentTypeForFormat(format: OpenGraphFormat): string {
  switch (format) {
    case "jsonld":
      return "application/ld+json";
    case "ntriples":
      return "application/n-triples";
    case "turtle":
      return "text/turtle";
    case "graphml":
      return "application/graphml+xml";
    case "json-triples":
      return "application/json";
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

export function parseOpenGraphFormat(raw: unknown): OpenGraphFormat {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (value === "json-ld" || value === "jsonld" || value === "ld+json") {
    return "jsonld";
  }
  if (value === "nt" || value === "n-triples" || value === "ntriples") {
    return "ntriples";
  }
  if (value === "ttl" || value === "turtle" || value === "rdf" || value === "rdf-turtle") {
    return "turtle";
  }
  if (value === "graphml" || value === "xml-graphml") {
    return "graphml";
  }
  if (value === "json" || value === "json-triples" || value === "triples" || value === "") {
    return "json-triples";
  }
  throw new Error(`unsupported_graph_format:${value}`);
}

export function triplesFromEdges(edges: GraphEdge[]): KgmGraphTriple[] {
  return edges.map((edge) => ({
    subject: edge.subject,
    predicate: edge.predicate,
    object: edge.object,
    ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
  }));
}
