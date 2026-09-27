import type { GraphEdge } from "../store.js";
import type { KgmGraphTriple } from "../../core/types.js";
import { triplesFromEdges } from "./types.js";

export function exportNTriples(edges: GraphEdge[]): string {
  return triplesFromEdges(edges)
    .map((t) => `${formatTerm(t.subject)} ${formatTerm(t.predicate)} ${formatObject(t.object)} .`)
    .join("\n");
}

export function exportTurtle(params: { edges: GraphEdge[]; namespace: string }): string {
  const lines = [
    `@prefix kgm: <https://kgm.haxitag.com/vocab/> .`,
    `@prefix ent: <https://kgm.haxitag.com/entity/> .`,
    `# namespace: ${escapeComment(params.namespace)}`,
    `# exportedAt: ${new Date().toISOString()}`,
    "",
  ];
  for (const t of triplesFromEdges(params.edges)) {
    lines.push(`${ttlTerm(t.subject)} ${ttlPred(t.predicate)} ${ttlObject(t.object)} .`);
  }
  return lines.join("\n");
}

export function importNTriplesOrTurtle(body: string): KgmGraphTriple[] {
  const triples: KgmGraphTriple[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("@prefix") || line.startsWith("PREFIX") || line.startsWith("@base")) {
      continue;
    }
    const match = line.match(/^(\S+)\s+(\S+)\s+(.+?)\s*\.\s*$/);
    if (!match) continue;
    const subject = unquoteTerm(match[1]!);
    const predicate = unquoteTerm(match[2]!);
    const object = unquoteTerm(match[3]!);
    if (subject && predicate && object) {
      triples.push({ subject, predicate, object });
    }
  }
  return triples;
}

function formatTerm(term: string): string {
  if (/^https?:\/\//i.test(term)) return `<${term}>`;
  return `<https://kgm.haxitag.com/entity/${encodeURIComponent(term)}>`;
}

function formatObject(term: string): string {
  if (/^https?:\/\//i.test(term) || term.includes(":")) return formatTerm(term);
  return JSON.stringify(term);
}

function ttlTerm(term: string): string {
  if (/^https?:\/\//i.test(term)) return `<${term}>`;
  return `ent:${safeLocal(term)}`;
}

function ttlPred(term: string): string {
  if (/^https?:\/\//i.test(term)) return `<${term}>`;
  if (term.includes(":")) return term;
  return `kgm:${safeLocal(term)}`;
}

function ttlObject(term: string): string {
  if (/^https?:\/\//i.test(term) || term.includes(":")) return ttlTerm(term);
  return JSON.stringify(term);
}

function unquoteTerm(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("<") && t.endsWith(">")) {
    const iri = t.slice(1, -1);
    const prefix = "https://kgm.haxitag.com/entity/";
    if (iri.startsWith(prefix)) {
      try {
        return decodeURIComponent(iri.slice(prefix.length));
      } catch {
        return iri.slice(prefix.length);
      }
    }
    return iri;
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1).replace(/"/g, '\\"')}"` : t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("ent:")) return decodeURIComponent(t.slice(4));
  if (t.startsWith("kgm:")) return t.slice(4);
  return t;
}

function safeLocal(term: string): string {
  return encodeURIComponent(term).replace(/%/g, "_");
}

function escapeComment(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}
