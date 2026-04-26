import { CANONICAL_EMBEDDING } from "../core/config.js";
import { applyMemoryRerank } from "../rerank/applyRerank.js";
import { blendAndNormalize, bm25Scores } from "./lexicalRerank.js";
export class InMemoryStore {
    store = new Map();
    async add(chunk) {
        const list = this.store.get(chunk.userId) ?? [];
        list.push(chunk);
        this.store.set(chunk.userId, list);
    }
    async search(userId, query, embedder, topK, options) {
        const list = this.store.get(userId) ?? [];
        if (list.length === 0) {
            return [];
        }
        const w = options?.lexicalWeight ?? 0;
        const overFetch = Math.max(1, Math.min(8, options?.overFetch ?? (w > 0 ? 3 : 1)));
        const fetchN = Math.min(list.length, Math.max(topK, Math.ceil(topK * overFetch)));
        const queryVector = await embedder.embed(query);
        const scored = list.map((item) => ({
            item,
            score: cosineSimilarity(queryVector, item.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        const take = scored.slice(0, fetchN);
        const texts = take.map((e) => e.item.text);
        const vec = take.map((e) => e.score);
        const blended = w > 0
            ? blendAndNormalize(vec, bm25Scores(query, texts), w)
            : vec;
        let out = take
            .map((row, i) => ({
            id: row.item.id,
            text: row.item.text,
            score: blended[i] ?? row.score,
            source: row.item.source,
        }))
            .sort((a, b) => b.score - a.score);
        if (!options?.rerank || options.rerank === "off") {
            return out.slice(0, topK);
        }
        const cap = Math.min(out.length, Math.max(topK, Math.min(48, topK * 3)));
        out = out.slice(0, cap);
        out = await applyMemoryRerank(query, out, embedder, options);
        return out.slice(0, topK);
    }
}
export function buildMemoryChunk(params) {
    return {
        id: params.id,
        userId: params.userId,
        text: params.text,
        embedding: params.embedding,
        embeddingVersion: params.embeddingVersion ?? CANONICAL_EMBEDDING.version,
        source: params.source,
        createdAt: new Date().toISOString(),
    };
}
function cosineSimilarity(a, b) {
    if (a.length !== b.length) {
        return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const av = a[i];
        const bv = b[i];
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
