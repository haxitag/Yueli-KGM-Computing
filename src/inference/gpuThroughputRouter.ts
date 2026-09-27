/**
 * GPU throughput control plane: prefer real high-throughput workers (vLLM / SGLang).
 * Does not fabricate CUDA kernels; routes to ManagedModel runtimes.
 */

import type { ManagedModelManager, ManagedModelRuntimeKind } from "../models/modelManager.js";

export type GpuThroughputPreference = "vllm" | "sglang" | "auto";

export type GpuThroughputPlan = {
  preference: GpuThroughputPreference;
  selected?: {
    runtimeId: string;
    modelName: string;
    runtime: ManagedModelRuntimeKind;
    baseUrl: string;
  };
  candidates: Array<{
    runtimeId: string;
    runtime: ManagedModelRuntimeKind;
    status: string;
    healthy: boolean;
  }>;
  strategy: string;
  notes: string[];
};

const HIGH_THROUGHPUT: ManagedModelRuntimeKind[] = ["vllm", "sglang"];

export function planGpuThroughput(params: {
  modelManager: ManagedModelManager;
  preference?: GpuThroughputPreference;
  modelName?: string;
}): GpuThroughputPlan {
  const preference = params.preference ?? "auto";
  const runtimes = params.modelManager.listRuntimes();
  const notes: string[] = [
    "KGM does not ship production CUDA kernels; GPU throughput uses managed vLLM/SGLang workers.",
    "DeepSeek V4 / GLM specialized GGUF local throughput uses managed ds4 (see GET /v1/runtime/workers/ds4 servingHints).",
    "Simulated multi-GPU / speculative paths are disabled unless KGM_ALLOW_SIMULATED_INFERENCE=1.",
  ];

  const filtered = runtimes.filter((runtime) => {
    if (params.modelName && runtime.modelName !== params.modelName && runtime.upstreamModel !== params.modelName) {
      return false;
    }
    if (preference === "vllm") return runtime.runtime === "vllm";
    if (preference === "sglang") return runtime.runtime === "sglang";
    return HIGH_THROUGHPUT.includes(runtime.runtime);
  });

  const candidates = filtered.map((runtime) => ({
    runtimeId: runtime.id,
    runtime: runtime.runtime,
    status: runtime.status,
    healthy: runtime.status === "running" && runtime.healthStatus !== "unavailable",
  }));

  const running = filtered.find((runtime) => runtime.status === "running");
  const selectedRuntime = running ?? filtered[0];

  return {
    preference,
    selected: selectedRuntime
      ? {
          runtimeId: selectedRuntime.id,
          modelName: selectedRuntime.modelName,
          runtime: selectedRuntime.runtime,
          baseUrl: selectedRuntime.baseUrl,
        }
      : undefined,
    candidates,
    strategy: selectedRuntime
      ? `delegate_to_${selectedRuntime.runtime}`
      : "no_high_throughput_worker_register_vllm_or_sglang",
    notes,
  };
}
