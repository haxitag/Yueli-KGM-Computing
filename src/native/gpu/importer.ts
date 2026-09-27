import type { NativeCheckpoint } from "../types.js";
import type { NativeGpuImporterOptions, NativeGpuModelLayout, NativeGpuWeights } from "./types.js";
import { buildGpuLayoutFromSafetensors } from "./safetensors.js";
import { buildGpuLayoutFromSafetensorsIndex } from "./safetensorsIndex.js";

/**
 * Phase 6.1（SIM）：
 * - 真实 GPU backend 需要把 safetensors/PyTorch shard 导入为 GPU 张量布局（含量化/分片）。
 * - 当前仓库先提供“可跑的模拟闭环”：保留 checkpoint 引用，并校验 dtype/device 入口。
 */
export function importCheckpointToGpuWeights(
  checkpoint: NativeCheckpoint,
  options: NativeGpuImporterOptions,
): NativeGpuWeights {
  if (options.device.kind !== "cuda") {
    throw new Error(`native_gpu_device_unsupported:${options.device.kind}`);
  }
  return {
    checkpoint,
    dtype: options.dtype,
    device: options.device,
  };
}

/**
 * Phase 6.1：safetensors → GPU tensor layout（仅元数据对齐，不搬运权重）。
 */
export function importSafetensorsToGpuLayout(params: {
  safetensorsPath: string;
  targetDtype: NativeGpuImporterOptions["dtype"];
}): NativeGpuModelLayout {
  return buildGpuLayoutFromSafetensors({
    filePath: params.safetensorsPath,
    targetDtype: params.targetDtype,
  });
}

/**
 * Phase 6.1：sharded safetensors index（`.safetensors.index.json`）→ GPU tensor layout（仅元数据导入）。
 */
export function importSafetensorsIndexToGpuLayout(params: {
  indexPath: string;
  targetDtype: NativeGpuImporterOptions["dtype"];
}): NativeGpuModelLayout {
  return buildGpuLayoutFromSafetensorsIndex({ indexPath: params.indexPath, targetDtype: params.targetDtype });
}

/**
 * Phase 6.1：PyTorch shard index（`weight_map`）→ GPU tensor layout（仅张量名/分片文件名；offset 未知）。
 */
export function importPytorchIndexToGpuLayout(params: {
  index: { weight_map?: Record<string, unknown> };
  targetDtype: NativeGpuImporterOptions["dtype"];
}): NativeGpuModelLayout {
  const tensors = Object.keys(params.index.weight_map ?? {})
    .sort()
    .map((name) => ({
      name,
      shape: [],
      sourceDtype: "unknown",
      targetDtype: params.targetDtype,
      sourceFile: typeof (params.index.weight_map ?? {})[name] === "string" ? String((params.index.weight_map ?? {})[name]) : undefined,
    }));
  return {
    format: "pytorch-index",
    tensors,
    notes: ["Derived tensor layout from PyTorch shard weight_map (no offsets, no shapes)."],
  };
}

