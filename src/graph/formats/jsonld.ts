import type { GraphEdge } from "../store.js";
import type { KgmGraphTriple } from "../../core/types.js";
import { triplesFromEdges } from "./types.js";

const CONTEXT = {
  "@vocab": "https://kgm.haxitag.com/vocab/",
  kgm: "https://kgm.haxitag.com/vocab/",
  subject: "@id",
  predicate: "kgm:predicate",
  object: "kgm:object",
  weight: "kgm:weight",
  triples: "kgm:triples",
};

export function exportJsonLd(params: { edges: GraphEdge[]; namespace: string }): string {
  const triples = triplesFromEdges(params.edges).map((t) => ({
    "@type": "kgm:Triple",
    subject: { "@id": iri(t.subject) },
    predicate: iri(t.predicate),
    object: looksLikeIri(t.object) ? { "@id": iri(t.object) } : t.object,
    ...(typeof t.weight === "number" ? { weight: t.weight } : {}),
  }));
  return JSON.stringify(
    {
      "@context": CONTEXT,
      "@type": "kgm:GraphSnapshot",
      "kgm:namespace": params.namespace,
      "kgm:exportedAt": new Date().toISOString(),
      triples,
    },
    null,
    2,
  );
}

export function importJsonLd(body: string): KgmGraphTriple[] {
  const parsed = JSON.parse(body) as unknown;
  const triples: KgmGraphTriple[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const t = coerceTriple(item);
      if (t) triples.push(t);
    }
    return triples;
  }
  if (!isRecord(parsed)) {
    return triples;
  }
  const list = parsed.triples ?? parsed["kgm:triples"] ?? parsed["@graph"];
  if (Array.isArray(list)) {
    for (const item of list) {
      const t = coerceTriple(item);
      if (t) triples.push(t);
    }
  }
  return triples;
}

function coerceTriple(value: unknown): KgmGraphTriple | null {
  if (!isRecord(value)) return null;
  const subject = asTerm(value.subject ?? value["@id"] ?? value.s);
  const predicate = asTerm(value.predicate ?? value.p ?? value["kgm:predicate"]);
  const object = asTerm(value.object ?? value.o ?? value["kgm:object"]);
  if (!subject || !predicate || !object) return null;
  const weightRaw = value.weight ?? value["kgm:weight"];
  return {
    subject,
    predicate,
    object,
    ...(typeof weightRaw === "number" ? { weight: weightRaw } : {}),
  };
}

function asTerm(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return stripIri(value.trim());
  if (isRecord(value) && typeof value["@id"] === "string") return stripIri(value["@id"]);
  if (isRecord(value) && typeof value["@value"] === "string") return value["@value"];
  return null;
}

function iri(term: string): string {
  if (looksLikeIri(term)) return term;
  return `https://kgm.haxitag.com/entity/${encodeURIComponent(term)}`;
}

function looksLikeIri(term: string): boolean {
  return /^https?:\/\//i.test(term) || term.includes(":");
}

function stripIri(term: string): string {
  const prefix = "https://kgm.haxitag.com/entity/";
  if (term.startsWith(prefix)) {
    try {
      return decodeURIComponent(term.slice(prefix.length));
    } catch {
      return term.slice(prefix.length);
    }
  }
  return term;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
