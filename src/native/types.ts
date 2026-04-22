import type { JangMetadata } from "./jang.js";

export type NativeRuntimeFormat =
  | "kgm-json"
  | "gguf"
  | "safetensors"
  | "onnx"
  | "transformers"
  | "pytorch"
  | "tensorflow"
  | "unknown";

export type NativeBackendKind = "reference" | "native-core";

export type NativeTokenizerKind = "byte" | "character" | "hf-bpe" | "hf-unigram";

export type NativeTokenizerAddedToken = {
  id: number;
  content: string;
  special?: boolean;
};

export type NativeTokenizerSpec = {
  kind: NativeTokenizerKind;
  vocab?: string[];
  scores?: number[];
  tokenToId?: Record<string, number>;
  merges?: string[];
  bosTokenId?: number;
  eosTokenId?: number;
  unkTokenId?: number;
  padTokenId?: number;
  specialTokens?: Record<string, number>;
  addedTokens?: NativeTokenizerAddedToken[];
  addPrefixSpace?: boolean;
  continuingSubwordPrefix?: string;
  endOfWordSuffix?: string;
  byteFallback?: boolean;
  unkToken?: string;
  decoderCleanup?: boolean;
  metaspaceReplacement?: string;
  metaspacePrependScheme?: "always" | "first" | "never";
  chatTemplate?: string;
};

export type NativeTensorEncoding = "f32" | "q8_0";

export type NativeTensorSource = {
  shape: number[];
  dtype?: NativeTensorEncoding;
  data: number[];
  scales?: number[];
  blockSize?: number;
};

export type NativeModelConfig = {
  architecture: "decoder-only";
  vocabSize: number;
  hiddenSize: number;
  intermediateSize: number;
  numLayers: number;
  numHeads: number;
  numKvHeads?: number;
  maxPositionEmbeddings: number;
  ropeTheta?: number;
  ropeDimension?: number;
  normEps?: number;
  normKind?: "rmsnorm";
  activation?: "silu";
  bosTokenId?: number;
  eosTokenId?: number;
  padTokenId?: number;
  chatTemplate?: string;
};

export type NativeCheckpoint = {
  format: "kgm-transformer-checkpoint";
  version?: number;
  config: NativeModelConfig;
  tokenizer: NativeTokenizerSpec;
  tensors: Record<string, NativeTensorSource>;
  metadata?: Record<string, unknown>;
};

export type NativeModelMetadata = {
  format: NativeRuntimeFormat;
  path: string;
  executable: boolean;
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  rope?: Record<string, unknown>;
  chatTemplate?: string;
  notes: string[];
  tensors?: Array<{ name: string; shape?: number[]; dtype?: string }>;
  /** MLX-native JANG (Jang Adaptive N-bit Grading) when present */
  jang?: JangMetadata;
};

export type NativeModelArtifactFileKind =
  | "checkpoint"
  | "weights"
  | "config"
  | "tokenizer"
  | "tokenizer_config"
  | "generation_config"
  | "special_tokens"
  | "onnx_graph"
  | "unknown";

export type NativeModelArtifactFile = {
  kind: NativeModelArtifactFileKind;
  path: string;
  format?: string;
  sizeBytes?: number;
  required?: boolean;
  metadata?: Record<string, unknown>;
};

export type CanonicalModelSpec = {
  architecture: "decoder-only" | "encoder-decoder" | "unknown";
  family: "llama" | "mistral" | "qwen2" | "generic-decoder" | "unknown";
  sourceFormat: NativeRuntimeFormat;
  contextLength?: number;
  hiddenSize?: number;
  intermediateSize?: number;
  numLayers?: number;
  numHeads?: number;
  numKvHeads?: number;
  vocabSize?: number;
  ropeTheta?: number;
  ropeScaling?: unknown;
  dtype?: string;
  quantization?: string;
  tokenizerKind?: string;
  chatTemplate?: string;
  tensorCount?: number;
};

export type NativeModelManifest = {
  format: NativeRuntimeFormat;
  path: string;
  modelDir: string;
  executable: boolean;
  backendHints: NativeBackendKind[];
  files: NativeModelArtifactFile[];
  metadata: NativeModelMetadata;
  canonical?: CanonicalModelSpec;
};

export type NativeGenerationOptions = {
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  stop?: string[];
  seed?: number;
};

export type NativeGenerationResult = {
  text: string;
  promptTokens: number;
  prefillTokens?: number;
  generatedTokens: number;
  finishReason: "stop" | "length" | "eos";
  ttftMs: number;
  tpotMs: number;
  tokensPerSecond: number;
  device: "cpu";
  format: NativeRuntimeFormat;
  requestId?: string;
  sessionId?: string;
  cacheSource?: "cold" | "prompt-cache" | "session-prefix";
  queueWaitMs?: number;
  scheduler?: {
    continuousBatching: boolean;
    servingBackend?: "js-reference" | "native-core";
    maxBatchSize: number;
    maxPrefillsPerTick: number;
    kvCacheKind: "dense" | "paged";
    kvPageSize?: number;
    activeRequestsAtAdmission: number;
    queuedRequestsAtAdmission: number;
    requestSchedulerCycles: number;
    engineSchedulerCycles: number;
    peakActiveRequests: number;
    peakQueuedRequests: number;
  };
  memory?: {
    kvResidentBytes: number;
    kvAllocatedPages: number;
    cachedKvResidentPages?: number;
    cachedKvPageBudget?: number;
  };
  metadata: NativeModelMetadata;
};
