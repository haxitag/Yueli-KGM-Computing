/** YueliAI v1 统一响应外壳（与 www.yueli.com 云端一致） */
export type YueliAiTokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: Record<string, unknown>;
  completion_tokens_details?: Record<string, unknown>;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

export type YueliAiSearchHit = {
  id?: string;
  score?: number;
  text?: string;
  source?: string;
  [key: string]: unknown;
};

export type YueliAiData = {
  content?: string;
  embedding?: number[];
  usage?: YueliAiTokenUsage;
  model?: string;
  models?: YueliAiModelEntry[];
  /** search：知识库命中；无绑定时为空数组，backend 会回退 LLM 生成 content */
  hits?: YueliAiSearchHit[];
  citations?: string;
  used_knowledge_set_ids?: string[];
};

export type YueliAiModelEntry = {
  id: number;
  provider: string;
  model_name: string;
  title: string;
  model_type: string;
  display: string;
};

export type YueliAiError = {
  code: string;
  message: string;
};

export type YueliAiResponse = {
  success: boolean;
  service?: string;
  status?: string;
  timestamp?: string;
  data?: YueliAiData;
  error?: YueliAiError;
  requestId?: string;
};

export type YueliAiCompletionsRequest = {
  model?: string;
  input?: string;
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
};

export type YueliAiEmbeddingsRequest = {
  model?: string;
  input: string | string[];
};

export type YueliAiSearchRequest = {
  query: string;
  model?: string;
  knowledge_set_ids?: string[];
  top_k?: number;
};

export type YueliAiPlanningRequest = {
  input: string;
  model?: string;
};
