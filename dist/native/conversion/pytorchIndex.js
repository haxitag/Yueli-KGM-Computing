import { buildCanonicalCheckpointFromHfDecoder } from "./checkpoint.js";
/**
 * 从 Transformers `pytorch_model.bin` 分片索引 `weight_map` 提取张量名（排序后用于 canonical 元数据）。
 */
export function extractTensorNamesFromPytorchWeightMap(weightMap) {
    if (!weightMap || typeof weightMap !== "object") {
        return [];
    }
    return Object.keys(weightMap).sort();
}
/**
 * `model.safetensors.index.json` 风格 JSON（仅使用 `weight_map`）→ 张量为空的 canonical checkpoint。
 */
export function buildCanonicalCheckpointFromPytorchIndexJson(input) {
    const tensorNames = extractTensorNamesFromPytorchWeightMap(input.index.weight_map);
    return buildCanonicalCheckpointFromHfDecoder({
        decoderConfig: input.decoderConfig,
        rope: input.rope,
        tokenizer: input.tokenizer,
        tensorNames,
        source: "hf-pytorch-index-canonical",
    });
}
