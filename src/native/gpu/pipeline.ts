import type { NativeGpuDtype, NativeGpuTensorLayout } from "./types.js";
import { buildGpuLayoutFromSafetensorsIndex } from "./safetensorsIndex.js";
import { loadAndCastSafetensorsTensor } from "./buffer.js";
import type { CudaDevicePtr } from "./cuda_sim.js";

export type CudaLikeApi = {
  malloc(byteLength: number): CudaDevicePtr;
  memcpyHtoD(ptr: CudaDevicePtr, hostBytes: Uint8Array): void;
};

export type NativeGpuLoadedTensor = {
  name: string;
  ptr: CudaDevicePtr;
  byteLength: number;
  sourceFile: string;
  stats: ReturnType<typeof loadAndCastSafetensorsTensor>["stats"];
};

/**
 * Phase 6.1（端到端，CUDA 仿真）：
 * - `.safetensors.index.json` → 多 shard header 合并为 layout
 * - 逐 tensor：按 offset 读取 slice → cast(fp16/bf16) → malloc → memcpyHtoD
 *
 * 真实 CUDA binding 只需替换 `cuda` 实现，不改上层逻辑。
 */
export function loadAndCastSafetensorsIndexToDevice(params: {
  indexPath: string;
  targetDtype: NativeGpuDtype;
  cuda: CudaLikeApi;
}): { tensors: NativeGpuLoadedTensor[]; notes: string[] } {
  const layout = buildGpuLayoutFromSafetensorsIndex({
    indexPath: params.indexPath,
    targetDtype: params.targetDtype,
  });
  const loaded: NativeGpuLoadedTensor[] = [];
  for (const t of layout.tensors) {
    loaded.push(loadOne(t, params.targetDtype, params.cuda));
  }
  return {
    tensors: loaded,
    notes: [...layout.notes, "Loaded tensors into CUDA-like device buffers (SIM by default)."],
  };
}

function loadOne(t: NativeGpuTensorLayout, targetDtype: NativeGpuDtype, cuda: CudaLikeApi): NativeGpuLoadedTensor {
  const casted = loadAndCastSafetensorsTensor({ tensor: t, targetDtype });
  const ptr = cuda.malloc(casted.bytes.byteLength);
  cuda.memcpyHtoD(ptr, casted.bytes);
  return {
    name: t.name,
    ptr,
    byteLength: casted.bytes.byteLength,
    sourceFile: t.sourceFile ?? "",
    stats: casted.stats,
  };
}

