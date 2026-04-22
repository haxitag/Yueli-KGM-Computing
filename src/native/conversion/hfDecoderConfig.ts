import type { NativeModelConfig } from "../types.js";
import { hfConfigMatchesDecoderLikeFamily } from "./hfDecoderFamilies.js";

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

function readConfigNumber(config: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(config[key]);
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

/** GLM-5 等将 `rope_theta` 放在 `rope_parameters` 内；部分 VL 模型在 `text_config` 内。 */
function readRopeTheta(config: Record<string, unknown>, rope?: Record<string, unknown>): number | undefined {
  const top = readConfigNumber(config, ["rope_theta"]);
  if (typeof top === "number") {
    return top;
  }
  const ropeParams = config.rope_parameters;
  if (ropeParams && typeof ropeParams === "object" && !Array.isArray(ropeParams)) {
    const nested = readNumber((ropeParams as Record<string, unknown>).rope_theta);
    if (typeof nested === "number") {
      return nested;
    }
  }
  const textConfig = config.text_config;
  if (textConfig && typeof textConfig === "object" && !Array.isArray(textConfig)) {
    const fromText = readRopeTheta(textConfig as Record<string, unknown>, rope);
    if (typeof fromText === "number") {
      return fromText;
    }
  }
  return readNumber(rope?.theta);
}

/**
 * Map Hugging Face `config.json` decoder fields 到 {@link NativeModelConfig}。
 * 模型族识别见 {@link hfConfigMatchesDecoderLikeFamily}（Qwen / Minimax / Kimi / GLM / Gemma 等）；
 * 与 `loaders.tryCreateExecutableSafetensorsModel` 维度约束一致。
 */
export function hfDecoderConfigToNativeModelConfig(
  config?: Record<string, unknown>,
  rope?: Record<string, unknown>,
): NativeModelConfig | undefined {
  if (!config) {
    return undefined;
  }
  if (!hfConfigMatchesDecoderLikeFamily(config)) {
    return undefined;
  }

  const hiddenSize = readConfigNumber(config, ["hidden_size"]);
  const intermediateSize = readConfigNumber(config, ["intermediate_size"]);
  const numLayers = readConfigNumber(config, ["num_hidden_layers"]);
  const numHeads = readConfigNumber(config, ["num_attention_heads"]);
  const vocabSize = readConfigNumber(config, ["vocab_size"]);
  const maxPositionEmbeddings = readConfigNumber(config, ["max_position_embeddings"]);
  if (
    typeof hiddenSize !== "number" ||
    typeof intermediateSize !== "number" ||
    typeof numLayers !== "number" ||
    typeof numHeads !== "number" ||
    typeof vocabSize !== "number" ||
    typeof maxPositionEmbeddings !== "number"
  ) {
    return undefined;
  }

  return {
    architecture: "decoder-only",
    vocabSize,
    hiddenSize,
    intermediateSize,
    numLayers,
    numHeads,
    numKvHeads: readConfigNumber(config, ["num_key_value_heads"]),
    maxPositionEmbeddings,
    ropeTheta: readRopeTheta(config, rope),
    ropeDimension: hiddenSize / numHeads,
    normEps: readConfigNumber(config, ["rms_norm_eps", "layer_norm_epsilon"]) ?? 1e-5,
    normKind: "rmsnorm",
    activation: "silu",
    bosTokenId: readConfigNumber(config, ["bos_token_id"]),
    eosTokenId: readConfigNumber(config, ["eos_token_id"]),
    padTokenId: readConfigNumber(config, ["pad_token_id"]),
    chatTemplate: typeof config.chat_template === "string" ? config.chat_template : undefined,
  };
}
