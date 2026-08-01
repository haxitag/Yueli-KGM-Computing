/**
 * TypeScript SDK 类型定义
 * 遵循KGM Computing SDK规范v1.0.0
 */

export interface ClientConfig {
  /** API基础URL */
  base_url?: string;
  /** API密钥 */
  api_key?: string;
  /** 请求超时时间（毫秒） */
  timeout?: number;
  /** 最大重试次数 */
  max_retries?: number;
  /** 重试延迟（毫秒） */
  retry_delay?: number;
  /** 是否启用指标收集 */
  enable_metrics?: boolean;
  /** 是否启用追踪 */
  enable_tracing?: boolean;
  /** 是否启用缓存 */
  cache_enabled?: boolean;
  /** 缓存大小 */
  cache_size?: number;
  /** 缓存TTL（毫秒） */
  cache_ttl?: number;
  /** 是否启用批处理 */
  batch_enabled?: boolean;
  /** 批处理大小 */
  batch_size?: number;
  /** 批处理超时（毫秒） */
  batch_timeout?: number;
  /** 自定义HTTP客户端 */
  http_client?: any;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 日志级别 */
  log_level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export interface InferenceRequest {
  /** 模型名称 */
  model: string;
  /** 输入提示 */
  prompt: string;
  /** 推理参数 */
  parameters?: InferenceParameters;
  /** 是否启用流式响应 */
  stream?: boolean;
  /** 上下文信息 */
  context?: InferenceContext;
  /** 元数据 */
  metadata?: Record<string, any>;
}

export interface InferenceParameters {
  /** 最大生成token数 */
  max_tokens?: number;
  /** 温度参数（0-2） */
  temperature?: number;
  /** 核采样参数（0-1） */
  top_p?: number;
  /** 频率惩罚（-2到2） */
  frequency_penalty?: number;
  /** 存在惩罚（-2到2） */
  presence_penalty?: number;
  /** 停止词列表 */
  stop?: string[];
  /** 停止序列 */
  stop_sequences?: string[];
  /** 随机种子 */
  seed?: number;
  /** 是否启用logprobs */
  logprobs?: boolean;
  /** logprobs返回数量 */
  top_logprobs?: number;
}

export interface InferenceContext {
  /** 对话历史 */
  history?: string[];
  /** 系统提示 */
  system_prompt?: string;
  /** 上下文token数 */
  context_length?: number;
  /** 是否启用记忆 */
  enable_memory?: boolean;
}

export interface InferenceResponse {
  /** 生成结果 */
  choices: InferenceChoice[];
  /** 使用统计 */
  usage: TokenUsage;
  /** 模型名称 */
  model: string;
  /** 请求ID */
  request_id: string;
  /** 创建时间 */
  created: number;
  /** 元数据 */
  metadata?: Record<string, any>;
}

export interface InferenceChoice {
  /** 生成的文本 */
  text: string;
  /** 结果索引 */
  index: number;
  /** 结束原因 */
  finish_reason: string;
  /** 对数概率 */
  logprobs?: any;
}

export interface TokenUsage {
  /** 提示token数 */
  prompt_tokens: number;
  /** 生成token数 */
  completion_tokens: number;
  /** 总token数 */
  total_tokens: number;
}

export interface ChatMessage {
  /** 消息角色 */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 消息内容 */
  content: string;
  /** 消息名称 */
  name?: string;
  /** 工具调用 */
  tool_calls?: ToolCall[];
  /** 工具调用ID */
  tool_call_id?: string;
}

export interface ChatRequest {
  /** 模型名称 */
  model: string;
  /** 消息列表 */
  messages: ChatMessage[];
  /** 工具定义 */
  tools?: ToolDefinition[];
  /** 工具选择策略 */
  tool_choice?: ToolChoice;
  /** 聊天参数 */
  parameters?: ChatParameters;
  /** 是否启用流式响应 */
  stream?: boolean;
  /** 聊天上下文 */
  context?: ChatContext;
}

export interface ToolDefinition {
  /** 工具类型 */
  type: 'function';
  /** 函数定义 */
  function: FunctionDefinition;
}

export interface FunctionDefinition {
  /** 函数名称 */
  name: string;
  /** 函数描述 */
  description?: string;
  /** 参数schema */
  parameters?: Record<string, any>;
}

export interface ToolCall {
  /** 工具调用ID */
  id: string;
  /** 工具类型 */
  type: 'function';
  /** 函数调用 */
  function: {
    /** 函数名称 */
    name: string;
    /** 函数参数 */
    arguments: string;
  };
}

export type ToolChoice = 
  | 'auto'
  | 'none'
  | { type: 'function'; function: { name: string } };

export interface ChatParameters {
  /** 最大生成token数 */
  max_tokens?: number;
  /** 温度参数 */
  temperature?: number;
  /** 核采样参数 */
  top_p?: number;
  /** 频率惩罚 */
  frequency_penalty?: number;
  /** 存在惩罚 */
  presence_penalty?: number;
  /** 停止词 */
  stop?: string[];
  /** 工具调用参数 */
  tool_parameters?: Record<string, any>;
}

export interface ChatContext {
  /** 对话历史 */
  history?: ChatMessage[];
  /** 系统提示 */
  system_prompt?: string;
  /** 记忆配置 */
  memory?: MemoryConfig;
}

export interface MemoryConfig {
  /** 记忆类型 */
  type: 'episodic' | 'semantic' | 'hybrid';
  /** 记忆容量 */
  capacity?: number;
  /** 衰减因子 */
  decay_factor?: number;
}

export interface ChatResponse {
  /** 消息列表 */
  messages: ChatMessage[];
  /** 使用统计 */
  usage: TokenUsage;
  /** 模型名称 */
  model: string;
  /** 请求ID */
  request_id: string;
  /** 创建时间 */
  created: number;
  /** 结束原因 */
  finish_reason?: string;
  /** 工具调用 */
  tool_calls?: ToolCall[];
}

export interface EmbedRequest {
  /** 模型名称 */
  model: string;
  /** 输入文本 */
  input: string | string[];
  /** 编码格式 */
  encoding_format?: 'float' | 'base64';
  /** 嵌入维度 */
  dimensions?: number;
  /** 批处理配置 */
  batch_config?: BatchConfig;
}

export interface BatchConfig {
  /** 批处理大小 */
  size?: number;
  /** 批处理超时（毫秒） */
  timeout?: number;
  /** 是否启用压缩 */
  compression?: boolean;
}

export interface EmbedResponse {
  /** 模型名称 */
  model: string;
  /** 嵌入数据 */
  data: EmbeddingData[];
  /** 使用统计 */
  usage: TokenUsage;
  /** 批处理信息 */
  batch_info?: BatchInfo;
}

export interface EmbeddingData {
  /** 嵌入向量（float数组或base64字符串） */
  embedding: number[] | string;
  /** 数据索引 */
  index: number;
  /** 原始文本 */
  text?: string;
}

export interface BatchInfo {
  /** 批处理ID */
  batch_id: string;
  /** 批处理大小 */
  batch_size: number;
  /** 处理时间（毫秒） */
  processing_time: number;
  /** 压缩率 */
  compression_ratio?: number;
}

export interface ModelInfo {
  /** 模型ID */
  id: string;
  /** 模型名称 */
  name: string;
  /** 模型类型 */
  type: 'llm' | 'embedding' | 'multimodal';
  /** 支持的上下文长度 */
  context_length: number;
  /** 最大输出长度 */
  max_output_length: number;
  /** 支持的参数 */
  supported_parameters: string[];
  /** 支持的特性 */
  capabilities: string[];
  /** 提供商信息 */
  provider: ModelProvider;
  /** 版本信息 */
  version: string;
}

export interface ModelProvider {
  /** 提供商名称 */
  name: string;
  /** 提供商类型 */
  type: 'openai' | 'anthropic' | 'google' | 'azure' | 'custom';
  /** API端点 */
  endpoints: string[];
}

export interface HealthStatus {
  /** 服务状态 */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** 健康评分（0-100） */
  score: number;
  /** 检查时间 */
  timestamp: string;
  /** 组件状态 */
  components: HealthComponent[];
  /** 问题描述 */
  issues?: string[];
}

export interface HealthComponent {
  /** 组件名称 */
  name: string;
  /** 组件状态 */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** 响应时间（毫秒） */
  response_time?: number;
  /** 错误信息 */
  error?: string;
}

export interface Metrics {
  /** 计数器 */
  counters: Record<string, number>;
  /** 直方图 */
  histograms: Record<string, Histogram>;
  /** 仪表 */
  gauges: Record<string, number>;
  /** 汇总信息 */
  summary: MetricsSummary;
}

export interface Histogram {
  /** 样本数 */
  count: number;
  /** 总和 */
  sum: number;
  /** 桶数据 */
  buckets: Record<number, number>;
  /** 分位数 */
  quantiles: Record<number, number>;
}

export interface MetricsSummary {
  /** 总请求数 */
  total_requests: number;
  /** 成功请求数 */
  successful_requests: number;
  /** 失败请求数 */
  failed_requests: number;
  /** 平均延迟（毫秒） */
  average_latency: number;
  /** P95延迟（毫秒） */
  p95_latency: number;
  /** P99延迟（毫秒） */
  p99_latency: number;
  /** 吞吐量（请求/秒） */
  throughput: number;
  /** 错误率 */
  error_rate: number;
  /** 缓存命中率 */
  cache_hit_rate: number;
}

export interface StreamingConfig {
  /** 流式读取器 */
  reader?: any;
  /** 流式写入器 */
  writer?: any;
  /** 块大小 */
  chunk_size?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否启用压缩 */
  compression?: boolean;
}

export interface InferenceChunk {
  /** 块ID */
  id: string;
  /** 块索引 */
  index: number;
  /** 块内容 */
  content: string;
  /** 是否结束 */
  done: boolean;
  /** 使用统计 */
  usage?: TokenUsage;
  /** 结束原因 */
  finish_reason?: string;
}

export interface ChatChunk {
  /** 消息角色 */
  role: 'assistant' | 'tool';
  /** 块内容 */
  content?: string;
  /** 块ID */
  id: string;
  /** 是否结束 */
  done: boolean;
  /** 工具调用 */
  tool_calls?: ToolCall[];
  /** 使用统计 */
  usage?: TokenUsage;
}

export interface CacheStats {
  /** 缓存命中数 */
  hits: number;
  /** 缓存未命中数 */
  misses: number;
  /** 缓存大小 */
  size: number;
  /** 缓存内存使用（字节） */
  memory: number;
  /** 按类型统计 */
  by_type: Record<string, CacheTypeStats>;
}

export interface CacheTypeStats {
  /** 命中数 */
  hits: number;
  /** 未命中数 */
  misses: number;
  /** 命中率 */
  hit_rate: number;
}

export interface BatchStats {
  /** 总批次数 */
  total_batches: number;
  /** 总批处理请求数 */
  total_requests: number;
  /** 平均批处理大小 */
  avg_batch_size: number;
  /** 批处理节省时间（毫秒） */
  time_saved: number;
  /** 最大批处理并发数 */
  max_concurrency: number;
}

// 事件类型定义
export type KGMClientEvent = 
  | 'request.start'
  | 'request.success'
  | 'request.error'
  | 'request.retry'
  | 'cache.hit'
  | 'cache.miss'
  | 'batch.start'
  | 'batch.complete'
  | 'stream.start'
  | 'stream.chunk'
  | 'stream.end';

// 事件处理器类型
export type EventHandler<T = any> = (data: T) => void;

// 事件名称到事件数据的映射
export interface EventDataMap {
  'request.start': { request_id: string; type: string; model: string };
  'request.success': { request_id: string; type: string; model: string; duration: number };
  'request.error': { request_id: string; type: string; model: string; error: any };
  'request.retry': { request_id: string; type: string; model: string; attempt: number };
  'cache.hit': { key: string; type: string };
  'cache.miss': { key: string; type: string };
  'batch.start': { batch_id: string; size: number; type: string };
  'batch.complete': { batch_id: string; size: number; type: string; duration: number };
  'stream.start': { stream_id: string; type: string; model: string };
  'stream.chunk': { stream_id: string; type: string; chunk: any };
  'stream.end': { stream_id: string; type: string; duration: number };
}

// 请求选项
export interface RequestOptions {
  /** 请求ID */
  request_id?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否重试 */
  retry?: boolean;
  /** 重试次数 */
  retry_count?: number;
  /** 是否记录日志 */
  log?: boolean;
  /** 自定义请求头 */
  headers?: Record<string, string>;
}
