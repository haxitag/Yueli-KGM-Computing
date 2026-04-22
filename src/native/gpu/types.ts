import type { NativeCheckpoint, NativeModelConfig } from "../types.js";

export type NativeGpuDtype = "fp16" | "bf16";

export type NativeGpuDevice = {
  kind: "cuda";
  deviceId: number;
};

export type NativeGpuImporterOptions = {
  dtype: NativeGpuDtype;
  device: NativeGpuDevice;
};

/** GPU backend 内部的“已导入权重”占位结构（SIM 模式下仅保留 canonical/checkpoint 引用）。 */
export type NativeGpuWeights = {
  checkpoint: NativeCheckpoint;
  dtype: NativeGpuDtype;
  device: NativeGpuDevice;
};

export type NativeGpuTensorLayout = {
  name: string;
  shape: number[];
  /** 源权重 dtype（来自 safetensors/pytorch 元数据） */
  sourceDtype: string;
  /** 目标 GPU dtype（fp16/bf16） */
  targetDtype: NativeGpuDtype;
  /** 在源文件内的数据区偏移（字节）。PyTorch shard 可能未知。 */
  dataOffsetBytes?: number;
  dataLengthBytes?: number;
  sourceFile?: string;
};

export type NativeGpuModelLayout = {
  format: "safetensors" | "pytorch-index";
  tensors: NativeGpuTensorLayout[];
  notes: string[];
};

export type NativeGpuWeightsLayout = {
  /** 当前仅支持 Qwen2.x decoder-only 的 layout/import 对齐阶段 */
  family: "qwen2";
  dtype: NativeGpuDtype;
  device: NativeGpuDevice;
  /** 目标 canonical tensor 名 → GPU tensor layout */
  tensors: Record<string, NativeGpuTensorLayout>;
  notes: string[];
};

export type NativeGpuMemoryPlan = {
  modelConfig: NativeModelConfig;
  dtype: NativeGpuDtype;
  /** KV cache 与中间 buffer 的预算（字节）；SIM 模式下仅做估算与回归。 */
  bytes: {
    kvCache: number;
    activationsScratch: number;
    weights: number;
    total: number;
  };
  notes: string[];
};

