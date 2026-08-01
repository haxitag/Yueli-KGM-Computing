/**
 * GGUF 布局规则：与 CPU reference 可执行范围一致，供 loader 与矩阵单测共用。
 */

export type GgufLayoutAnalysisInput = {
  tensorNames: string[];
  /** 如 `config.architecture` 或 `general.architecture` */
  architecture?: string;
  tensorDtypeCodes: number[];
};

export type GgufDescriptorLayoutLike = {
  tensorEntries: Record<string, { dtypeCode: number }>;
  config?: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export function mapGgufDtypeLabel(dtypeCode: number): string {
  switch (dtypeCode) {
    case 0:
      return "F32";
    case 1:
      return "F16";
    case 8:
      return "Q8_0";
    case 12:
      return "Q4_K";
    case 13:
      return "Q5_K";
    case 14:
      return "Q6_K";
    default:
      return `GGML_TYPE_${dtypeCode}`;
  }
}

export function analyzeGgufLayoutIssues(input: GgufLayoutAnalysisInput): string[] {
  const issues = new Set<string>();
  const architecture = `${input.architecture ?? ""}`.toLowerCase();
  const tensorNames = input.tensorNames;
  const unsupportedDtypes = new Set<number>();
  for (const code of input.tensorDtypeCodes) {
    if (![0, 1, 8, 12, 13, 14].includes(code)) {
      unsupportedDtypes.add(code);
    }
  }
  if (architecture && !["llama", "mistral", "qwen2"].includes(architecture)) {
    issues.add(`architecture '${architecture}' is outside the current decoder-only executor scope`);
  }
  if (tensorNames.some((name) => name.includes(".ssm_"))) {
    issues.add("contains SSM/state-space tensors (`*.ssm_*`)");
  }
  if (tensorNames.some((name) => name.endsWith(".attn_qkv.weight"))) {
    issues.add("contains fused QKV attention weights (`*.attn_qkv.weight`)");
  }
  if (tensorNames.some((name) => name.endsWith(".attn_gate.weight"))) {
    issues.add("contains attention gating tensors (`*.attn_gate.weight`)");
  }
  if (tensorNames.some((name) => name.endsWith(".attn_q_norm.weight") || name.endsWith(".attn_k_norm.weight"))) {
    issues.add("contains q/k norm tensors (`*.attn_q_norm.weight`, `*.attn_k_norm.weight`)");
  }
  if (unsupportedDtypes.size > 0) {
    issues.add(
      `contains unsupported GGUF tensor dtypes (${[...unsupportedDtypes].map((code) => mapGgufDtypeLabel(code)).join(", ")})`,
    );
  }
  return [...issues];
}

/** 与 `loaders` 内 GGUF 描述结构对齐的便捷入口 */
export function analyzeGgufDescriptorLayoutIssues(descriptor: GgufDescriptorLayoutLike): string[] {
  const architecture = `${descriptor.config?.architecture ?? descriptor.metadata["general.architecture"] ?? ""}`;
  return analyzeGgufLayoutIssues({
    tensorNames: Object.keys(descriptor.tensorEntries),
    architecture,
    tensorDtypeCodes: Object.values(descriptor.tensorEntries).map((e) => e.dtypeCode),
  });
}
