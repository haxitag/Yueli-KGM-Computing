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

export type GraphShortestPathResult = { path: string[]; edges: GraphEdge[] };

export type GraphCommunitiesResult = { communities: string[][]; count: number };

export type GraphExpandResult = {
  center: string;
  depth: number;
  entities: string[];
  triples: GraphEdge[];
};

export type GraphRule = {
  id: string;
  /** 与现有三元组等长：某项为 * 表示通配，大小写不敏感 */
  if: { subject: string; predicate: string; object: string }[];
  then: { subject: string; predicate: string; object: string };
};

export type GraphStore = {
  addTriples(params: {
    triples: KgmGraphTriple[];
    source?: string;
    namespace?: string;
  }): Promise<GraphEdge[]>;
  querySubgraph(params: {
    entities?: string[];
    relations?: string[];
    query?: string;
    limit?: number;
    namespace?: string;
  }): Promise<GraphSubgraph>;
  /** 无向近似：在 subject/object 间做 BFS 最短链；无路径时返回 null */
  shortestPath?(params: {
    from: string;
    to: string;
    maxHops?: number;
    namespace?: string;
  }): Promise<GraphShortestPathResult | null>;
  /** 无向图上的连通分量（按实体 token 去重后） */
  connectedCommunities?(params?: { namespace?: string }): Promise<GraphCommunitiesResult>;
  /** 自实体出发限定深度的 BFS 子图，可选谓词过滤 */
  reasonExpand?(params: {
    entity: string;
    maxDepth: number;
    relations?: string[];
    namespace?: string;
  }): Promise<GraphExpandResult | null>;
  /** 一阶规则前向：匹配 if 中全部子句后 instantiates then 模板（仅支持字面替换 $s/$o 占位） */
  applyRules?(params: {
    rules: GraphRule[];
    maxRounds: number;
    source?: string;
    namespace?: string;
  }): Promise<GraphEdge[]>;
  /** 列举命名空间内全部边（开放格式导出用） */
  listTriples?(params?: { namespace?: string }): Promise<GraphEdge[]>;
};

export class InMemoryGraphStore implements GraphStore {
  private namespaces = new Map<string, Map<string, GraphEdge>>();

  async addTriples(params: {
    triples: KgmGraphTriple[];
    source?: string;
    namespace?: string;
  }): Promise<GraphEdge[]> {
    const createdAt = new Date().toISOString();
    const source = params.source ?? "kgm.graph";
    const edges = this.edgesFor(params.namespace);
    const records = params.triples.map((triple) => {
      const key = `${triple.subject}|${triple.predicate}|${triple.object}`;
      const existing = edges.get(key);
      const edge: GraphEdge = existing ?? {
        ...triple,
        id: key,
        source,
        createdAt,
      };
      edges.set(key, edge);
      return edge;
    });
    return records;
  }

  async querySubgraph(params: {
    entities?: string[];
    relations?: string[];
    query?: string;
    limit?: number;
    namespace?: string;
  }): Promise<GraphSubgraph> {
    const entitySet = new Set((params.entities ?? []).map(normalizeToken));
    const relationSet = new Set((params.relations ?? []).map(normalizeToken));
    const queryTokens = tokenize(params.query ?? "");
    const scored = Array.from(this.edgesFor(params.namespace).values())
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

  async shortestPath(params: {
    from: string;
    to: string;
    maxHops?: number;
    namespace?: string;
  }): Promise<GraphShortestPathResult | null> {
    const from = normalizeToken(params.from);
    const to = normalizeToken(params.to);
    if (from === to) {
      return { path: [from], edges: [] };
    }
    const maxH = Math.min(32, Math.max(1, params.maxHops ?? 8));
    const adj = new Map<string, Array<{ n: string; e: GraphEdge }>>();
    for (const e of this.edgesFor(params.namespace).values()) {
      const s = normalizeToken(e.subject);
      const o = normalizeToken(e.object);
      const push = (a: string, b: string) => {
        if (!adj.has(a)) {
          adj.set(a, []);
        }
        adj.get(a)!.push({ n: b, e });
      };
      push(s, o);
      push(o, s);
    }
    const queue: { node: string; path: string[]; edges: GraphEdge[] }[] = [
      { node: from, path: [from], edges: [] },
    ];
    const visited = new Set<string>([from]);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.path.length - 1 > maxH) {
        continue;
      }
      for (const { n, e } of adj.get(cur.node) ?? []) {
        if (n === to) {
          return { path: [...cur.path, n], edges: [...cur.edges, e] };
        }
        if (visited.has(n)) {
          continue;
        }
        visited.add(n);
        queue.push({ node: n, path: [...cur.path, n], edges: [...cur.edges, e] });
      }
    }
    return null;
  }

  async connectedCommunities(params?: { namespace?: string }): Promise<GraphCommunitiesResult> {
    const edges = this.edgesFor(params?.namespace);
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) {
        parent.set(x, x);
      }
      if (parent.get(x) !== x) {
        const r = find(parent.get(x)!);
        parent.set(x, r);
        return r;
      }
      return x;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) {
        parent.set(ra, rb);
      }
    };
    for (const e of edges.values()) {
      union(normalizeToken(e.subject), normalizeToken(e.object));
    }
    const all = new Set<string>();
    for (const e of edges.values()) {
      all.add(normalizeToken(e.subject));
      all.add(normalizeToken(e.object));
    }
    const byRoot = new Map<string, string[]>();
    for (const n of all) {
      const r = find(n);
      const g = byRoot.get(r) ?? [];
      g.push(n);
      byRoot.set(r, g);
    }
    const communities = Array.from(byRoot.values());
    return { communities, count: communities.length };
  }

  async reasonExpand(params: {
    entity: string;
    maxDepth: number;
    relations?: string[];
    namespace?: string;
  }): Promise<GraphExpandResult | null> {
    const start = normalizeToken(params.entity);
    const maxD = Math.min(12, Math.max(1, params.maxDepth));
    const relF = new Set((params.relations ?? []).map(normalizeToken));
    const adj = new Map<string, Array<{ n: string; e: GraphEdge }>>();
    for (const e of this.edgesFor(params.namespace).values()) {
      const s = normalizeToken(e.subject);
      const o = normalizeToken(e.object);
      const p = normalizeToken(e.predicate);
      if (relF.size > 0 && !relF.has(p)) {
        continue;
      }
      const add = (a: string, b: string) => {
        if (!adj.has(a)) {
          adj.set(a, []);
        }
        adj.get(a)!.push({ n: b, e });
      };
      add(s, o);
      add(o, s);
    }
    if (!adj.has(start)) {
      return { center: start, depth: 0, entities: [start], triples: [] };
    }
    const tripleAcc = new Map<string, GraphEdge>();
    const entitySet = new Set<string>([start]);
    const q: { n: string; d: number }[] = [{ n: start, d: 0 }];
    let head = 0;
    while (head < q.length) {
      const { n, d } = q[head]!;
      head += 1;
      if (d === maxD) {
        continue;
      }
      for (const { n: nb, e } of adj.get(n) ?? []) {
        tripleAcc.set(e.id, e);
        if (!entitySet.has(nb)) {
          entitySet.add(nb);
          q.push({ n: nb, d: d + 1 });
        }
      }
    }
    return {
      center: start,
      depth: maxD,
      entities: Array.from(entitySet),
      triples: Array.from(tripleAcc.values()),
    };
  }

  async applyRules(params: {
    rules: GraphRule[];
    maxRounds: number;
    source?: string;
    namespace?: string;
  }): Promise<GraphEdge[]> {
    const source = params.source ?? "kgm.graph.rules";
    const added: GraphEdge[] = [];
    const edges = this.edgesFor(params.namespace);
    for (let r = 0; r < params.maxRounds; r += 1) {
      let round = 0;
      for (const rule of params.rules) {
        const matchAll = (ifs: { subject: string; predicate: string; object: string }[]): boolean => {
          for (const c of ifs) {
            const found = Array.from(edges.values()).some((e) => matchClause(e, c));
            if (!found) {
              return false;
            }
          }
          return true;
        };
        if (!matchAll(rule.if)) {
          continue;
        }
        const t = expandThenTemplate(rule.then);
        const exists = Array.from(edges.values()).some(
          (e) =>
            normalizeToken(e.subject) === normalizeToken(t.subject) &&
            normalizeToken(e.predicate) === normalizeToken(t.predicate) &&
            normalizeToken(e.object) === normalizeToken(t.object),
        );
        if (exists) {
          continue;
        }
        const created = await this.addTriples({ triples: [t], source, namespace: params.namespace });
        added.push(...created);
        round += 1;
      }
      if (round === 0) {
        break;
      }
    }
    return added;
  }

  async listTriples(params?: { namespace?: string }): Promise<GraphEdge[]> {
    return Array.from(this.edgesFor(params?.namespace).values());
  }

  private edgesFor(namespace?: string): Map<string, GraphEdge> {
    const key = namespace?.trim() || "__global__";
    if (!this.namespaces.has(key)) {
      this.namespaces.set(key, new Map());
    }
    return this.namespaces.get(key)!;
  }
}

function expandThenTemplate(then: { subject: string; predicate: string; object: string }): KgmGraphTriple {
  return {
    subject: then.subject,
    predicate: then.predicate,
    object: then.object,
  };
}

function matchClause(
  e: GraphEdge,
  c: { subject: string; predicate: string; object: string },
): boolean {
  const s = c.subject === "*" || normalizeToken(e.subject) === normalizeToken(c.subject);
  const p = c.predicate === "*" || normalizeToken(e.predicate) === normalizeToken(c.predicate);
  const o = c.object === "*" || normalizeToken(e.object) === normalizeToken(c.object);
  return s && p && o;
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
