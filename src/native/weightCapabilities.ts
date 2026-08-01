/**
 * Weight / LoRA capability surface for GGUF, safetensors, and HF layouts.
 * Documents executable vs metadata-only paths without claiming false coverage.
 */

import { getDs4QualityGates, resolveDs4ServingHints } from "../runtime/ds4SessionKv.js";

export type WeightFormatKind = "gguf" | "safetensors" | "kgm-json" | "hf-config" | "pytorch-index" | "onnx" | "unknown";

export type WeightCapability = {
  format: WeightFormatKind;
  executable: "full" | "partial" | "metadata_only" | "via_worker";
  backends: Array<"js-reference" | "native-core" | "native-gpu" | "llama.cpp" | "ds4" | "vllm" | "sglang" | "ollama" | "mlx">;
  loraSupported: boolean;
  notes: string[];
};

export type WeightCapabilityReport = {
  generatedAt: string;
  formats: WeightCapability[];
  lora: {
    supported: boolean;
    attachApi: string;
    workerFlags: Record<string, string>;
    notes: string[];
  };
  antiLockIn: {
    graphExportFormats: string[];
    weightFormats: string[];
  };
  /** Closed-loop exit criteria (not "GPU production ready") */
  closedLoop: {
    nativeGpuProductionReady: false;
    hfFullExecViaWorker: true;
    inProcessLayoutCoverage: "partial";
    resolveApi: string;
    matrix: Array<{
      layer: string;
      status: "ready" | "partial" | "sim" | "not_shipped";
      note: string;
    }>;
  };
  /** DeepSeek V4 / GLM via ds4 worker — quality gates + serving hints (P1/P2) */
  ds4?: {
    role: "managed_worker_not_native_gpu_kernels";
    qualityGates: ReturnType<typeof getDs4QualityGates>;
    servingHints: ReturnType<typeof resolveDs4ServingHints>;
    notes: string[];
  };
};

export function getWeightCapabilityReport(): WeightCapabilityReport {
  const ds4Hints = resolveDs4ServingHints();
  return {
    generatedAt: new Date().toISOString(),
    formats: [
      {
        format: "gguf",
        executable: "partial",
        backends: ["js-reference", "native-core", "llama.cpp", "ds4", "ollama"],
        loraSupported: false,
        notes: [
          "Executable under native/gguf_layout whitelist (decoder-only, dtype/tensor constraints) for light local reference.",
          "Prefer llama.cpp / Ollama for generic GGUF; DeepSeek V4 / GLM specialized GGUF → runtime ds4 (via_worker, never native-gpu).",
        ],
      },
      {
        format: "safetensors",
        executable: "partial",
        backends: ["js-reference", "vllm", "sglang", "mlx"],
        loraSupported: true,
        notes: [
          "CPU reference covers selected layouts for regression.",
          "HF safetensors production throughput should use vLLM/SGLang workers.",
        ],
      },
      {
        format: "hf-config",
        executable: "via_worker",
        backends: ["vllm", "sglang", "mlx", "ollama"],
        loraSupported: true,
        notes: [
          "config.json alone yields Canonical IR shell (metadata), not full native execution.",
          "Route HF dirs to managed vLLM/SGLang/MLX runtimes for full executability.",
        ],
      },
      {
        format: "kgm-json",
        executable: "full",
        backends: ["js-reference", "native-core"],
        loraSupported: false,
        notes: ["Native reference layouts used for CI and deterministic audits."],
      },
      {
        format: "pytorch-index",
        executable: "metadata_only",
        backends: ["vllm", "sglang"],
        loraSupported: true,
        notes: ["Index/weight_map imported into canonical metadata; execute via worker."],
      },
      {
        format: "onnx",
        executable: "metadata_only",
        backends: [],
        loraSupported: false,
        notes: [
          "Recognized for manifest routing; ONNX runtime not shipped in KGM core (frontstation MiniLM is separate).",
        ],
      },
    ],
    lora: {
      supported: true,
      attachApi: "POST /v1/kgm/models/runtimes/{id}/lora",
      workerFlags: {
        vllm: "--lora-modules name=path (via runtime.loraAdapters)",
        sglang: "--lora-path (via runtime.loraAdapters)",
        "llama.cpp": "--lora path (via runtime.loraAdapters)",
      },
      notes: [
        "LoRA adapters are attached to managed worker runtimes; native js-reference does not merge LoRA tensors in-process.",
        "ds4 path focuses on DeepSeek/GLM specialized quants; LoRA attach is not assumed.",
      ],
    },
    antiLockIn: {
      graphExportFormats: ["jsonld", "ntriples", "turtle", "graphml", "json-triples"],
      weightFormats: ["gguf", "safetensors", "kgm-json", "hf-config"],
    },
    closedLoop: {
      nativeGpuProductionReady: false,
      hfFullExecViaWorker: true,
      inProcessLayoutCoverage: "partial",
      resolveApi: "POST /v1/kgm/weights/resolve",
      matrix: [
        { layer: "Layout/IR parse", status: "ready", note: "HF config / GGUF / safetensors headers" },
        { layer: "HtoD (sim)", status: "sim", note: "cuda_sim host buffers (audit only)" },
        { layer: "HtoD (cuda malloc)", status: "partial", note: "optional native-core cuda.* (not production ops)" },
        {
          layer: "Kernels on device",
          status: "not_shipped",
          note: "KGM does not self-build; reuse llama.cpp / ds4 / vLLM / SGLang",
        },
        { layer: "Serving native-gpu", status: "not_shipped", note: "default not_implemented; SIM→js-reference only" },
        {
          layer: "Operators (product)",
          status: "ready",
          note: "via llama.cpp (generic GGUF), ds4 (DeepSeek V4/GLM), or vLLM/SGLang (HF)",
        },
        { layer: "HF full execute", status: "ready", note: "createRuntime(auto) → worker closed-loop" },
        {
          layer: "ds4 DeepSeek/GLM",
          status: "ready",
          note: "managed worker only; SSD streaming / batched-session / disk KV configured by KGM, executed by ds4-server",
        },
      ],
    },
    ds4: {
      role: "managed_worker_not_native_gpu_kernels",
      qualityGates: getDs4QualityGates(),
      servingHints: ds4Hints,
      notes: [
        "Prefer imatrix GGUFs and continuation-golden scoring from antirez/ds4 quality-testing.",
        `Micro-batch label: ${ds4Hints.microBatchLabel}; token interleave owner: ${ds4Hints.tokenInterleaveOwner}.`,
        "SSD streaming / disk KV are worker flags (KGM_DS4_SSD_STREAMING, KGM_DS4_KV_DISK_DIR).",
      ],
    },
  };
}

export function detectWeightFormat(localPath: string | undefined): WeightFormatKind {
  if (!localPath) return "unknown";
  const lower = localPath.toLowerCase().replace(/\\/g, "/");
  if (lower.endsWith(".gguf")) return "gguf";
  if (lower.endsWith(".safetensors") || lower.endsWith(".safetensors.index.json")) return "safetensors";
  if (lower.endsWith(".kgm.json") || lower.endsWith(".kgm")) return "kgm-json";
  if (lower.endsWith(".onnx")) return "onnx";
  if (lower.includes("pytorch_model") || lower.endsWith(".bin.index.json")) return "pytorch-index";
  if (lower.endsWith("config.json") || lower.endsWith("/config.json")) return "hf-config";
  // Directory-like HF checkouts (no weight suffix)
  const base = lower.split("/").pop() ?? lower;
  if (!base.includes(".") || base === "model" || base.includes("huggingface")) return "hf-config";
  return "unknown";
}
