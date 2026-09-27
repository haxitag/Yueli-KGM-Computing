/**
 * Hugging Face `config.json` 中与 **decoder-only、类 Llama 张量命名** 可对齐的模型族识别。
 * 用于 canonical 维度映射（`hfDecoderConfigToNativeModelConfig`）；**CPU reference 可执行**
 * 仍取决于权重是否与 `buildSafetensorsTensorAliases`（Qwen2/Llama 风格 HF 名）一致。
 *
 * 优先级对齐产品路线：**Qwen3.x / Qwen2.5**、**Minimax 2.5–2.7**、**Kimi 2.5**、**GLM-4/5** 等
 * 开源/魔改权重；**不**以单独「Llama 适配」作为验收主线（Llama 仅作通用参考布局）。
 */
export const HF_DECODER_LIKE_MODEL_TYPE_PATTERNS: readonly string[] = [
  "llama",
  "mistral",
  "mixtral",
  "qwen",
  "gemma",
  "glm",
  "minimax",
  "kimi",
  "phi",
  "deepseek",
];

/**
 * 从 `model_type`、`architecture`（单数）、`architectures`（HF 数组）拼出小写检索串。
 */
export function hfConfigDecoderLikeHaystack(config: Record<string, unknown>): string {
  const modelType = `${config.model_type ?? config.architecture ?? ""}`.toLowerCase();
  const archList = Array.isArray(config.architectures)
    ? config.architectures.map((entry) => String(entry)).join(" ").toLowerCase()
    : "";
  return `${modelType} ${archList}`.trim();
}

export function hfConfigMatchesDecoderLikeFamily(config: Record<string, unknown>): boolean {
  const haystack = hfConfigDecoderLikeHaystack(config);
  if (!haystack) {
    return false;
  }
  return HF_DECODER_LIKE_MODEL_TYPE_PATTERNS.some((pattern) => haystack.includes(pattern));
}
