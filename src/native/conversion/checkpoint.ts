import type { NativeCheckpoint, NativeTokenizerSpec } from "../types.js";
import { hfDecoderConfigToNativeModelConfig } from "./hfDecoderConfig.js";

export type HfCanonicalConversionInput = {
  decoderConfig: Record<string, unknown>;
  rope?: Record<string, unknown>;
  tokenizer?: NativeTokenizerSpec;
  /** 来自 safetensors 索引或目录扫描，便于审计与后续张量映射 */
  tensorNames?: string[];
  /** 写入 `metadata.source` */
  source?: string;
};

/**
 * 从 HF decoder `config.json`（及可选 `rope`）构建 **张量为空** 的 canonical `NativeCheckpoint`，
 * 供 raw 权重管线与 CPU reference 加载共用同一 IR。
 */
export function buildCanonicalCheckpointFromHfDecoder(
  input: HfCanonicalConversionInput,
): NativeCheckpoint | undefined {
  const nativeConfig = hfDecoderConfigToNativeModelConfig(input.decoderConfig, input.rope);
  if (!nativeConfig) {
    return undefined;
  }
  const metadata: Record<string, unknown> = {
    source: input.source ?? "hf-safetensors-canonical",
  };
  if (input.tensorNames && input.tensorNames.length > 0) {
    metadata.tensorNames = input.tensorNames;
  }
  return {
    format: "kgm-transformer-checkpoint",
    version: 1,
    config: nativeConfig,
    tokenizer: input.tokenizer ?? { kind: "byte" },
    tensors: {},
    metadata,
  };
}
