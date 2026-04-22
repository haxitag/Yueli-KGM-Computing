import { HybridMemoryStore } from "./hybridStore.js";
import { SqliteMetadataStore } from "./sqliteStore.js";
import { ChromaVectorStore } from "./vectorStore.js";
export async function createHybridMemoryStore(configStore) {
    const config = configStore.get();
    const metadataStore = await SqliteMetadataStore.connect({
        filePath: config.database.filePath,
        journalMode: config.database.journalMode,
    });
    const vectorStore = new ChromaVectorStore({
        baseUrl: config.vector.baseUrl ?? "http://localhost:8000",
        apiPath: config.vector.apiPath ?? "/api/v1",
        collection: config.vector.collection ?? "kgm_memory",
        timeoutMs: config.vector.timeoutMs,
    });
    return new HybridMemoryStore({ vectorStore, metadataStore });
}
