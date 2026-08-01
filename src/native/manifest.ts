import fs from "node:fs";
import path from "node:path";

import type {
  CanonicalModelSpec,
  NativeBackendKind,
  NativeModelArtifactFile,
  NativeModelArtifactFileKind,
  NativeModelManifest,
  NativeModelMetadata,
  NativeRuntimeFormat,
} from "./types.js";

export type NativeModelSidecars = {
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  tokenizerConfig?: Record<string, unknown>;
  generationConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
  chatTemplate?: string;
  files: NativeModelArtifactFile[];
};

export function readModelSidecars(modelDir: string): NativeModelSidecars {
  const candidates: Array<{
    filename: string;
    kind: NativeModelArtifactFileKind;
    format: string;
  }> = [
    { filename: "config.json", kind: "config", format: "json" },
    { filename: "tokenizer.json", kind: "tokenizer", format: "json" },
    { filename: "tokenizer_config.json", kind: "tokenizer_config", format: "json" },
    { filename: "generation_config.json", kind: "generation_config", format: "json" },
    { filename: "special_tokens_map.json", kind: "special_tokens", format: "json" },
  ];

  const files: NativeModelArtifactFile[] = [];
  const sidecars: Record<string, Record<string, unknown> | undefined> = {};

  for (const candidate of candidates) {
    const filePath = path.join(modelDir, candidate.filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const stat = fs.statSync(filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    files.push({
      kind: candidate.kind,
      path: filePath,
      format: candidate.format,
      sizeBytes: stat.size,
      required: candidate.kind === "config" || candidate.kind === "tokenizer",
    });
    sidecars[candidate.kind] = parsed;
  }

  const tokenizerConfig = sidecars.tokenizer_config;
  const config = sidecars.config;
  const chatTemplate = typeof tokenizerConfig?.chat_template === "string"
    ? tokenizerConfig.chat_template
    : typeof config?.chat_template === "string"
      ? config.chat_template
      : undefined;

  return {
    config: sidecars.config,
    tokenizer: sidecars.tokenizer,
    tokenizerConfig: sidecars.tokenizer_config,
    generationConfig: sidecars.generation_config,
    specialTokensMap: sidecars.special_tokens,
    chatTemplate,
    files,
  };
}

export function createNativeModelManifest(params: {
  format: NativeRuntimeFormat;
  path: string;
  executable: boolean;
  metadata: NativeModelMetadata;
  files?: NativeModelArtifactFile[];
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  rope?: Record<string, unknown>;
  chatTemplate?: string;
  tensors?: Array<{ name: string; shape?: number[]; dtype?: string }>;
}): NativeModelManifest {
  const resolvedPath = path.resolve(params.path);
  const modelDir = fs.statSync(resolvedPath).isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const files = dedupeFiles(params.files ?? []);
  const jang = params.metadata.jang;
  return {
    format: params.format,
    path: resolvedPath,
    modelDir,
    executable: params.executable,
    backendHints: inferBackendHints(params.format, params.executable, jang),
    files,
    metadata: params.metadata,
    canonical: buildCanonicalModelSpec({
      format: params.format,
      config: params.config,
      tokenizer: params.tokenizer,
      rope: params.rope,
      chatTemplate: params.chatTemplate,
      tensors: params.tensors,
      quantizationHint: jang?.profile ? `jang:${jang.profile}` : undefined,
    }),
  };
}

function inferBackendHints(
  format: NativeRuntimeFormat,
  executable: boolean,
  jang?: NativeModelMetadata["jang"],
): NativeBackendKind[] {
  if (jang) {
    // JANG weights target MLX on Apple Silicon; native-core may later load MLX-shimmed checkpoints.
    return ["native-core"];
  }
  if (executable && format === "kgm-json") {
    return ["reference", "native-core"];
  }
  if (format === "unknown") {
    return ["native-core"];
  }
  return ["native-core"];
}

function buildCanonicalModelSpec(params: {
  format: NativeRuntimeFormat;
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  rope?: Record<string, unknown>;
  chatTemplate?: string;
  tensors?: Array<{ name: string; shape?: number[]; dtype?: string }>;
  quantizationHint?: string;
}): CanonicalModelSpec | undefined {
  const config = params.config ?? {};
  const architecture = normalizeArchitecture(config.architecture ?? config.architectures ?? config.model_type);
  const family = inferFamily(config);
  const dtype = inferDtype(params.tensors);
  const quantization = params.quantizationHint ?? inferQuantization(params.tensors, params.format);
  const tokenizerKind = inferTokenizerKind(params.tokenizer);
  const tensorCount = params.tensors?.length;

  if (
    architecture === "unknown" &&
    family === "unknown" &&
    !params.chatTemplate &&
    !dtype &&
    typeof tensorCount === "undefined"
  ) {
    return undefined;
  }

  return {
    architecture,
    family,
    sourceFormat: params.format,
    contextLength: readNumber(config.max_position_embeddings ?? config.contextLength ?? config.context_length),
    hiddenSize: readNumber(config.hidden_size ?? config.hiddenSize ?? config.embeddingLength),
    intermediateSize: readNumber(config.intermediate_size ?? config.intermediateSize),
    numLayers: readNumber(config.num_hidden_layers ?? config.numLayers ?? config.blockCount),
    numHeads: readNumber(config.num_attention_heads ?? config.numHeads),
    numKvHeads: readNumber(config.num_key_value_heads ?? config.numKvHeads),
    vocabSize: readNumber(config.vocab_size ?? config.vocabSize),
    ropeTheta: readNumber(params.rope?.theta ?? config.rope_theta ?? config.ropeTheta),
    ropeScaling: params.rope?.scaling ?? config.rope_scaling,
    dtype,
    quantization,
    tokenizerKind,
    chatTemplate: params.chatTemplate,
    tensorCount,
  };
}

function normalizeArchitecture(value: unknown): CanonicalModelSpec["architecture"] {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower.includes("decoder")) {
      return "decoder-only";
    }
    if (lower.includes("encoder")) {
      return "encoder-decoder";
    }
    if (
      lower.includes("causallm") ||
      lower.includes("forcausallm") ||
      lower.includes("lmheadmodel") ||
      lower.includes("llama") ||
      lower.includes("mistral") ||
      lower.includes("qwen")
    ) {
      return "decoder-only";
    }
  }
  if (Array.isArray(value)) {
    return normalizeArchitecture(value[0]);
  }
  return "unknown";
}

function inferFamily(config: Record<string, unknown>): CanonicalModelSpec["family"] {
  const modelType = `${config.model_type ?? config.architecture ?? config.architectures ?? ""}`.toLowerCase();
  if (modelType.includes("llama")) {
    return "llama";
  }
  if (modelType.includes("mistral")) {
    return "mistral";
  }
  if (modelType.includes("qwen")) {
    return "qwen2";
  }
  if (modelType.includes("decoder")) {
    return "generic-decoder";
  }
  return "unknown";
}

function inferTokenizerKind(tokenizer?: Record<string, unknown>): string | undefined {
  if (!tokenizer) {
    return undefined;
  }
  const model = tokenizer.model;
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && "type" in model && typeof model.type === "string") {
    if (model.type === "BPE") {
      return "hf-bpe";
    }
    if (model.type === "Unigram") {
      return "hf-unigram";
    }
    return model.type;
  }
  const tokenizerClass = tokenizer.tokenizer_class;
  if (typeof tokenizerClass === "string") {
    return tokenizerClass;
  }
  return undefined;
}

function inferDtype(tensors?: Array<{ dtype?: string }>): string | undefined {
  if (!tensors || tensors.length === 0) {
    return undefined;
  }
  const firstKnown = tensors.find((tensor) => typeof tensor.dtype === "string")?.dtype;
  return firstKnown ? String(firstKnown) : undefined;
}

function inferQuantization(
  tensors: Array<{ dtype?: string }> | undefined,
  format: NativeRuntimeFormat,
): string | undefined {
  if (!tensors || tensors.length === 0) {
    return format === "gguf" ? "gguf-quantized-or-mixed" : undefined;
  }
  const dtypes = new Set(tensors.map((tensor) => tensor.dtype).filter((dtype): dtype is string => typeof dtype === "string"));
  const quantized = Array.from(dtypes).find((dtype) => /^q/i.test(dtype));
  if (quantized) {
    return quantized;
  }
  if (format === "gguf") {
    return "gguf-mixed";
  }
  return undefined;
}

function dedupeFiles(files: NativeModelArtifactFile[]): NativeModelArtifactFile[] {
  const byPath = new Map<string, NativeModelArtifactFile>();
  for (const file of files) {
    byPath.set(path.resolve(file.path), {
      ...file,
      path: path.resolve(file.path),
    });
  }
  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
