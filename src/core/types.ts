export type SignalType =
  | "web"
  | "app"
  | "location"
  | "time"
  | "weather"
  | "habit"
  | "knowledge_graph"
  | "retrieval"
  | "system";

export type Signal = {
  type: SignalType;
  source: string;
  title?: string;
  value?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type ConversationRole = "system" | "user" | "assistant" | "tool";

export type ConversationMessage = {
  role: ConversationRole;
  content: string;
  name?: string;
  toolCallId?: string;
};

export type Evidence = {
  id: string;
  text: string;
  score: number;
  source: string;
  artifact_ref?: {
    id: string;
    contentType: "application/json" | "text/plain";
    sizeBytes: number;
    sha256: string;
    preview: string;
  };
};

export type SessionRef = {
  id: string;
  sizeBytes: number;
  preview: string;
  updatedAt: string;
};

export type Constraints = {
  language?: string;
  style?: string;
  riskLevel?: "low" | "medium" | "high";
  maxTokens?: number;
};

export type RoutingProfile = "cost_first" | "quality_first" | "manual";

export type RoutingPrivacyLevel = "standard" | "sensitive" | "strict";

export type RoutingTarget = {
  model?: string;
  provider?: string;
  runtimeId?: string;
};

export type RoutingHints = {
  enabled?: boolean;
  profile?: RoutingProfile;
  taskType?: string;
  taskName?: string;
  privacyLevel?: RoutingPrivacyLevel;
  verificationExpected?: boolean;
  maxCostPerRequest?: number;
  target?: RoutingTarget;
};

export type KgmGraphTriple = {
  subject: string;
  predicate: string;
  object: string;
  weight?: number;
};

export type KgmRetrievalOptions = {
  topK?: number;
  strategy?: "vector" | "hybrid";
  namespaces?: string[];
  requireCanonicalEmbedding?: boolean;
};

export type KgmGraphOptions = {
  enabled?: boolean;
  entities?: string[];
  relations?: string[];
  triples?: KgmGraphTriple[];
  subgraph?: string;
  reasoningMode?: "entity" | "path" | "subgraph";
};

export type KgmOpsMetadata = {
  deployment?: "self_hosted" | "managed";
  slaOwner?: "self" | "vendor";
  traceId?: string;
  tags?: string[];
};

export type KgmCapabilityOptions = {
  mode?: "internal" | "external" | "hybrid";
  includeBuiltinTools?: boolean;
  allowUnregisteredTools?: boolean;
  executeToolCalls?: boolean;
  preferredKinds?: Array<CapabilityKind>;
};

export type KgmPlaygroundRequestHints = {
  /** 单次请求额外系统提示（与 Config 中激活技能叠加） */
  extraSystemPrompt?: string;
};

/**
 * 与 YCB（外置 ContextBuilder 服务）协作的显式槽位，避免把复杂约定塞进无类型 metadata。
 * 仍可与 metadata 中的 `ycb_*` 键并存；解析优先级见 docs/kgm-haxitag-ycb-alignment.md。
 */
export type KgmYcbHints = {
  /** YCB 侧已物化的上下文构建句柄 / 构建 ID */
  buildRef?: string;
  collectionId?: string;
  /** 为 true 时跳过本次 YCB 拉取（即使全局启用） */
  skip?: boolean;
};

export type KgmExtensions = {
  retrieval?: KgmRetrievalOptions;
  graph?: KgmGraphOptions;
  ops?: KgmOpsMetadata;
  capabilities?: KgmCapabilityOptions;
  playground?: KgmPlaygroundRequestHints;
  ycb?: KgmYcbHints;
};

export type ToolPolicy = {
  allowed: string[];
  maxRounds: number;
};

export type ToolResult = {
  name: string;
  output: Record<string, unknown>;
  success: boolean;
  error?: string;
};

export type CapabilityKind = "function" | "tool" | "skill";

export type CapabilityMetadata = {
  latency?: "fast" | "medium" | "slow";
  sideEffect?: boolean;
  costLevel?: "low" | "medium" | "high";
  permission?: string;
  maxRetries?: number;
  tags?: string[];
  integration?: "builtin" | "external" | "graph" | "retrieval";
};

export type SandboxKind = "computer" | "browser" | "mobile";

export type SandboxStatus = "stopped" | "starting" | "running" | "error";

export type SandboxPreview = {
  cpuPercent: number;
  memoryMb: number;
  networkKbps: number;
  uptimeSec: number;
  lastUpdatedAt: string;
  title: string;
  detail: string;
};

export type SandboxInstance = {
  id: string;
  kind: SandboxKind;
  name: string;
  status: SandboxStatus;
  runtimeMode: "simulated" | "external";
  adapterHint: string;
  notes: string[];
  createdAt: string;
  updatedAt: string;
  preview: SandboxPreview;
};

export type ContextPack = {
  requestId: string;
  userId: string;
  sessionId?: string;
  session_ref?: SessionRef;
  input: string;
  signals: Signal[];
  conversation?: ConversationMessage[];
  evidence: Evidence[];
  constraints: Constraints;
  toolPolicy: ToolPolicy;
  toolResults: ToolResult[];
  kgm?: KgmExtensions;
};

export type KgmRequest = {
  requestId?: string;
  userId: string;
  sessionId?: string;
  input: string;
  model?: string;
  signals?: Signal[];
  conversation?: ConversationMessage[];
  constraints?: Constraints;
  toolPolicy?: ToolPolicy;
  metadata?: Record<string, unknown>;
  kgm?: KgmExtensions;
  routing?: RoutingHints;
};

export type KgmResponse = {
  requestId: string;
  type: "final";
  content: string;
  toolResults: ToolResult[];
  metadata?: Record<string, unknown>;
  kgm?: KgmExtensions;
};

export type LlmIntentFinal = {
  type: "final";
  content: string;
};

export type LlmIntentCall = {
  type: "call";
  target: string;
  arguments: Record<string, unknown>;
};

export type LlmIntentSkill = {
  type: "invoke_skill";
  skill: string;
  input: Record<string, unknown>;
};

export type LlmIntent = LlmIntentFinal | LlmIntentCall | LlmIntentSkill;

export type ToolDefinition = {
  name: string;
  kind?: CapabilityKind;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  metadata?: CapabilityMetadata;
};

export type ToolExecutor = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type SkillStep = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
};

export type SkillDefinition = {
  name: string;
  description: string;
  steps: SkillStep[];
};
