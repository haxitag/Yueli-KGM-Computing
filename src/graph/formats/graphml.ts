import type { GraphEdge } from "../store.js";
import type { KgmGraphTriple } from "../../core/types.js";
import { triplesFromEdges } from "./types.js";

export function exportGraphMl(params: { edges: GraphEdge[]; namespace: string }): string {
  const triples = triplesFromEdges(params.edges);
  const nodes = new Map<string, string>();
  for (const t of triples) {
    if (!nodes.has(t.subject)) nodes.set(t.subject, `n${nodes.size}`);
    if (!nodes.has(t.object)) nodes.set(t.object, `n${nodes.size}`);
  }
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<graphml xmlns="http://graphml.graphdrawing.org/xmlns">`,
    `  <key id="label" for="node" attr.name="label" attr.type="string"/>`,
    `  <key id="predicate" for="edge" attr.name="predicate" attr.type="string"/>`,
    `  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>`,
    `  <graph id="${escapeXml(params.namespace)}" edgedefault="directed">`,
  ];
  for (const [label, id] of nodes) {
    parts.push(`    <node id="${id}"><data key="label">${escapeXml(label)}</data></node>`);
  }
  let edgeIdx = 0;
  for (const t of triples) {
    const source = nodes.get(t.subject)!;
    const target = nodes.get(t.object)!;
    parts.push(
      `    <edge id="e${edgeIdx++}" source="${source}" target="${target}">` +
        `<data key="predicate">${escapeXml(t.predicate)}</data>` +
        (typeof t.weight === "number" ? `<data key="weight">${t.weight}</data>` : "") +
        `</edge>`,
    );
  }
  parts.push(`  </graph>`, `</graphml>`);
  return parts.join("\n");
}

export function importGraphMl(body: string): KgmGraphTriple[] {
  const nodeLabels = new Map<string, string>();
  const nodeRe = /<node\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/node>/gi;
  let nodeMatch: RegExpExecArray | null;
  while ((nodeMatch = nodeRe.exec(body))) {
    const id = nodeMatch[1]!;
    const inner = nodeMatch[2] ?? "";
    const labelMatch = /<data\b[^>]*\bkey="label"[^>]*>([\s\S]*?)<\/data>/i.exec(inner);
    nodeLabels.set(id, decodeXml(labelMatch?.[1]?.trim() || id));
  }

  const triples: KgmGraphTriple[] = [];
  const edgeRe = /<edge\b([^>]*)>([\s\S]*?)<\/edge>/gi;
  let edgeMatch: RegExpExecArray | null;
  while ((edgeMatch = edgeRe.exec(body))) {
    const attrs = edgeMatch[1] ?? "";
    const inner = edgeMatch[2] ?? "";
    const sourceId = /source="([^"]+)"/i.exec(attrs)?.[1];
    const targetId = /target="([^"]+)"/i.exec(attrs)?.[1];
    if (!sourceId || !targetId) continue;
    const predicate =
      decodeXml(/<data\b[^>]*\bkey="predicate"[^>]*>([\s\S]*?)<\/data>/i.exec(inner)?.[1]?.trim() ?? "related_to");
    const weightRaw = /<data\b[^>]*\bkey="weight"[^>]*>([\s\S]*?)<\/data>/i.exec(inner)?.[1]?.trim();
    const weight = weightRaw !== undefined ? Number(weightRaw) : undefined;
    triples.push({
      subject: nodeLabels.get(sourceId) ?? sourceId,
      predicate,
      object: nodeLabels.get(targetId) ?? targetId,
      ...(typeof weight === "number" && Number.isFinite(weight) ? { weight } : {}),
    });
  }
  return triples;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
