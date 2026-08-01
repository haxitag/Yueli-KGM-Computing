/** MaaS 推理模式：各厂商 thinking / reasoning 参数的统一表示 */
export type MaaSThinkingParam =
  | boolean
  | {
      type: "enabled" | "disabled" | "adaptive";
      budget_tokens?: number;
      display?: "full" | "omitted";
      [key: string]: unknown;
    };

export type MaaSOutputConfig = {
  effort?: "low" | "medium" | "high" | "max";
  [key: string]: unknown;
};

export type MaaSChatMessage = {
  role: string;
  content: string | unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

/** OpenAI Chat / 各 MaaS 扩展请求字段（编排层与直通层共享） */
export type MaaSOpenAiChatExtras = {
  thinking?: MaaSThinkingParam;
  /** 智谱 GLM / 部分聚合商 */
  enable_thinking?: boolean;
  /** OpenAI o-series / 部分路由 */
  reasoning_effort?: "low" | "medium" | "high" | "max" | string;
  output_config?: MaaSOutputConfig;
  response_format?: Record<string, unknown>;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  top_p?: number;
  stop?: string | string[];
  /** 透传未建模字段 */
  extraBody?: Record<string, unknown>;
};

export type MaaSProviderId =
  | "anthropic"
  | "zhipu"
  | "moonshot"
  | "minimax"
  | "deepseek"
  | "openai"
  | "qwen"
  | "google";

export type MaaSReasoningMode =
  | "none"
  | "openai_reasoning_content"
  | "glm_thinking"
  | "anthropic_adaptive"
  | "anthropic_budget"
  | "kimi_thinking"
  | "minimax_thinking"
  | "deepseek_reasoner";

export type MaaSModelEntry = {
  id: string;
  owned_by: string;
  provider: MaaSProviderId;
  aliases?: string[];
  reasoningMode: MaaSReasoningMode;
  /** 官方 API 路径（相对 baseUrl） */
  chatPath?: string;
  messagesPath?: string;
};
