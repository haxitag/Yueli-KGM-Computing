import { CANONICAL_EMBEDDING } from "../core/config.js";
import { applyMemoryRerank } from "../rerank/applyRerank.js";
import { blendAndNormalize, bm25Scores } from "./lexicalRerank.js";
export class InMemoryStore {
    store = new Map();
    maxChunksPerUser;
    maxTotalChunks;
    evictionPolicy;
    constructor(config) {
        const parseEnvInt = (name, defaultValue) => {
            const value = process.env[name];
            if (value) {
                const parsed = parseInt(value, 10);
                if (!isNaN(parsed) && parsed > 0) {
                    return parsed;
                }
            }
            return defaultValue;
        };
        this.maxChunksPerUser = config?.maxChunksPerUser ?? parseEnvInt("KGM_MEMORY_MAX_CHUNKS_PER_USER", 1000);
        this.maxTotalChunks = config?.maxTotalChunks ?? parseEnvInt("KGM_MEMORY_MAX_TOTAL_CHUNKS", 10000);
        const policy = config?.evictionPolicy ?? process.env.KGM_MEMORY_EVICTION_POLICY;
        this.evictionPolicy = (policy === "fifo" || policy === "lru") ? policy : "lru";
    }
    getTotalChunks() {
        let total = 0;
        this.store.forEach((list) => {
            total += list.length;
        });
        return total;
    }
    evictOldest(list) {
        if (this.evictionPolicy === "lru") {
            return [...list].sort((a, b) => new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime());
        }
        return [...list].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    enforceLimits() {
        // 首先检查每个用户的限制
        this.store.forEach((list, userId) => {
            if (list.length > this.maxChunksPerUser) {
                const sorted = this.evictOldest(list);
                const trimmed = sorted.slice(-this.maxChunksPerUser);
                this.store.set(userId, trimmed);
            }
        });
        // 然后检查总体限制
        let total = this.getTotalChunks();
        if (total > this.maxTotalChunks) {
            // 创建所有块的列表并按策略排序
            const allChunks = [];
            this.store.forEach((list, userId) => {
                list.forEach((chunk) => {
                    allChunks.push({ userId, chunk });
                });
            });
            const sorted = allChunks.sort((a, b) => {
                if (this.evictionPolicy === "lru") {
                    return new Date(a.chunk.lastAccessedAt).getTime() - new Date(b.chunk.lastAccessedAt).getTime();
                }
                return new Date(a.chunk.createdAt).getTime() - new Date(b.chunk.createdAt).getTime();
            });
            // 删除最旧的块直到总量达标
            const toRemove = sorted.slice(0, total - this.maxTotalChunks);
            const removeSet = new Set(toRemove.map((item) => `${item.userId}:${item.chunk.id}`));
            this.store.forEach((list, userId) => {
                const filtered = list.filter((chunk) => !removeSet.has(`${userId}:${chunk.id}`));
                this.store.set(userId, filtered);
            });
        }
    }
    async add(chunk) {
        const now = new Date().toISOString();
        const chunkWithAccessTime = { ...chunk, lastAccessedAt: now };
        const list = this.store.get(chunk.userId) ?? [];
        list.push(chunkWithAccessTime);
        this.store.set(chunk.userId, list);
        this.enforceLimits();
    }
    async search(userId, query, embedder, topK, options) {
        let list = this.store.get(userId) ?? [];
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
        // 更新访问时间
        const now = new Date().toISOString();
        take.forEach(({ item }) => {
            item.lastAccessedAt = now;
        });
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
    const now = new Date().toISOString();
    return {
        id: params.id,
        userId: params.userId,
        text: params.text,
        embedding: params.embedding,
        embeddingVersion: params.embeddingVersion ?? CANONICAL_EMBEDDING.version,
        source: params.source,
        createdAt: now,
        lastAccessedAt: now,
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
