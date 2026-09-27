/**
 * 云端模型目录与别名（与 yuelicopilot cloudLlmPresetModels 对齐）。
 * 列表仅用于注册「可路由」模型 id；是否出现在 /v1/models 由 provider 是否已配置 apiKey 决定。
 */

import {
  MAAS_LATEST_MODEL_CATALOG,
  MAAS_LEGACY_ALIASES,
  resolveMaaSModelAlias,
  findMaaSModelEntry,
} from "../llm/maas/catalog.js";

export type CloudModelEntry = {
  id: string;
  owned_by: string;
  aliases?: string[];
};

/** 规范 model id → 别名列表（小写匹配） */
export const CLOUD_MODEL_ALIASES: Record<string, string> = {
  ...MAAS_LEGACY_ALIASES,
};

/** MaaS 最新旗舰 + 其他云模型 */
export const DEFAULT_CLOUD_MODEL_CATALOG: CloudModelEntry[] = [
  ...MAAS_LATEST_MODEL_CATALOG.map((e) => ({
    id: e.id,
    owned_by: e.owned_by,
    aliases: e.aliases,
  })),
  { id: "gpt-5.5", owned_by: "openai", aliases: ["gpt-5.4", "gpt-4.1"] },
  { id: "gpt-5.4-mini", owned_by: "openai", aliases: ["gpt-4o-mini", "gpt-4o"] },
  { id: "gpt-oss", owned_by: "openai" },
  { id: "mimo-v2.5-pro", owned_by: "xiaomi", aliases: ["mimo-2.5", "mimo-2.5-pro"] },
  { id: "mimo-v2.5", owned_by: "xiaomi", aliases: ["mimo-v2.5-omni"] },
  { id: "mimo-v2.5-pro-ultraspeed", owned_by: "xiaomi" },
  { id: "gemini-3.1", owned_by: "google", aliases: ["gemini-3.0"] },
  { id: "gemini-3.0", owned_by: "google" },
  { id: "deepseek-v4-flash", owned_by: "deepseek", aliases: ["deepseek-v4", "deepseek-chat", "deepseek-3.2"] },
  { id: "deepseek-v4-pro", owned_by: "deepseek", aliases: ["deepseek-reasoner"] },
  { id: "qwen-3.6", owned_by: "qwen", aliases: ["qwen-3.5", "qwen-plus", "qwen-max"] },
  { id: "qwen-3.5", owned_by: "qwen" },
  { id: "deepseek-r1", owned_by: "modelscope" },
  { id: "llama3-70b", owned_by: "modelscope" },
];

/**
 * 将请求 model 解析为目录中的规范 id（未知则原样返回）。
 * 合并 MaaS 目录 + DEFAULT_CLOUD_MODEL_CATALOG 别名。
 */
export function resolveCloudModelAlias(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const maas = resolveMaaSModelAlias(trimmed);
  if (maas !== trimmed) return maas;

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

/** True when two model ids refer to the same catalog entry (or are equal). */
export function modelsMatchByAlias(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = resolveCloudModelAlias(a);
  const rb = resolveCloudModelAlias(b);
  return ra === rb || ra === b || rb === a;
}

export function getCloudModelEntry(modelId: string) {
  const canonical = resolveCloudModelAlias(modelId);
  return findMaaSModelEntry(canonical) ?? findMaaSModelEntry(modelId);
}

export function isProviderConfigured(provider: {
  apiKey?: string | null;
  apiKeys?: string[] | null;
}): boolean {
  if (provider.apiKey?.trim()) return true;
  if (provider.apiKeys?.some((k) => k?.trim())) return true;
  return false;
}
