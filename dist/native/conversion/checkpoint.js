import { hfDecoderConfigToNativeModelConfig } from "./hfDecoderConfig.js";
/**
 * 从 HF decoder `config.json`（及可选 `rope`）构建 **张量为空** 的 canonical `NativeCheckpoint`，
 * 供 raw 权重管线与 CPU reference 加载共用同一 IR。
 */
export function buildCanonicalCheckpointFromHfDecoder(input) {
    const nativeConfig = hfDecoderConfigToNativeModelConfig(input.decoderConfig, input.rope);
    if (!nativeConfig) {
        return undefined;
    }
    const metadata = {
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
