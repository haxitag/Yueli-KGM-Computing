import fs from "node:fs";

import type { NativeGpuDtype, NativeGpuTensorLayout } from "./types.js";

export type NativeGpuTensorBuffer = {
  tensor: NativeGpuTensorLayout;
  /** 目标 dtype 的原始字节（little-endian 16-bit） */
  bytes: Uint8Array;
  stats: {
    elements: number;
    min: number;
    max: number;
    mean: number;
    /** 简单校验：把输出 bytes 视为 u32 的 sum（溢出截断） */
    checksumU32: number;
  };
};

function product(shape: number[]): number {
  let out = 1;
  for (const v of shape) {
    out *= Math.max(0, Math.trunc(v));
  }
  return out;
}

function readFileSlice(filePath: string, offset: number, length: number): Buffer {
  const handle = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(handle, buf, 0, length, offset);
    return buf;
  } finally {
    fs.closeSync(handle);
  }
}

function float32FromBits(bits: number): number {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(bits >>> 0, 0);
  return b.readFloatLE(0);
}

function bitsFromFloat32(value: number): number {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value, 0);
  return b.readUInt32LE(0);
}

export function decodeBFloat16(u16: number): number {
  const bits = (u16 & 0xffff) << 16;
  return float32FromBits(bits >>> 0);
}

export function encodeBFloat16(value: number): number {
  const bits = bitsFromFloat32(value);
  return (bits >>> 16) & 0xffff;
}

// IEEE754 half conversion (round-to-nearest-even)
export function decodeFloat16(u16: number): number {
  const sign = (u16 & 0x8000) ? -1 : 1;
  const exp = (u16 >> 10) & 0x1f;
  const frac = u16 & 0x03ff;
  if (exp === 0) {
    if (frac === 0) {
      return sign * 0;
    }
    return sign * 2 ** (-14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac === 0 ? sign * Infinity : NaN;
  }
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

export function encodeFloat16(value: number): number {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) {
      return 0x7e00;
    }
    return value < 0 ? 0xfc00 : 0x7c00;
  }
  const sign = value < 0 || Object.is(value, -0) ? 1 : 0;
  const abs = Math.abs(value);
  if (abs === 0) {
    return sign ? 0x8000 : 0;
  }
  // clamp to max half
  if (abs >= 65504) {
    return (sign << 15) | 0x7bff;
  }
  const bits = bitsFromFloat32(abs);
  const exp = (bits >>> 23) & 0xff;
  const frac = bits & 0x7fffff;
  // unbiased exp for f32 is exp-127, for f16 is exp-15
  const halfExp = exp - 127 + 15;
  if (halfExp <= 0) {
    // subnormal half
    const shift = 14 - (exp - 127);
    const mant = (1 << 23) | frac;
    const rounded = mant >> shift;
    // round-to-nearest-even
    const remainder = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    let halfFrac = rounded >> 13;
    if (remainder > halfway || (remainder === halfway && (halfFrac & 1) === 1)) {
      halfFrac += 1;
    }
    return (sign << 15) | (halfFrac & 0x03ff);
  }
  if (halfExp >= 31) {
    return (sign << 15) | 0x7c00;
  }
  // normal half
  let halfFrac = frac >> 13;
  const roundBits = frac & 0x1fff;
  if (roundBits > 0x1000 || (roundBits === 0x1000 && (halfFrac & 1) === 1)) {
    halfFrac += 1;
    if (halfFrac === 0x400) {
      // carry into exponent
      return (sign << 15) | ((halfExp + 1) << 10);
    }
  }
  return (sign << 15) | (halfExp << 10) | (halfFrac & 0x03ff);
}

function decodeTensorToFloat32(params: {
  sourceDtype: string;
  shape: number[];
  raw: Buffer;
}): Float32Array {
  const dtype = params.sourceDtype.toUpperCase();
  const n = product(params.shape);
  const out = new Float32Array(n);
  if (dtype === "F32") {
    for (let i = 0; i < n; i += 1) {
      out[i] = params.raw.readFloatLE(i * 4);
    }
    return out;
  }
  if (dtype === "F16") {
    for (let i = 0; i < n; i += 1) {
      out[i] = decodeFloat16(params.raw.readUInt16LE(i * 2));
    }
    return out;
  }
  if (dtype === "BF16") {
    for (let i = 0; i < n; i += 1) {
      out[i] = decodeBFloat16(params.raw.readUInt16LE(i * 2));
    }
    return out;
  }
  throw new Error(`native_gpu_buffer_unsupported_source_dtype:${dtype}`);
}

function encodeFloat32ToTargetBytes(values: Float32Array, target: NativeGpuDtype): Uint8Array {
  const out = Buffer.alloc(values.length * 2);
  if (target === "bf16") {
    for (let i = 0; i < values.length; i += 1) {
      out.writeUInt16LE(encodeBFloat16(values[i]!), i * 2);
    }
    return new Uint8Array(out);
  }
  for (let i = 0; i < values.length; i += 1) {
    out.writeUInt16LE(encodeFloat16(values[i]!), i * 2);
  }
  return new Uint8Array(out);
}

function computeStats(values: Float32Array, encoded: Uint8Array): NativeGpuTensorBuffer["stats"] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = values.length > 0 ? sum / values.length : 0;
  // checksum: sum u32
  const buf = Buffer.from(encoded);
  let checksum = 0;
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    checksum = (checksum + buf.readUInt32LE(i)) >>> 0;
  }
  // tail
  const rem = buf.length % 4;
  if (rem) {
    const tail = Buffer.alloc(4);
    buf.copy(tail, 0, buf.length - rem);
    checksum = (checksum + tail.readUInt32LE(0)) >>> 0;
  }
  return {
    elements: values.length,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    mean,
    checksumU32: checksum,
  };
}

/**
 * Phase 6.1（更真实）：按 layout 从 safetensors 读取原始 bytes，并 cast 到目标 dtype 的 bytes。
 * - 仍不做 CUDA；只打通“读取 + cast + 可回归统计”。
 */
export function loadAndCastSafetensorsTensor(params: {
  tensor: NativeGpuTensorLayout;
  targetDtype: NativeGpuDtype;
}): NativeGpuTensorBuffer {
  if (!params.tensor.sourceFile || typeof params.tensor.dataOffsetBytes !== "number" || typeof params.tensor.dataLengthBytes !== "number") {
    throw new Error("native_gpu_tensor_missing_source_offsets");
  }
  const raw = readFileSlice(params.tensor.sourceFile, params.tensor.dataOffsetBytes, params.tensor.dataLengthBytes);
  const values = decodeTensorToFloat32({
    sourceDtype: params.tensor.sourceDtype,
    shape: params.tensor.shape,
    raw,
  });
  const bytes = encodeFloat32ToTargetBytes(values, params.targetDtype);
  const stats = computeStats(values, bytes);
  return {
    tensor: { ...params.tensor, targetDtype: params.targetDtype },
    bytes,
    stats,
  };
}

