export class HybridMemoryStore {
    vectorStore;
    metadataStore;
    constructor(params) {
        this.vectorStore = params.vectorStore;
        this.metadataStore = params.metadataStore;
    }
    async add(chunk) {
        await this.vectorStore.upsert({
            ids: [chunk.id],
            embeddings: [chunk.embedding],
            metadatas: [{ userId: chunk.userId, source: chunk.source, embeddingVersion: chunk.embeddingVersion }],
        });
        await this.metadataStore.upsert({
            id: chunk.id,
            userId: chunk.userId,
            text: chunk.text,
            source: chunk.source,
            createdAt: chunk.createdAt,
        });
    }
    async search(userId, query, embedder, topK) {
        const queryEmbedding = await embedder.embed(query);
        const result = await this.vectorStore.query({
            embedding: queryEmbedding,
            topK,
            where: { userId },
        });
        if (result.ids.length === 0) {
            return [];
        }
        const metadata = await this.metadataStore.getMany(result.ids);
        const metadataMap = new Map(metadata.map((record) => [record.id, record]));
        return result.ids.map((id, idx) => {
            const record = metadataMap.get(id);
            return {
                id,
                text: record?.text ?? "",
                score: result.scores[idx] ?? 0,
                source: record?.source ?? "unknown",
            };
        });
    }
}
