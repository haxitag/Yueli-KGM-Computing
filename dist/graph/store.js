export class InMemoryGraphStore {
    edges = new Map();
    async addTriples(params) {
        const createdAt = new Date().toISOString();
        const source = params.source ?? "kgm.graph";
        const records = params.triples.map((triple) => {
            const key = `${triple.subject}|${triple.predicate}|${triple.object}`;
            const existing = this.edges.get(key);
            const edge = existing ?? {
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
    async querySubgraph(params) {
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
    async shortestPath(params) {
        const from = normalizeToken(params.from);
        const to = normalizeToken(params.to);
        if (from === to) {
            return { path: [from], edges: [] };
        }
        const maxH = Math.min(32, Math.max(1, params.maxHops ?? 8));
        const adj = new Map();
        for (const e of this.edges.values()) {
            const s = normalizeToken(e.subject);
            const o = normalizeToken(e.object);
            const push = (a, b) => {
                if (!adj.has(a)) {
                    adj.set(a, []);
                }
                adj.get(a).push({ n: b, e });
            };
            push(s, o);
            push(o, s);
        }
        const queue = [
            { node: from, path: [from], edges: [] },
        ];
        const visited = new Set([from]);
        while (queue.length > 0) {
            const cur = queue.shift();
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
    async connectedCommunities() {
        const parent = new Map();
        const find = (x) => {
            if (!parent.has(x)) {
                parent.set(x, x);
            }
            if (parent.get(x) !== x) {
                const r = find(parent.get(x));
                parent.set(x, r);
                return r;
            }
            return x;
        };
        const union = (a, b) => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) {
                parent.set(ra, rb);
            }
        };
        for (const e of this.edges.values()) {
            union(normalizeToken(e.subject), normalizeToken(e.object));
        }
        const all = new Set();
        for (const e of this.edges.values()) {
            all.add(normalizeToken(e.subject));
            all.add(normalizeToken(e.object));
        }
        const byRoot = new Map();
        for (const n of all) {
            const r = find(n);
            const g = byRoot.get(r) ?? [];
            g.push(n);
            byRoot.set(r, g);
        }
        const communities = Array.from(byRoot.values());
        return { communities, count: communities.length };
    }
    async reasonExpand(params) {
        const start = normalizeToken(params.entity);
        const maxD = Math.min(12, Math.max(1, params.maxDepth));
        const relF = new Set((params.relations ?? []).map(normalizeToken));
        const adj = new Map();
        for (const e of this.edges.values()) {
            const s = normalizeToken(e.subject);
            const o = normalizeToken(e.object);
            const p = normalizeToken(e.predicate);
            if (relF.size > 0 && !relF.has(p)) {
                continue;
            }
            const add = (a, b) => {
                if (!adj.has(a)) {
                    adj.set(a, []);
                }
                adj.get(a).push({ n: b, e });
            };
            add(s, o);
            add(o, s);
        }
        if (!adj.has(start)) {
            return { center: start, depth: 0, entities: [start], triples: [] };
        }
        const tripleAcc = new Map();
        const entitySet = new Set([start]);
        const q = [{ n: start, d: 0 }];
        let head = 0;
        while (head < q.length) {
            const { n, d } = q[head];
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
    async applyRules(params) {
        const source = params.source ?? "kgm.graph.rules";
        const added = [];
        for (let r = 0; r < params.maxRounds; r += 1) {
            let round = 0;
            for (const rule of params.rules) {
                const matchAll = (ifs) => {
                    for (const c of ifs) {
                        const found = Array.from(this.edges.values()).some((e) => matchClause(e, c));
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
                const exists = Array.from(this.edges.values()).some((e) => normalizeToken(e.subject) === normalizeToken(t.subject) &&
                    normalizeToken(e.predicate) === normalizeToken(t.predicate) &&
                    normalizeToken(e.object) === normalizeToken(t.object));
                if (exists) {
                    continue;
                }
                const created = await this.addTriples({ triples: [t], source });
                added.push(...created);
                round += 1;
            }
            if (round === 0) {
                break;
            }
        }
        return added;
    }
}
function expandThenTemplate(then) {
    return {
        subject: then.subject,
        predicate: then.predicate,
        object: then.object,
    };
}
function matchClause(e, c) {
    const s = c.subject === "*" || normalizeToken(e.subject) === normalizeToken(c.subject);
    const p = c.predicate === "*" || normalizeToken(e.predicate) === normalizeToken(c.predicate);
    const o = c.object === "*" || normalizeToken(e.object) === normalizeToken(c.object);
    return s && p && o;
}
function scoreEdge(edge, entitySet, relationSet, queryTokens) {
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
function tokenize(input) {
    return input
        .toLowerCase()
        .split(/[^a-zA-Z0-9_\u4e00-\u9fa5]+/)
        .map((token) => token.trim())
        .filter(Boolean);
}
function normalizeToken(input) {
    return input.trim().toLowerCase();
}
