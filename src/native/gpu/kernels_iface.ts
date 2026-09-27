import type { NativeGpuDtype } from "./types.js";

export type DevicePtr = { id: string };

export type DeviceTensorHandle = {
  name: string;
  shape: number[];
  dtype: NativeGpuDtype;
  ptr: DevicePtr;
  byteLength: number;
};

/** SIM backend 允许读取 device bytes；真实 CUDA backend 不一定允许。 */
export type DeviceMemoryApi = {
  malloc(byteLength: number): DevicePtr;
  memcpyHtoD(ptr: DevicePtr, hostBytes: Uint8Array): void;
  read?(ptr: DevicePtr): Uint8Array;
};

export type KernelContext = {
  mem: DeviceMemoryApi;
};

export type GpuKernels = {
  /** embedding table: [vocab, hidden] */
  embeddingLookup(params: {
    table: DeviceTensorHandle;
    tokenId: number;
    hiddenSize: number;
  }): Float32Array;

  /** logits = W[vocab, hidden] * h[hidden] */
  lmHeadMatVec(params: {
    weight: DeviceTensorHandle;
    vocabSize: number;
    hiddenSize: number;
    hidden: Float32Array;
  }): Float32Array;

  argmax(values: Float32Array): number;

  rmsnorm(params: { input: Float32Array; weight: Float32Array; eps: number }): Float32Array;

  siluMul(params: { gate: Float32Array; up: Float32Array }): Float32Array;

  /** y = W[rows, cols] * x[cols] */
  matVecF32(params: { weight: Float32Array; rows: number; cols: number; x: Float32Array }): Float32Array;

  softmax(values: Float32Array): Float32Array;
};

