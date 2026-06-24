import type { MaaSModelEntry } from "./types.js";

/**
 * 各 MaaS 服务商最新 3 款旗舰模型（与 yuelicopilot cloudLlmPresetModels 对齐并扩展）。
 * 列表用于 /v1/models 注册与别名解析；是否可调用由 provider apiKey 决定。
 */
export const MAAS_LATEST_MODEL_CATALOG: MaaSModelEntry[] = [
  // Anthropic — adaptive thinking（Opus 4.7+ / Sonnet 4.6+ / Fable 5）
  {
    id: "claude-opus-4.8",
    owned_by: "anthropic",
    provider: "anthropic",
    aliases: ["claude-opus-4-8", "opus-4.8"],
    reasoningMode: "anthropic_adaptive",
    messagesPath: "/v1/messages",
  },
  {
    id: "claude-opus-4.7",
    owned_by: "anthropic",
    provider: "anthropic",
    aliases: ["claude-opus-4-7", "opus-4.7"],
    reasoningMode: "anthropic_adaptive",
    messagesPath: "/v1/messages",
  },
  {
    id: "claude-sonnet-4.6",
    owned_by: "anthropic",
    provider: "anthropic",
    aliases: ["claude-sonnet-4-6", "sonnet-4.6"],
    reasoningMode: "anthropic_adaptive",
    messagesPath: "/v1/messages",
  },
  {
    id: "claude-fable-5",
    owned_by: "anthropic",
    provider: "anthropic",
    aliases: ["fable-5", "claude-fable5"],
    reasoningMode: "anthropic_adaptive",
    messagesPath: "/v1/messages",
  },

  // 智谱 GLM-5.x — OpenAI-compat + thinking
  {
    id: "glm-5.2",
    owned_by: "zhipu",
    provider: "zhipu",
    aliases: ["glm5.2", "glm-5-2"],
    reasoningMode: "glm_thinking",
    chatPath: "/chat/completions",
  },
  {
    id: "glm-5.1",
    owned_by: "zhipu",
    provider: "zhipu",
    aliases: ["glm5.1", "glm-5-1", "glm-4-flash", "glm-4-plus"],
    reasoningMode: "glm_thinking",
    chatPath: "/chat/completions",
  },
  {
    id: "glm-5.0",
    owned_by: "zhipu",
    provider: "zhipu",
    aliases: ["glm5.0", "glm-5", "glm-5-0"],
    reasoningMode: "glm_thinking",
    chatPath: "/chat/completions",
  },

  // Moonshot Kimi 2.x — OpenAI-compat + reasoning_content
  {
    id: "kimi-2.7",
    owned_by: "moonshot",
    provider: "moonshot",
    aliases: ["kimi-k2.7", "kimi-k2-7", "moonshot-v1-128k"],
    reasoningMode: "kimi_thinking",
    chatPath: "/v1/chat/completions",
  },
  {
    id: "kimi-2.6",
    owned_by: "moonshot",
    provider: "moonshot",
    aliases: ["kimi-k2.6", "kimi-k2-6", "kimi-2.6", "moonshot-v1-32k"],
    reasoningMode: "kimi_thinking",
    chatPath: "/v1/chat/completions",
  },
  {
    id: "kimi-2.5",
    owned_by: "moonshot",
    provider: "moonshot",
    aliases: ["kimi-k2.5", "kimi-k2-5", "moonshot-v1-8k"],
    reasoningMode: "kimi_thinking",
    chatPath: "/v1/chat/completions",
  },

  // MiniMax — OpenAI-compat（2.5–3.0）
  {
    id: "minimax-3.0",
    owned_by: "minimax",
    provider: "minimax",
    aliases: ["minimax-m2.7", "abab7-chat"],
    reasoningMode: "minimax_thinking",
    chatPath: "/chat/completions",
  },
  {
    id: "minimax-2.7",
    owned_by: "minimax",
    provider: "minimax",
    aliases: ["minimax-m2.7-preview", "minimax-2.7-preview"],
    reasoningMode: "minimax_thinking",
    chatPath: "/chat/completions",
  },
  {
    id: "minimax-2.6",
    owned_by: "minimax",
    provider: "minimax",
    aliases: ["minimax-m2.6", "abab6.5-chat"],
    reasoningMode: "minimax_thinking",
    chatPath: "/chat/completions",
  },
  {
    id: "minimax-2.5",
    owned_by: "minimax",
    provider: "minimax",
    aliases: ["minimax-m2.5"],
    reasoningMode: "minimax_thinking",
    chatPath: "/chat/completions",
  },
];

/** 历史别名（非「最新 3 款」但仍需路由） */
export const MAAS_LEGACY_ALIASES: Record<string, string> = {
  "deepseek-v4": "deepseek-v4-flash",
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
  "gpt-4o-mini": "gpt-5.4-mini",
  "gpt-4o": "gpt-5.4-mini",
  "glm-4-flash": "glm-5.1",
  "glm-4-plus": "glm-5.1",
  "moonshot-v1-8k": "kimi-2.6",
  "qwen-plus": "qwen-3.6",
  "qwen-max": "qwen-3.6",
  "claude-opus-4.6": "claude-opus-4.7",
};

export function findMaaSModelEntry(modelId: string): MaaSModelEntry | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  for (const entry of MAAS_LATEST_MODEL_CATALOG) {
    if (entry.id.toLowerCase() === lower) return entry;
    for (const alias of entry.aliases ?? []) {
      if (alias.toLowerCase() === lower) return entry;
    }
  }
  return undefined;
}

export function resolveMaaSModelAlias(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const entry = findMaaSModelEntry(trimmed);
  if (entry) return entry.id;
  const mapped = MAAS_LEGACY_ALIASES[trimmed.toLowerCase()];
  return mapped ?? trimmed;
}

export function listMaaSModelsForCatalog(): Array<{ id: string; owned_by: string; aliases?: string[] }> {
  return MAAS_LATEST_MODEL_CATALOG.map((e) => ({
    id: e.id,
    owned_by: e.owned_by,
    aliases: e.aliases,
  }));
}
