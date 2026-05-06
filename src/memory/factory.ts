import type { ConfigStore } from "../core/configStore.js";
import type { MemoryStore } from "./store.js";
import { HybridMemoryStore } from "./hybridStore.js";
import { SqliteMetadataStore } from "./sqliteStore.js";
import { PostgresqlMetadataStore } from "./postgresqlStore.js";
import { ChromaVectorStore } from "./vectorStore.js";

export async function createHybridMemoryStore(configStore: ConfigStore): Promise<MemoryStore> {
  const config = configStore.get();
  
  // 选择元数据存储后端
  let metadataStore;
  if (config.database.provider === "postgresql") {
    metadataStore = await PostgresqlMetadataStore.connect(config.database);
  } else {
    metadataStore = await SqliteMetadataStore.connect({
      filePath: config.database.filePath!,
      journalMode: config.database.journalMode,
    });
  }
  
  const vectorStore = new ChromaVectorStore({
    baseUrl: config.vector.baseUrl ?? "http://localhost:8000",
    apiPath: config.vector.apiPath ?? "/api/v1",
    collection: config.vector.collection ?? "kgm_memory",
    timeoutMs: config.vector.timeoutMs,
  });
  
  return new HybridMemoryStore({ vectorStore, metadataStore });
}
