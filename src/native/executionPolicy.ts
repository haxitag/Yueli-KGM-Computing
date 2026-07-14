/**
 * Closed-loop execution policy: when to use native vs via_worker (vLLM/SGLang/…).
 * Honest gate — does not claim GPU kernels are production-ready.
 */

import type { ManagedModelArtifact, ManagedModelRuntimeKind } from "../models/modelManager.js";
import { detectWeightFormat, type WeightFormatKind } from "./weightCapabilities.js";
import { isLlamaCppSelectable, type LlamaCppDeployConfig } from "../runtime/llamaCppDeploy.js";

export type ExecutionPath = "native_in_process" | "via_worker" | "metadata_only";

export type ArtifactExecutionAssessment = {
  format: WeightFormatKind;
  path: ExecutionPath;
  nativeAllowed: boolean;
  recommendedRuntimes: ManagedModelRuntimeKind[];
  reason: string;
};

const WORKER_KINDS: ManagedModelRuntimeKind[] = ["vllm", "sglang", "openai-compatible", "mlx", "llama.cpp", "ollama"];

export function assessArtifactExecution(artifact: ManagedModelArtifact | undefined): ArtifactExecutionAssessment {
  const hints = artifact?.runtimeHints?.length
    ? artifact.runtimeHints
    : (["openai-compatible", "vllm", "sglang"] as ManagedModelRuntimeKind[]);
  const format = detectWeightFormat(artifact?.localPath ?? artifact?.filePath ?? artifact?.sourceRef);
  const nativeInHints = hints.includes("native");

  if (!artifact) {
    return {
      format: "unknown",
      path: "via_worker",
      nativeAllowed: false,
      recommendedRuntimes: WORKER_KINDS.filter((k) => k !== "llama.cpp" && k !== "ollama").slice(0, 3),
      reason: "no_artifact_default_via_worker",
    };
  }

  // HF config-only / transformers dirs / generic safetensors dirs: worker-first
  if (format === "hf-config" || format === "pytorch-index") {
    return {
      format,
      path: "via_worker",
      nativeAllowed: false,
      recommendedRuntimes: hints.filter((h) => h !== "native"),
      reason: "hf_or_pytorch_layout_requires_worker_not_in_process_native",
    };
  }

  if (format === "safetensors" && !nativeInHints) {
    return {
      format,
      path: "via_worker",
      nativeAllowed: false,
      recommendedRuntimes: hints,
      reason: "safetensors_production_path_is_vllm_or_sglang",
    };
  }

  if (format === "kgm-json" || (format === "gguf" && nativeInHints)) {
    return {
      format,
      path: "native_in_process",
      nativeAllowed: true,
      recommendedRuntimes: hints,
      reason: format === "kgm-json" ? "kgm_json_cpu_reference_executable" : "gguf_whitelist_may_be_executable_in_native",
    };
  }

  if (format === "onnx") {
    return {
      format,
      path: "metadata_only",
      nativeAllowed: false,
      recommendedRuntimes: ["openai-compatible"],
      reason: "onnx_not_executed_by_kgm_core",
    };
  }

  // Default: if hints include native, allow; else via_worker
  if (nativeInHints) {
    return {
      format,
      path: "native_in_process",
      nativeAllowed: true,
      recommendedRuntimes: hints,
      reason: "artifact_runtime_hints_include_native",
    };
  }

  return {
    format,
    path: "via_worker",
    nativeAllowed: false,
    recommendedRuntimes: hints.length ? hints : ["vllm", "sglang", "openai-compatible"],
    reason: "default_via_worker_closed_loop",
  };
}

export function resolveRuntimeKind(params: {
  requested?: ManagedModelRuntimeKind | "auto";
  artifact?: ManagedModelArtifact;
  llamaCpp?: Partial<LlamaCppDeployConfig>;
}): ManagedModelRuntimeKind {
  const assessment = assessArtifactExecution(params.artifact);
  const requested = params.requested ?? "auto";
  const llamaOk = isLlamaCppSelectable(params.llamaCpp);

  const filterCallable = (kinds: ManagedModelRuntimeKind[]): ManagedModelRuntimeKind[] =>
    kinds.filter((kind) => (kind === "llama.cpp" ? llamaOk : true));

  if (requested === "auto") {
    const first = filterCallable(assessment.recommendedRuntimes)[0] ?? filterCallable(["vllm", "sglang", "openai-compatible"])[0];
    if (!first) {
      throw new Error(
        llamaOk
          ? "runtime_auto_failed:no_recommended_runtime"
          : "runtime_auto_failed:no_recommended_runtime;llama_cpp_unavailable_install_or_enable",
      );
    }
    return first;
  }

  if (requested === "llama.cpp" && !llamaOk) {
    throw new Error(
      "llama_cpp_unavailable:enable_and_install_llama-server;set_KGM_LLAMA_CPP_ENABLED=on|auto_and_KGM_LLAMA_SERVER_CMD",
    );
  }

  if (requested === "native" && !assessment.nativeAllowed) {
    const suggest = filterCallable(assessment.recommendedRuntimes).join(",");
    throw new Error(
      `native_runtime_not_allowed:${assessment.reason};use_via_worker:${suggest || "vllm,sglang"}`,
    );
  }

  return requested;
}

export type NativeGpuClosedLoopStatus = {
  servingEntry: "native-gpu";
  productionReady: false;
  dataPath: {
    layoutParse: true;
    hostToDeviceSim: true;
    hostToDeviceCudaMalloc: "optional";
    kernelsOnDevice: false;
  };
  servingDefault: "not_implemented";
  simBypass: {
    env: "KGM_NATIVE_GPU_SIMULATED=1";
    delegatesTo: "js-reference";
    tagsResponse: true;
  };
  /** Product path: reuse engines that already ship operators */
  recommendedThroughput: Array<"llama.cpp" | "vllm" | "sglang">;
  operatorStrategy: "reuse_external_engines_no_self_built_kernels";
  preferredLocalOpsEngine: "llama.cpp";
  exitCriteriaMet: {
    capabilitiesApiConsistent: boolean;
    hfAutoViaWorker: boolean;
    nativeGpuFailsWithoutSim: boolean;
    simLabeled: boolean;
  };
};

export function getNativeGpuClosedLoopStatus(): NativeGpuClosedLoopStatus {
  return {
    servingEntry: "native-gpu",
    productionReady: false,
    dataPath: {
      layoutParse: true,
      hostToDeviceSim: true,
      hostToDeviceCudaMalloc: "optional",
      kernelsOnDevice: false,
    },
    servingDefault: "not_implemented",
    simBypass: {
      env: "KGM_NATIVE_GPU_SIMULATED=1",
      delegatesTo: "js-reference",
      tagsResponse: true,
    },
    recommendedThroughput: ["llama.cpp", "vllm", "sglang"],
    operatorStrategy: "reuse_external_engines_no_self_built_kernels",
    preferredLocalOpsEngine: "llama.cpp",
    exitCriteriaMet: {
      capabilitiesApiConsistent: true,
      hfAutoViaWorker: true,
      nativeGpuFailsWithoutSim: true,
      simLabeled: true,
    },
  };
}
