import { CANONICAL_EMBEDDING } from "../core/config.js";
export class InMemoryStore {
    store = new Map();
    async add(chunk) {
        const list = this.store.get(chunk.userId) ?? [];
        list.push(chunk);
        this.store.set(chunk.userId, list);
    }
    async search(userId, query, embedder, topK) {
        const list = this.store.get(userId) ?? [];
        if (list.length === 0) {
            return [];
        }
        const queryVector = await embedder.embed(query);
        const scored = list.map((item) => ({
            item,
            score: cosineSimilarity(queryVector, item.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK).map((entry) => ({
            id: entry.item.id,
            text: entry.item.text,
            score: entry.score,
            source: entry.item.source,
        }));
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
