import type { KgmConfig } from "./configStore.js";

export const REDACTED_CONFIG_SECRET = "[REDACTED]";

function publicEndpoint<T extends { apiKey?: string }>(
  ep: T,
): Omit<T, "apiKey"> & { apiKeyConfigured: boolean } {
  const { apiKey, ...rest } = ep;
  return { ...rest, apiKeyConfigured: Boolean(apiKey) };
}

export type PublicKgmConfig = Omit<
  KgmConfig,
  "llm" | "embedding" | "media" | "database" | "adapter" | "ycb" | "yueliai" | "playground"
> & {
  llm: Omit<KgmConfig["llm"], "apiKey"> & { apiKeyConfigured: boolean };
  embedding: Omit<KgmConfig["embedding"], "apiKey"> & { apiKeyConfigured: boolean };
  media: {
    image: Omit<KgmConfig["media"]["image"], "apiKey"> & { apiKeyConfigured: boolean };
    speech: Omit<KgmConfig["media"]["speech"], "apiKey"> & { apiKeyConfigured: boolean };
    transcription: Omit<KgmConfig["media"]["transcription"], "apiKey"> & { apiKeyConfigured: boolean };
    video: Omit<KgmConfig["media"]["video"], "apiKey"> & { apiKeyConfigured: boolean };
    rerank: Omit<KgmConfig["media"]["rerank"], "apiKey"> & { apiKeyConfigured: boolean };
    providers?: Array<
      Omit<NonNullable<KgmConfig["media"]["providers"]>[number], "auth"> & {
        authConfigured: boolean;
        auth?: { type: string };
      }
    >;
    modelPresets?: KgmConfig["media"]["modelPresets"];
  };
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
    media: {
      image: publicEndpoint(config.media.image),
      speech: publicEndpoint(config.media.speech),
      transcription: publicEndpoint(config.media.transcription),
      video: publicEndpoint(config.media.video),
      rerank: publicEndpoint(config.media.rerank),
      modelPresets: config.media.modelPresets ?? [],
      providers: (config.media.providers ?? []).map((p) => {
        const auth = p.auth;
        let authConfigured = false;
        if (auth) {
          if (auth.type === "bearer" || auth.type === "token" || auth.type === "query_key") {
            authConfigured = Boolean(auth.apiKey || auth.apiKeyEnv);
          } else if (auth.type === "ak_sk_jwt") {
            authConfigured = Boolean(
              (auth.accessKey || auth.accessKeyEnv) && (auth.secretKey || auth.secretKeyEnv),
            );
          }
        }
        return {
          ...p,
          auth: auth ? { type: auth.type } : undefined,
          authConfigured,
        };
      }),
    },
    database: { ...database, passwordConfigured: Boolean(password) },
    adapter: { ...adapter, secretConfigured: Boolean(adapterSecret) },
    ycb: { ...ycb, apiKeyConfigured: Boolean(ycbApiKey) },
    yueliai: { ...yueliai, apiKeyConfigured: Boolean(yueliaiApiKey) },
    playground,
  };
}
