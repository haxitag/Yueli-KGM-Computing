/**
 * 云端模型目录与别名（与 yuelicopilot cloudLlmPresetModels 对齐）。
 * 列表仅用于注册「可路由」模型 id；是否出现在 /v1/models 由 provider 是否已配置 apiKey 决定。
 */

export type CloudModelEntry = {
  id: string;
  owned_by: string;
  aliases?: string[];
};

/** 规范 model id → 别名列表（小写匹配） */
export const CLOUD_MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4": "deepseek-v4-flash",
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
  "gpt-4o-mini": "gpt-5.4-mini",
  "gpt-4o": "gpt-5.4-mini",
  "glm-4-flash": "glm-5.1",
  "glm-4-plus": "glm-5.1",
  "moonshot-v1-8k": "kimi-k2.6",
  "qwen-plus": "qwen-3.6",
  "qwen-max": "qwen-3.6",
};

export const DEFAULT_CLOUD_MODEL_CATALOG: CloudModelEntry[] = [
  { id: "gpt-5.5", owned_by: "openai", aliases: ["gpt-5.4", "gpt-4.1"] },
  { id: "gpt-5.4-mini", owned_by: "openai", aliases: ["gpt-4o-mini", "gpt-4o"] },
  { id: "gpt-oss", owned_by: "openai" },
  { id: "glm-5.1", owned_by: "zhipu", aliases: ["glm-5.0", "glm-4-flash"] },
  { id: "glm-5.0", owned_by: "zhipu" },
  { id: "mimo-2.5", owned_by: "xiaomi" },
  { id: "gemini-3.1", owned_by: "google", aliases: ["gemini-3.0"] },
  { id: "gemini-3.0", owned_by: "google" },
  { id: "claude-sonnet-4.6", owned_by: "anthropic" },
  { id: "claude-opus-4.7", owned_by: "anthropic" },
  { id: "kimi-k2.6", owned_by: "moonshot", aliases: ["kimi-2.6", "moonshot-v1-8k"] },
  { id: "kimi-k2.5", owned_by: "moonshot", aliases: ["kimi-2.5"] },
  { id: "minimax-2.7", owned_by: "minimax", aliases: ["minimax-2.5"] },
  { id: "minimax-2.5", owned_by: "minimax" },
  { id: "deepseek-v4-flash", owned_by: "deepseek", aliases: ["deepseek-v4", "deepseek-chat", "deepseek-3.2"] },
  { id: "deepseek-v4-pro", owned_by: "deepseek", aliases: ["deepseek-reasoner"] },
  { id: "qwen-3.6", owned_by: "qwen", aliases: ["qwen-3.5", "qwen-plus", "qwen-max"] },
  { id: "qwen-3.5", owned_by: "qwen" },
  { id: "deepseek-r1", owned_by: "modelscope" },
  { id: "llama3-70b", owned_by: "modelscope" },
];

/**
 * 将请求 model 解析为目录中的规范 id（未知则原样返回）。
 */
export function resolveCloudModelAlias(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const entry of DEFAULT_CLOUD_MODEL_CATALOG) {
    if (entry.id.toLowerCase() === lower) return entry.id;
    for (const alias of entry.aliases ?? []) {
      if (alias.toLowerCase() === lower) return entry.id;
    }
  }
  const mapped = CLOUD_MODEL_ALIASES[lower];
  return mapped ?? trimmed;
}

export function isProviderConfigured(provider: {
  apiKey?: string | null;
  apiKeys?: string[] | null;
}): boolean {
  if (provider.apiKey?.trim()) return true;
  if (provider.apiKeys?.some((k) => k?.trim())) return true;
  return false;
}
