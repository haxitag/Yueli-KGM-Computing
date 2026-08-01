import {
  ConfigStore,
  createKgmServer,
  createRuntimeWithStorage,
} from "../index.js";
import type { KgmConfigPatch } from "../core/configStore.js";

async function main(): Promise<void> {
  const configPath = process.env.KGM_CONFIG_PATH ?? "data/kgm.config.json";
  const configStore = new ConfigStore({
    initial: loadConfigFromEnv(),
    persistPath: configPath,
    loadFromDisk: true,
  });
  const runtime = await createRuntimeWithStorage({ configStore });
  const server = createKgmServer({
    scheduler: runtime.scheduler,
    contextBuilder: runtime.contextBuilder,
    llmClient: runtime.llmClient,
    schemaRegistry: runtime.schemaRegistry,
    toolRegistry: runtime.toolRegistry,
    memoryStore: runtime.memoryStore,
    graphStore: runtime.graphStore,
    embedder: runtime.embedder,
    sandboxManager: runtime.sandboxManager,
    modelManager: runtime.modelManager,
    autoRoutingClient: runtime.autoRoutingClient,
    configStore: runtime.configStore,
    skillRuntime: runtime.skillRuntime,
    artifactStore: runtime.artifactStore,
    sessionStore: runtime.sessionStore,
  });

  const port = Number(process.env.PORT ?? 58691);
  server.listen(port, () => {
    console.log(`KGM server listening on ${port}`);
  });
}

function loadConfigFromEnv(): KgmConfigPatch {
  const embedding = pickDefined({
    baseUrl: process.env.KGM_EMBEDDING_BASE_URL,
    apiKey: process.env.KGM_EMBEDDING_API_KEY,
    model: process.env.KGM_EMBEDDING_MODEL,
    path: process.env.KGM_EMBEDDING_PATH,
    version: process.env.KGM_EMBEDDING_VERSION,
    timeoutMs: parseNumber(process.env.KGM_EMBEDDING_TIMEOUT_MS),
    provider: process.env.KGM_EMBEDDING_PROVIDER as "openai" | "custom" | "ollama" | undefined,
  });

  const llm = pickDefined({
    baseUrl: process.env.KGM_LLM_BASE_URL,
    apiKey: process.env.KGM_LLM_API_KEY,
    model: process.env.KGM_LLM_MODEL,
    path: process.env.KGM_LLM_PATH,
    mode: process.env.KGM_LLM_MODE as "completions" | "chat" | undefined,
    temperature: parseNumber(process.env.KGM_LLM_TEMPERATURE),
    maxTokens: parseNumber(process.env.KGM_LLM_MAX_TOKENS),
    timeoutMs: parseNumber(process.env.KGM_LLM_TIMEOUT_MS),
    provider: process.env.KGM_LLM_PROVIDER as "openai" | "custom" | "ollama" | undefined,
  });

  const database = pickDefined({
    provider: process.env.KGM_DB_PROVIDER as "sqlite" | "postgresql" | undefined,
    filePath: process.env.KGM_DB_PATH,
    journalMode: process.env.KGM_DB_JOURNAL as "WAL" | "DELETE" | undefined,
    host: process.env.KGM_DB_HOST,
    port: process.env.KGM_DB_PORT ? parseInt(process.env.KGM_DB_PORT) : undefined,
    database: process.env.KGM_DB_NAME,
    username: process.env.KGM_DB_USER,
    password: process.env.KGM_DB_PASSWORD,
    ssl: process.env.KGM_DB_SSL === 'true',
    maxConnections: process.env.KGM_DB_MAX_CONNECTIONS ? parseInt(process.env.KGM_DB_MAX_CONNECTIONS) : undefined,
    idleTimeout: process.env.KGM_DB_IDLE_TIMEOUT ? parseInt(process.env.KGM_DB_IDLE_TIMEOUT) : undefined,
    connectionTimeout: process.env.KGM_DB_CONNECTION_TIMEOUT ? parseInt(process.env.KGM_DB_CONNECTION_TIMEOUT) : undefined,
  });

  const vector = pickDefined({
    backend: process.env.KGM_VECTOR_BACKEND as "memory" | "chroma" | undefined,
    baseUrl: process.env.KGM_VECTOR_BASE_URL,
    apiPath: process.env.KGM_VECTOR_API_PATH,
    collection: process.env.KGM_VECTOR_COLLECTION,
    distance: process.env.KGM_VECTOR_DISTANCE as "cosine" | "l2" | undefined,
    timeoutMs: parseNumber(process.env.KGM_VECTOR_TIMEOUT_MS),
  });

  const adapter = pickDefined({
    enabled: parseBool(process.env.KGM_ADAPTER_ENABLED),
    baseUrl: process.env.KGM_ADAPTER_BASE_URL,
    secret: process.env.KGM_ADAPTER_SECRET,
    timeoutMs: parseNumber(process.env.KGM_ADAPTER_TIMEOUT_MS),
    sendPerformance: parseBool(process.env.KGM_ADAPTER_SEND_PERFORMANCE),
    sendContextQuality: parseBool(process.env.KGM_ADAPTER_SEND_CONTEXT_QUALITY),
    performancePath: process.env.KGM_ADAPTER_PERFORMANCE_PATH,
    contextQualityPath: process.env.KGM_ADAPTER_CONTEXT_QUALITY_PATH,
  });

  return {
    embedding: Object.keys(embedding).length ? embedding : undefined,
    llm: Object.keys(llm).length ? llm : undefined,
    database: Object.keys(database).length ? database : undefined,
    vector: Object.keys(vector).length ? vector : undefined,
    adapter: Object.keys(adapter).length ? adapter : undefined,
  };
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

function pickDefined<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== "") {
      result[key] = value;
    }
  }
  return result as T;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
