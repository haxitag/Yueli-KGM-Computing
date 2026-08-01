import type { NativeGpuDtype } from "./types.js";

export type NativeGpuKernelKind =
  | "rmsnorm"
  | "rope"
  | "attention_prefill"
  | "attention_decode"
  | "mlp"
  | "lm_head";

export type NativeGpuKernelSpec = {
  kind: NativeGpuKernelKind;
  dtype: NativeGpuDtype;
  name: string;
};

/**
 * Phase 6.3/6.4：GPU kernel registry（占位）。
 * - 真实实现中，这里会绑定 CUDA kernel / cuBLASLt / FlashAttention / graph capture 等。
 */
export function buildDefaultGpuKernelRegistry(dtype: NativeGpuDtype): NativeGpuKernelSpec[] {
  return [
    { kind: "rmsnorm", dtype, name: "kgm_gpu_rmsnorm_v0" },
    { kind: "rope", dtype, name: "kgm_gpu_rope_v0" },
    { kind: "attention_prefill", dtype, name: "kgm_gpu_attn_prefill_v0" },
    { kind: "attention_decode", dtype, name: "kgm_gpu_attn_decode_v0" },
    { kind: "mlp", dtype, name: "kgm_gpu_mlp_v0" },
    { kind: "lm_head", dtype, name: "kgm_gpu_lm_head_v0" },
  ];
}

