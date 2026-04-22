import type { KgmGraphTriple } from "../core/types.js";

export type GraphEdge = KgmGraphTriple & {
  id: string;
  source: string;
  createdAt: string;
};

export type GraphSubgraph = {
  triples: GraphEdge[];
  entities: string[];
  relations: string[];
};

export type GraphStore = {
  addTriples(params: { triples: KgmGraphTriple[]; source?: string }): Promise<GraphEdge[]>;
  querySubgraph(params: {
    entities?: string[];
    relations?: string[];
    query?: string;
    limit?: number;
  }): Promise<GraphSubgraph>;
};

export class InMemoryGraphStore implements GraphStore {
  private edges = new Map<string, GraphEdge>();

  async addTriples(params: { triples: KgmGraphTriple[]; source?: string }): Promise<GraphEdge[]> {
    const createdAt = new Date().toISOString();
    const source = params.source ?? "kgm.graph";
    const records = params.triples.map((triple) => {
      const key = `${triple.subject}|${triple.predicate}|${triple.object}`;
      const existing = this.edges.get(key);
      const edge: GraphEdge = existing ?? {
        ...triple,
        id: key,
        source,
        createdAt,
      };
      this.edges.set(key, edge);
      return edge;
    });
    return records;
  }

  async querySubgraph(params: {
    entities?: string[];
    relations?: string[];
    query?: string;
    limit?: number;
  }): Promise<GraphSubgraph> {
    const entitySet = new Set((params.entities ?? []).map(normalizeToken));
    const relationSet = new Set((params.relations ?? []).map(normalizeToken));
    const queryTokens = tokenize(params.query ?? "");
    const scored = Array.from(this.edges.values())
      .map((edge) => ({
        edge,
        score: scoreEdge(edge, entitySet, relationSet, queryTokens),
      }))
      .filter((entry) => entry.score > 0 || (entitySet.size === 0 && relationSet.size === 0 && queryTokens.length === 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, params.limit ?? 8);

    const triples = scored.map((entry) => entry.edge);
    const entities = Array.from(new Set(triples.flatMap((edge) => [edge.subject, edge.object])));
    const relations = Array.from(new Set(triples.map((edge) => edge.predicate)));

    return { triples, entities, relations };
  }
}

function scoreEdge(
  edge: GraphEdge,
  entitySet: Set<string>,
  relationSet: Set<string>,
  queryTokens: string[],
): number {
  let score = 0;
  const subject = normalizeToken(edge.subject);
  const predicate = normalizeToken(edge.predicate);
  const object = normalizeToken(edge.object);

  if (entitySet.has(subject) || entitySet.has(object)) {
    score += 4;
  }
  if (relationSet.has(predicate)) {
    score += 3;
  }

  const haystack = `${subject} ${predicate} ${object}`;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-zA-Z0-9_\u4e00-\u9fa5]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeToken(input: string): string {
  return input.trim().toLowerCase();
}
