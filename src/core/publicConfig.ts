import type { KgmConfig } from "./configStore.js";

export const REDACTED_CONFIG_SECRET = "[REDACTED]";

export type PublicKgmConfig = Omit<
  KgmConfig,
  "llm" | "embedding" | "database" | "adapter" | "ycb" | "yueliai" | "playground"
> & {
  llm: Omit<KgmConfig["llm"], "apiKey"> & { apiKeyConfigured: boolean };
  embedding: Omit<KgmConfig["embedding"], "apiKey"> & { apiKeyConfigured: boolean };
  database: Omit<KgmConfig["database"], "password"> & { passwordConfigured: boolean };
  adapter: Omit<KgmConfig["adapter"], "secret"> & { secretConfigured: boolean };
  ycb: Omit<KgmConfig["ycb"], "apiKey"> & { apiKeyConfigured: boolean };
  yueliai: Omit<KgmConfig["yueliai"], "apiKey"> & { apiKeyConfigured: boolean };
  playground: KgmConfig["playground"];
};

/**
 * HTTP 配置响应不能回显秘密。写接口仍接受 apiKey/password patch，
 * 但 GET/POST 响应只返回 configured 标记。
 */
export function toPublicKgmConfig(config: KgmConfig): PublicKgmConfig {
  const { apiKey: llmApiKey, ...llm } = config.llm;
  const { apiKey: embeddingApiKey, ...embedding } = config.embedding;
  const { password, ...database } = config.database;
  const { secret: adapterSecret, ...adapter } = config.adapter;
  const { apiKey: ycbApiKey, ...ycb } = config.ycb;
  const { apiKey: yueliaiApiKey, ...yueliai } = config.yueliai;
  const playground = {
    ...config.playground,
    mcpConnectors: config.playground.mcpConnectors.map((connector) => ({
      ...connector,
      headers: connector.headers
        ? Object.fromEntries(
            Object.keys(connector.headers).map((key) => [key, REDACTED_CONFIG_SECRET]),
          )
        : undefined,
    })),
  };

  return {
    ...config,
    llm: { ...llm, apiKeyConfigured: Boolean(llmApiKey) },
    embedding: { ...embedding, apiKeyConfigured: Boolean(embeddingApiKey) },
    database: { ...database, passwordConfigured: Boolean(password) },
    adapter: { ...adapter, secretConfigured: Boolean(adapterSecret) },
    ycb: { ...ycb, apiKeyConfigured: Boolean(ycbApiKey) },
    yueliai: { ...yueliai, apiKeyConfigured: Boolean(yueliaiApiKey) },
    playground,
  };
}
