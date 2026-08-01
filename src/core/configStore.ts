import { CANONICAL_EMBEDDING } from "./config.js";
import { REDACTED_CONFIG_SECRET } from "./publicConfig.js";
import type { BusinessRoutingConfig } from "../routing/businessRouting.js";
import type { RoutingProfile, RoutingTarget, SkillStep } from "./types.js";
import type { MediaModelPreset, MediaProviderConfig } from "../openai/mediaProviderTypes.js";
import fs from "node:fs";
import path from "node:path";

export type { MediaModelPreset, MediaProviderConfig } from "../openai/mediaProviderTypes.js";

export type EmbeddingConfig = {
  provider: "openai" | "custom" | "ollama";
  baseUrl: string;
  apiKey?: string;
  model: string;
  path: string;
  version: string;
  timeoutMs?: number;
};

/** OpenAI-compatible media upstream (images / TTS / STT / video / rerank). Empty `baseUrl` = not configured. */
export type MediaEndpointConfig = {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  path?: string;
  timeoutMs?: number;
};

/** Video upstream extras for async jobs. */
export type VideoMediaConfig = MediaEndpointConfig & {
  /** Max requested duration seconds (default 30); reject higher with 400. */
  maxDurationSec?: number;
  /** Prefer url vs b64 when documenting result shape (does not strip fields). */
  resultMode?: "url" | "b64";
  /** Max concurrent in-flight video jobs (default 2). */
  maxConcurrent?: number;
  /** Optional upstream status path template, `{id}` replaced when polling async upstream. */
  statusPath?: string;
};

export type MediaConfig = {
  image: MediaEndpointConfig;
  speech: MediaEndpointConfig;
  transcription: MediaEndpointConfig;
  video: VideoMediaConfig;
  rerank: MediaEndpointConfig;
  /**
   * Declarative host endpoints (local or cloud). Same schema for all vendors;
   * model identity lives in `modelPresets` / request `model`.
   */
  providers?: MediaProviderConfig[];
  /** Optional model identity catalog (Flux / Banana / SD / …). */
  modelPresets?: MediaModelPreset[];
};

export type LlmConfig = {
  provider: "openai" | "custom" | "ollama";
  baseUrl: string;
  apiKey?: string;
  model: string;
  path: string;
  mode: "completions" | "chat";
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
};

export type DatabaseConfig = {
  provider: "sqlite" | "postgresql";
  // SQLite 配置
  filePath?: string;
  journalMode?: "WAL" | "DELETE";
  // PostgreSQL 配置
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  maxConnections?: number;
  idleTimeout?: number;
  connectionTimeout?: number;
};

export type VectorConfig = {
  backend: "memory" | "chroma";
  baseUrl?: string;
  apiPath?: string;
  collection?: string;
  distance?: "cosine" | "l2";
  timeoutMs?: number;
};

export type ContextConfig = {
  artifactDir: string;
  sessionDir: string;
  maxToolOutputChars: number;
  maxEvidenceChars: number;
  artifactPreviewChars: number;
  sessionPreviewChars: number;
  /**
   * 对同一 (userId, input, topK, 混合选项) 的记忆检索结果内存缓存时间（毫秒）；0 表示关闭。
   * 多进程/集群部署不共享该缓存。
   */
  retrievalCacheTtlMs: number;
  enableArtifactTool: boolean;
  enableSessionTool: boolean;
  enableToolCatalogTool: boolean;
  toolDescriptorMode: "full" | "names";
  includeSkillNames: boolean;
  /** Default cap for knowledge_graph signal triples (overridden by kgm.graph.maxTriples / KGM_GRAPH_MAX_TRIPLES). */
  graphMaxTriples?: number;
};

export type AdapterConfig = {
  enabled: boolean;
  baseUrl: string;
  secret?: string;
  timeoutMs?: number;
  sendPerformance: boolean;
  sendContextQuality: boolean;
  performancePath: string;
  contextQualityPath: string;
};

export type YcbConfig = {
  /** 外置 YCB / ContextBuilder 服务；关闭时不阻塞推理主路径 */
  enabled: boolean;
  baseUrl: string;
  /** 相对 baseUrl，如 /api/v1/context/for-kgm */
  path: string;
  apiKey?: string;
  timeoutMs?: number;
  /** HTTP 失败或超时时返回空证据，不抛错 */
  failOpen: boolean;
  /**
   * 为 true 时仅当请求携带 `kgm.ycb.buildRef` 或 metadata `ycb_build_ref` 时才请求 YCB。
   * 为 false 时可用 query 驱动（由 YCB 侧解释 metadata）。
   */
  requireBuildRef: boolean;
};

/** 阅粒云端 YueliAI v1 推理聚合网关（Playground / KGM 统一配置） */
export type YueliAiGatewayConfig = {
  enabled: boolean;
  host: string;
  apiKey?: string;
  upstreamPrefix: string;
  timeoutMs: number;
};

export type YueliAiGatewayConfigPatch = Partial<YueliAiGatewayConfig>;

/** Optional local operator workers (deploy-time). */
export type LlamaCppWorkerConfig = {
  /** on | off | auto — see docs/算子几llamaCPP.md */
  enabled: "on" | "off" | "auto";
  /** llama-server binary or PATH name */
  command: string;
  installHint?: string;
};

/** antirez/ds4 (DwarfStar) — DeepSeek V4 / GLM specialized worker */
export type Ds4WorkerConfig = {
  /** on | off | auto */
  enabled: "on" | "off" | "auto";
  /** ds4-server binary or PATH name */
  command: string;
  installHint?: string;
  /** Optional working directory for ds4 --chdir */
  chdir?: string;
};

/** Optional TokenSpeed OpenAI-compat worker (default off — does not pollute default builds) */
export type TokenSpeedWorkerConfig = {
  /** on | off | auto — default off */
  enabled: "on" | "off" | "auto";
  command: string;
  installHint?: string;
  /** Attach to an already-running OpenAI-compat endpoint (production preferred) */
  baseUrl?: string;
  port?: number;
  /** Prefer attach over spawn */
  attach?: boolean;
  toolCallParser?: string;
  reasoningParser?: string;
  enablePrefixCaching?: boolean;
  extraArgs?: string[];
};

export type WorkersConfig = {
  llamaCpp: LlamaCppWorkerConfig;
  ds4: Ds4WorkerConfig;
  tokenspeed: TokenSpeedWorkerConfig;
};

export type WorkersConfigPatch = {
  llamaCpp?: Partial<LlamaCppWorkerConfig>;
  ds4?: Partial<Ds4WorkerConfig>;
  tokenspeed?: Partial<TokenSpeedWorkerConfig>;
};

/** Playground-configurable sandbox adapter overlays (merged with KGM_SANDBOX_* env). */
export type SandboxKindAdapterConfig = {
  /** Prefer bundled adapter scripts when no explicit start command */
  useEmbedded?: boolean;
  startCommand?: string;
  stopCommand?: string;
  statusCommand?: string;
  endpoint?: string;
  hint?: string;
};

export type SandboxAdaptersConfig = {
  computer: SandboxKindAdapterConfig;
  browser: SandboxKindAdapterConfig;
  mobile: SandboxKindAdapterConfig;
};

/** Patch may set useEmbedded to null to clear the ConfigStore override (fall back to env). */
export type SandboxKindAdapterConfigPatch = {
  useEmbedded?: boolean | null;
  startCommand?: string;
  stopCommand?: string;
  statusCommand?: string;
  endpoint?: string;
  hint?: string;
};

export type SandboxAdaptersConfigPatch = {
  computer?: SandboxKindAdapterConfigPatch;
  browser?: SandboxKindAdapterConfigPatch;
  mobile?: SandboxKindAdapterConfigPatch;
};

export type ModelPricingConfig = {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  currency: string;
};

export type AutoRoutingRuleConfig = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  taskType?: string;
  taskName?: string;
  keywords?: string[];
  target: {
    model?: string;
    provider?: string;
    runtimeId?: string;
  };
  note?: string;
};

export type AutoRoutingEvaluationTargetConfig = RoutingTarget;

export type AutoRoutingEvaluatorConfig = {
  enabled: boolean;
  target: AutoRoutingEvaluationTargetConfig;
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
};

export type AutoRoutingEvaluationConfig = {
  enabled: boolean;
  fallbackToHeuristics: boolean;
  judge: AutoRoutingEvaluatorConfig;
  verifier: AutoRoutingEvaluatorConfig;
};

export type AutoRoutingConfig = {
  enabled: boolean;
  allowDynamicSelection: boolean;
  defaultProfile: RoutingProfile;
  defaultTaskType: string;
  preferVerifiableTasks: boolean;
  auditEnabled: boolean;
  thresholds: {
    maxCandidateCount: number;
    maxCostPerRequest: number;
    targetLatencyMs: number;
    minSampleCount: number;
  };
  weights: {
    successRate: number;
    quality: number;
    latency: number;
    cost: number;
    trust: number;
    verification: number;
  };
  pricing: {
    default: ModelPricingConfig;
    overrides: Record<string, ModelPricingConfig>;
  };
  evaluation: AutoRoutingEvaluationConfig;
  taskRoutes: AutoRoutingRuleConfig[];
};

export type AutoRoutingEvaluatorConfigPatch = Partial<AutoRoutingEvaluatorConfig> & {
  target?: Partial<AutoRoutingEvaluationTargetConfig>;
};

export type AutoRoutingEvaluationConfigPatch = Partial<AutoRoutingEvaluationConfig> & {
  judge?: AutoRoutingEvaluatorConfigPatch;
  verifier?: AutoRoutingEvaluatorConfigPatch;
};

/** `evaluation` 单独 deep-patch；不可与 `Partial<AutoRoutingConfig>` 直接相交，否则 TS 会要求写满 judge/verifier。 */
export type AutoRoutingConfigPatch = Omit<Partial<AutoRoutingConfig>, "evaluation"> & {
  thresholds?: Partial<AutoRoutingConfig["thresholds"]>;
  weights?: Partial<AutoRoutingConfig["weights"]>;
  pricing?: {
    default?: Partial<ModelPricingConfig>;
    overrides?: Record<string, Partial<ModelPricingConfig>>;
  };
  evaluation?: AutoRoutingEvaluationConfigPatch;
  taskRoutes?: AutoRoutingRuleConfig[];
};

/** Playground 持久化技能（映射为运行时 SkillDefinition） */
export type PlaygroundSkillConfigEntry = {
  id: string;
  name: string;
  description: string;
  steps: SkillStep[];
  /** 激活时拼入 LLM 系统提示 */
  systemPromptAddon?: string;
  skillMdPath?: string;
};

export type McpConnectorConfigEntry = {
  id: string;
  name: string;
  enabled: boolean;
  /** HTTP 基址，需实现 MCP JSON-RPC（如远端网关） */
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
};

export type OutputTemplateConfigEntry = {
  id: string;
  name: string;
  kind: "markdown" | "html" | "json";
  /** 支持 {{var}} 插槽；content 常为模型原文 */
  template: string;
  slots?: string[];
};

export type PlaygroundConfig = {
  skills: PlaygroundSkillConfigEntry[];
  mcpConnectors: McpConnectorConfigEntry[];
  outputTemplates: OutputTemplateConfigEntry[];
  activeSkillIds: string[];
  activeMcpIds: string[];
  activeOutputTemplateId: string | null;
};

export type PlaygroundConfigPatch = Partial<PlaygroundConfig>;

export type KgmConfig = {
  embedding: EmbeddingConfig;
  llm: LlmConfig;
  media: MediaConfig;
  database: DatabaseConfig;
  vector: VectorConfig;
  context: ContextConfig;
  adapter: AdapterConfig;
  ycb: YcbConfig;
  routing: BusinessRoutingConfig;
  autoRouting: AutoRoutingConfig;
  yueliai: YueliAiGatewayConfig;
  workers: WorkersConfig;
  sandboxAdapters: SandboxAdaptersConfig;
  playground: PlaygroundConfig;
};

export type KgmConfigPatch = {
  embedding?: Partial<EmbeddingConfig>;
  llm?: Partial<LlmConfig>;
  media?: {
    image?: Partial<MediaEndpointConfig>;
    speech?: Partial<MediaEndpointConfig>;
    transcription?: Partial<MediaEndpointConfig>;
    video?: Partial<VideoMediaConfig>;
    rerank?: Partial<MediaEndpointConfig>;
    providers?: MediaProviderConfig[];
    modelPresets?: MediaModelPreset[];
  };
  database?: Partial<DatabaseConfig>;
  vector?: Partial<VectorConfig>;
  context?: Partial<ContextConfig>;
  adapter?: Partial<AdapterConfig>;
  ycb?: Partial<YcbConfig>;
  routing?: Partial<BusinessRoutingConfig>;
  autoRouting?: AutoRoutingConfigPatch;
  yueliai?: YueliAiGatewayConfigPatch;
  workers?: WorkersConfigPatch;
  sandboxAdapters?: SandboxAdaptersConfigPatch;
  playground?: PlaygroundConfigPatch;
};

const defaultConfig: KgmConfig = {
  embedding: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: CANONICAL_EMBEDDING.modelName,
    path: "/embeddings",
    version: CANONICAL_EMBEDDING.version,
    timeoutMs: 15000,
  },
  llm: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    path: "/chat/completions",
    mode: "chat",
    temperature: 0.2,
    maxTokens: 512,
    timeoutMs: 30000,
  },
  media: {
    image: { baseUrl: "", path: "/images/generations" },
    speech: { baseUrl: "", path: "/audio/speech" },
    transcription: { baseUrl: "", path: "/audio/transcriptions" },
    video: {
      baseUrl: "",
      path: "/videos/generations",
      maxDurationSec: 30,
      resultMode: "url",
      maxConcurrent: 2,
    },
    rerank: { baseUrl: "", path: "/rerank" },
    providers: [],
    modelPresets: [],
  },
  database: {
    provider: "sqlite",
    filePath: "data/kgm.sqlite",
    journalMode: "WAL",
  },
  vector: {
    backend: "chroma",
    baseUrl: "http://localhost:8000",
    apiPath: "/api/v1",
    collection: "kgm_memory",
    distance: "cosine",
    timeoutMs: 15000,
  },
  context: {
    artifactDir: "data/artifacts",
    sessionDir: "data/sessions",
    maxToolOutputChars: 2000,
    maxEvidenceChars: 800,
    artifactPreviewChars: 240,
    sessionPreviewChars: 240,
    retrievalCacheTtlMs: 0,
    enableArtifactTool: true,
    enableSessionTool: true,
    enableToolCatalogTool: true,
    toolDescriptorMode: "names",
    includeSkillNames: true,
  },
  adapter: {
    enabled: false,
    baseUrl: "http://localhost:7200",
    secret: "",
    timeoutMs: 3000,
    sendPerformance: false,
    sendContextQuality: false,
    performancePath: "/v1/ingest/kgm/performance",
    contextQualityPath: "/v1/ingest/kgm/context-quality",
  },
  ycb: {
    enabled: false,
    baseUrl: "http://localhost:58692",
    path: "/api/v1/context/for-kgm",
    apiKey: "",
    timeoutMs: 5000,
    failOpen: true,
    requireBuildRef: false,
  },
  routing: {
    version: "route-2026-02-09",
    updatedAt: "2026-02-09T00:00:00Z",
    baseWeights: {
      "openrouter/free": 0.5,
      "moonshotai/kimi-k2.5": 0.5,
    },
    routes: [
      {
        name: "coding_high_accuracy",
        priority: 100,
        match: { purpose: "coding" },
        strategy: {
          type: "weighted",
          weights: { "openrouter/free": 0.2, "moonshotai/kimi-k2.5": 0.8 },
        },
      },
      {
        name: "general_default",
        priority: 10,
        match: { purpose: "general" },
        strategy: { type: "weighted" },
      },
    ],
  },
  autoRouting: {
    enabled: true,
    allowDynamicSelection: true,
    defaultProfile: "quality_first",
    defaultTaskType: "general",
    preferVerifiableTasks: true,
    auditEnabled: true,
    thresholds: {
      maxCandidateCount: 6,
      maxCostPerRequest: 0.15,
      targetLatencyMs: 3500,
      minSampleCount: 3,
    },
    weights: {
      successRate: 0.24,
      quality: 0.2,
      latency: 0.12,
      cost: 0.14,
      trust: 0.18,
      verification: 0.12,
    },
    pricing: {
      default: {
        inputPer1kTokens: 0,
        outputPer1kTokens: 0,
        currency: "USD",
      },
      overrides: {
        "default:openai:gpt-4o-mini": {
          inputPer1kTokens: 0.00015,
          outputPer1kTokens: 0.0006,
          currency: "USD",
        },
        "provider:zhipu:glm-4": {
          inputPer1kTokens: 0.0005,
          outputPer1kTokens: 0.0005,
          currency: "USD",
        },
        // OpenAI 新模型
        "default:openai:gpt-5.4": {
          inputPer1kTokens: 0.005,
          outputPer1kTokens: 0.015,
          currency: "USD",
        },
        "default:openai:gpt-5.5": {
          inputPer1kTokens: 0.01,
          outputPer1kTokens: 0.03,
          currency: "USD",
        },
        "default:openai:gpt-oss": {
          inputPer1kTokens: 0.002,
          outputPer1kTokens: 0.006,
          currency: "USD",
        },
        // Zhipu 新模型
        "default:zhipu:glm-5.0": {
          inputPer1kTokens: 0.0005,
          outputPer1kTokens: 0.0005,
          currency: "USD",
        },
        "default:zhipu:glm-5.1": {
          inputPer1kTokens: 0.001,
          outputPer1kTokens: 0.001,
          currency: "USD",
        },
        // Xiaomi MiMo OpenAPI (https://mimo.mi.com) — V2.5 series
        "default:xiaomi:mimo-v2.5-pro": {
          inputPer1kTokens: 0.000435,
          outputPer1kTokens: 0.00087,
          currency: "USD",
        },
        "default:xiaomi:mimo-v2.5": {
          inputPer1kTokens: 0.00014,
          outputPer1kTokens: 0.00028,
          currency: "USD",
        },
        "default:xiaomi:mimo-v2.5-pro-ultraspeed": {
          inputPer1kTokens: 0.001305,
          outputPer1kTokens: 0.00261,
          currency: "USD",
        },
        "default:xiaomi:mimo-2.5": {
          inputPer1kTokens: 0.0008,
          outputPer1kTokens: 0.0008,
          currency: "USD",
        },
        // Google Gemini 新模型
        "default:gemini:gemini-3.0": {
          inputPer1kTokens: 0.0001,
          outputPer1kTokens: 0.0004,
          currency: "USD",
        },
        "default:gemini:gemini-3.1": {
          inputPer1kTokens: 0.0015,
          outputPer1kTokens: 0.006,
          currency: "USD",
        },
        // Anthropic 新模型
        "default:anthropic:claude-sonnet-4.6": {
          inputPer1kTokens: 0.003,
          outputPer1kTokens: 0.015,
          currency: "USD",
        },
        "default:anthropic:claude-opus-4.7": {
          inputPer1kTokens: 0.015,
          outputPer1kTokens: 0.075,
          currency: "USD",
        },
        // 阿里云百炼新模型
        "default:aliyun:qwen-max": {
          inputPer1kTokens: 0.0005,
          outputPer1kTokens: 0.001,
          currency: "USD",
        },
        "default:aliyun:qwen-plus": {
          inputPer1kTokens: 0.0003,
          outputPer1kTokens: 0.0006,
          currency: "USD",
        },
        // ModelScope 新模型
        "default:modelscope:deepseek-r1": {
          inputPer1kTokens: 0.0002,
          outputPer1kTokens: 0.0008,
          currency: "USD",
        },
        "default:modelscope:llama3-70b": {
          inputPer1kTokens: 0.0004,
          outputPer1kTokens: 0.0008,
          currency: "USD",
        },
        // Moonshot / Kimi 新模型
        "default:moonshot:kimi-2.5": {
          inputPer1kTokens: 0.0005,
          outputPer1kTokens: 0.0005,
          currency: "USD",
        },
        "default:moonshot:kimi-2.6": {
          inputPer1kTokens: 0.001,
          outputPer1kTokens: 0.001,
          currency: "USD",
        },
        // Minimax 新模型
        "default:minimax:minimax-2.5": {
          inputPer1kTokens: 0.0008,
          outputPer1kTokens: 0.0008,
          currency: "USD",
        },
        "default:minimax:minimax-2.7": {
          inputPer1kTokens: 0.0012,
          outputPer1kTokens: 0.0012,
          currency: "USD",
        },
        // DeepSeek 新模型
        "default:deepseek:deepseek-3.2": {
          inputPer1kTokens: 0.00014,
          outputPer1kTokens: 0.00028,
          currency: "USD",
        },
        "default:deepseek:deepseek-v4": {
          inputPer1kTokens: 0.0003,
          outputPer1kTokens: 0.0006,
          currency: "USD",
        },
        // Qwen 新模型
        "default:qwen:qwen-3.5": {
          inputPer1kTokens: 0.0003,
          outputPer1kTokens: 0.0006,
          currency: "USD",
        },
        "default:qwen:qwen-3.6": {
          inputPer1kTokens: 0.0005,
          outputPer1kTokens: 0.001,
          currency: "USD",
        },
        "managed:*": {
          inputPer1kTokens: 0,
          outputPer1kTokens: 0,
          currency: "USD",
        },
      },
    },
    evaluation: {
      enabled: false,
      fallbackToHeuristics: true,
      judge: {
        enabled: true,
        target: {},
        maxTokens: 240,
        temperature: 0,
        timeoutMs: 12000,
      },
      verifier: {
        enabled: true,
        target: {},
        maxTokens: 240,
        temperature: 0,
        timeoutMs: 12000,
      },
    },
    taskRoutes: [
      {
        id: "task-route-code",
        name: "代码任务优先高质量模型",
        enabled: true,
        priority: 100,
        taskType: "code_generation",
        target: {
          provider: "zhipu",
          model: "glm-4",
        },
        note: "可在 Playground 中切换或覆盖。",
      },
      {
        id: "task-route-structured",
        name: "结构化输出优先可验证模型",
        enabled: true,
        priority: 90,
        taskType: "structured_output",
        target: {
          model: "gpt-4o-mini",
        },
      },
    ],
  },
  yueliai: {
    enabled: false,
    host: "https://www.yueli.com",
    apiKey: "",
    upstreamPrefix: "/api",
    timeoutMs: 120_000,
  },
  workers: {
    llamaCpp: {
      enabled: "auto",
      command: "llama-server",
      installHint:
        "Install llama.cpp llama-server; set workers.llamaCpp.command or KGM_LLAMA_SERVER_CMD; KGM_LLAMA_CPP_ENABLED=on|off|auto",
    },
    ds4: {
      enabled: "auto",
      command: "ds4-server",
      installHint:
        "Build antirez/ds4 ds4-server; set workers.ds4.command or KGM_DS4_SERVER_CMD; KGM_DS4_ENABLED=on|off|auto. Kernels stay in ds4 — not KGM native-gpu.",
    },
    tokenspeed: {
      enabled: "off",
      command: "tokenspeed",
      installHint:
        "Optional: TokenSpeed OpenAI-compat worker (like Ollama). Prefer KGM_TOKENSPEED_BASE_URL attach; set KGM_TOKENSPEED_ENABLED=auto|on. Default off — not intent/skills layer.",
      port: 8095,
      enablePrefixCaching: true,
    },
  },
  sandboxAdapters: {
    computer: {},
    browser: {},
    mobile: {},
  },
  playground: {
    skills: [
      {
        id: "skill-weather-demo",
        name: "weather_demo",
        description: "演示技能：串联 get_weather 工具；invoke_skill 的 input 需包含 location",
        steps: [{ id: "w", tool: "get_weather", input: { location: "{{input.location}}" } }],
        systemPromptAddon:
          '当用户问天气时，优先返回 JSON：{"type":"invoke_skill","skill":"weather_demo","input":{"location":"城市名"}}',
      },
    ],
    mcpConnectors: [],
    outputTemplates: [
      {
        id: "tpl-md",
        name: "Markdown 直通",
        kind: "markdown",
        template: "{{content}}",
        slots: ["content"],
      },
      {
        id: "tpl-html-report",
        name: "HTML 报告（插槽）",
        kind: "html",
        template:
          '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>{{title}}</title></head><body><article><h1>{{title}}</h1><div class="kgm-body">{{body}}</div><footer>{{meta}}</footer></article></body></html>',
        slots: ["title", "body", "meta", "content"],
      },
    ],
    activeSkillIds: [],
    activeMcpIds: [],
    activeOutputTemplateId: "tpl-md",
  },
};

export type ConfigStoreOptions = {
  initial?: KgmConfigPatch;
  persistPath?: string;
  loadFromDisk?: boolean;
  autoPersist?: boolean;
};

export class ConfigStore {
  private config: KgmConfig;
  private persistPath?: string;
  private autoPersist: boolean;

  constructor(options?: KgmConfigPatch | ConfigStoreOptions) {
    const resolved = normalizeOptions(options);
    const diskPatch =
      resolved.persistPath && resolved.loadFromDisk
        ? readConfigFile(resolved.persistPath)
        : undefined;
    let config = mergeConfig(defaultConfig, diskPatch ?? {});
    config = mergeConfig(config, resolved.initial ?? {});
    this.config = config;
    this.persistPath = resolved.persistPath;
    this.autoPersist = resolved.autoPersist ?? true;
    if (this.persistPath && resolved.loadFromDisk && !fs.existsSync(this.persistPath)) {
      this.persist();
    }
  }

  get(): KgmConfig {
    return this.config;
  }

  update(next: KgmConfigPatch, options?: { persist?: boolean }): KgmConfig {
    this.config = mergeConfig(this.config, next);
    if (this.persistPath && (options?.persist ?? this.autoPersist)) {
      this.persist();
    }
    return this.config;
  }

  persist(): void {
    if (!this.persistPath) return;
    const dir = path.dirname(this.persistPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.persistPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * 从 `persistPath` 对应文件重新加载配置（与构造时磁盘加载语义一致：defaultConfig + 文件 patch）。
   * 无持久路径或文件不存在时返回 `undefined` 且不修改内存配置。
   */
  reloadFromDisk(): KgmConfig | undefined {
    if (!this.persistPath) {
      return undefined;
    }
    const diskPatch = readConfigFile(this.persistPath);
    if (diskPatch === undefined) {
      return undefined;
    }
    this.config = mergeConfig(defaultConfig, diskPatch);
    return this.config;
  }
}

function mergeConfig(base: KgmConfig, patch: KgmConfigPatch): KgmConfig {
  return {
    embedding: { ...base.embedding, ...(patch.embedding ?? {}) },
    llm: { ...base.llm, ...(patch.llm ?? {}) },
    media: {
      image: { ...base.media.image, ...(patch.media?.image ?? {}) },
      speech: { ...base.media.speech, ...(patch.media?.speech ?? {}) },
      transcription: { ...base.media.transcription, ...(patch.media?.transcription ?? {}) },
      video: { ...base.media.video, ...(patch.media?.video ?? {}) },
      rerank: { ...base.media.rerank, ...(patch.media?.rerank ?? {}) },
      providers: patch.media?.providers ?? base.media.providers ?? [],
      modelPresets: patch.media?.modelPresets ?? base.media.modelPresets ?? [],
    },
    database: { ...base.database, ...(patch.database ?? {}) },
    vector: { ...base.vector, ...(patch.vector ?? {}) },
    context: { ...base.context, ...(patch.context ?? {}) },
    adapter: { ...base.adapter, ...(patch.adapter ?? {}) },
    ycb: { ...base.ycb, ...(patch.ycb ?? {}) },
    routing: { ...base.routing, ...(patch.routing ?? {}) },
    autoRouting: mergeAutoRoutingConfig(base.autoRouting, patch.autoRouting),
    yueliai: mergeYueliAiGatewayConfig(base.yueliai, patch.yueliai),
    workers: mergeWorkersConfig(base.workers, patch.workers),
    sandboxAdapters: mergeSandboxAdaptersConfig(base.sandboxAdapters, patch.sandboxAdapters),
    playground: mergePlaygroundConfig(base.playground, patch.playground),
  };
}

function mergeSandboxAdaptersConfig(
  base: SandboxAdaptersConfig,
  patch?: SandboxAdaptersConfigPatch,
): SandboxAdaptersConfig {
  if (!patch) {
    return base;
  }
  return {
    computer: mergeSandboxKindConfig(base.computer, patch.computer),
    browser: mergeSandboxKindConfig(base.browser, patch.browser),
    mobile: mergeSandboxKindConfig(base.mobile, patch.mobile),
  };
}

function mergeSandboxKindConfig(
  base: SandboxKindAdapterConfig,
  patch?: SandboxKindAdapterConfigPatch | null,
): SandboxKindAdapterConfig {
  if (!patch) {
    return base;
  }
  const next: SandboxKindAdapterConfig = { ...base };
  if (patch.startCommand !== undefined) next.startCommand = patch.startCommand;
  if (patch.stopCommand !== undefined) next.stopCommand = patch.stopCommand;
  if (patch.statusCommand !== undefined) next.statusCommand = patch.statusCommand;
  if (patch.endpoint !== undefined) next.endpoint = patch.endpoint;
  if (patch.hint !== undefined) next.hint = patch.hint;
  if (Object.prototype.hasOwnProperty.call(patch, "useEmbedded")) {
    if (patch.useEmbedded == null) {
      delete next.useEmbedded;
    } else {
      next.useEmbedded = patch.useEmbedded;
    }
  }
  return next;
}

function mergeWorkersConfig(base: WorkersConfig, patch?: WorkersConfigPatch): WorkersConfig {
  if (!patch?.llamaCpp && !patch?.ds4 && !patch?.tokenspeed) {
    return base;
  }
  return {
    llamaCpp: patch?.llamaCpp
      ? {
          ...base.llamaCpp,
          ...patch.llamaCpp,
          enabled: patch.llamaCpp.enabled ?? base.llamaCpp.enabled,
          command: patch.llamaCpp.command?.trim() || base.llamaCpp.command,
          installHint: patch.llamaCpp.installHint ?? base.llamaCpp.installHint,
        }
      : base.llamaCpp,
    ds4: patch?.ds4
      ? {
          ...base.ds4,
          ...patch.ds4,
          enabled: patch.ds4.enabled ?? base.ds4.enabled,
          command: patch.ds4.command?.trim() || base.ds4.command,
          installHint: patch.ds4.installHint ?? base.ds4.installHint,
          chdir: patch.ds4.chdir ?? base.ds4.chdir,
        }
      : base.ds4,
    tokenspeed: patch?.tokenspeed
      ? {
          ...base.tokenspeed,
          ...patch.tokenspeed,
          enabled: patch.tokenspeed.enabled ?? base.tokenspeed.enabled,
          command: patch.tokenspeed.command?.trim() || base.tokenspeed.command,
          installHint: patch.tokenspeed.installHint ?? base.tokenspeed.installHint,
          baseUrl: patch.tokenspeed.baseUrl ?? base.tokenspeed.baseUrl,
          port: patch.tokenspeed.port ?? base.tokenspeed.port,
          attach: patch.tokenspeed.attach ?? base.tokenspeed.attach,
          toolCallParser: patch.tokenspeed.toolCallParser ?? base.tokenspeed.toolCallParser,
          reasoningParser: patch.tokenspeed.reasoningParser ?? base.tokenspeed.reasoningParser,
          enablePrefixCaching: patch.tokenspeed.enablePrefixCaching ?? base.tokenspeed.enablePrefixCaching,
          extraArgs: patch.tokenspeed.extraArgs ?? base.tokenspeed.extraArgs,
        }
      : base.tokenspeed,
  };
}

function mergeYueliAiGatewayConfig(
  base: YueliAiGatewayConfig,
  patch?: YueliAiGatewayConfigPatch,
): YueliAiGatewayConfig {
  if (!patch) {
    return base;
  }
  return {
    ...base,
    ...patch,
    host: patch.host?.trim() || base.host,
    upstreamPrefix: patch.upstreamPrefix !== undefined ? patch.upstreamPrefix : base.upstreamPrefix,
    timeoutMs:
      patch.timeoutMs !== undefined && Number.isFinite(patch.timeoutMs) && patch.timeoutMs > 0
        ? patch.timeoutMs
        : base.timeoutMs,
  };
}

function mergePlaygroundConfig(base: PlaygroundConfig, patch?: PlaygroundConfigPatch): PlaygroundConfig {
  if (!patch) {
    return base;
  }
  return {
    skills: patch.skills ?? base.skills,
    mcpConnectors: patch.mcpConnectors
      ? patch.mcpConnectors.map((connector) => {
          if (!connector.headers) {
            return connector;
          }
          const previous = base.mcpConnectors.find((item) => item.id === connector.id);
          const headers = Object.fromEntries(
            Object.entries(connector.headers)
              .map(([key, value]) => {
                if (value !== REDACTED_CONFIG_SECRET) {
                  return [key, value] as const;
                }
                const restored = previous?.headers?.[key];
                // Never persist the public redaction placeholder as a real secret.
                return restored !== undefined ? ([key, restored] as const) : null;
              })
              .filter((entry): entry is readonly [string, string] => entry !== null),
          );
          return {
            ...connector,
            headers: Object.keys(headers).length > 0 ? headers : undefined,
          };
        })
      : base.mcpConnectors,
    outputTemplates: patch.outputTemplates ?? base.outputTemplates,
    activeSkillIds: patch.activeSkillIds ?? base.activeSkillIds,
    activeMcpIds: patch.activeMcpIds ?? base.activeMcpIds,
    activeOutputTemplateId:
      patch.activeOutputTemplateId !== undefined ? patch.activeOutputTemplateId : base.activeOutputTemplateId,
  };
}

function mergeAutoRoutingConfig(base: AutoRoutingConfig, patch?: AutoRoutingConfigPatch): AutoRoutingConfig {
  if (!patch) {
    return base;
  }
  const pricingOverrides = { ...base.pricing.overrides };
  for (const [key, override] of Object.entries(patch.pricing?.overrides ?? {})) {
    pricingOverrides[key] = {
      ...(pricingOverrides[key] ?? base.pricing.default),
      ...override,
    };
  }
  return {
    ...base,
    ...patch,
    thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
    weights: { ...base.weights, ...(patch.weights ?? {}) },
    pricing: {
      default: { ...base.pricing.default, ...(patch.pricing?.default ?? {}) },
      overrides: pricingOverrides,
    },
    evaluation: mergeAutoRoutingEvaluationConfig(base.evaluation, patch.evaluation),
    taskRoutes: patch.taskRoutes ?? base.taskRoutes,
  };
}

function mergeAutoRoutingEvaluationConfig(
  base: AutoRoutingEvaluationConfig,
  patch?: AutoRoutingEvaluationConfigPatch,
): AutoRoutingEvaluationConfig {
  if (!patch) {
    return base;
  }
  return {
    ...base,
    ...patch,
    judge: mergeAutoRoutingEvaluatorConfig(base.judge, patch.judge),
    verifier: mergeAutoRoutingEvaluatorConfig(base.verifier, patch.verifier),
  };
}

function mergeAutoRoutingEvaluatorConfig(
  base: AutoRoutingEvaluatorConfig,
  patch?: AutoRoutingEvaluatorConfigPatch,
): AutoRoutingEvaluatorConfig {
  if (!patch) {
    return base;
  }
  return {
    ...base,
    ...patch,
    target: {
      ...base.target,
      ...(patch.target ?? {}),
    },
  };
}

function normalizeOptions(options?: KgmConfigPatch | ConfigStoreOptions): ConfigStoreOptions {
  if (!options) {
    return {};
  }
  if (
    "persistPath" in options ||
    "loadFromDisk" in options ||
    "autoPersist" in options ||
    "initial" in options
  ) {
    return options as ConfigStoreOptions;
  }
  return { initial: options as KgmConfigPatch };
}

function readConfigFile(filePath: string): KgmConfigPatch | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return undefined;
  }
  return JSON.parse(raw) as KgmConfigPatch;
}
