import fs from "node:fs";

import type { NativeGpuDtype, NativeGpuModelLayout, NativeGpuTensorLayout } from "./types.js";

type SafetensorsHeaderTensor = {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
};

type SafetensorsHeader = Record<string, SafetensorsHeaderTensor | Record<string, unknown>>;

function sizeofSafetensorsDtype(dtype: string): number | undefined {
  switch (dtype) {
    case "F16":
    case "BF16":
      return 2;
    case "F32":
      return 4;
    case "I64":
      return 8;
    case "I32":
      return 4;
    case "I16":
      return 2;
    case "I8":
    case "U8":
      return 1;
    default:
      return undefined;
  }
}

function product(shape: number[]): number {
  let out = 1;
  for (const v of shape) {
    out *= Math.max(0, Math.trunc(v));
  }
  return out;
}

export function readSafetensorsHeader(filePath: string): { header: SafetensorsHeader; headerBytes: number } {
  const handle = fs.openSync(filePath, "r");
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(handle, lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 64 * 1024 * 1024) {
      throw new Error(`safetensors_invalid_header_len:${headerLen}`);
    }
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(handle, headerBuf, 0, headerLen, 8);
    const headerText = headerBuf.toString("utf8");
    const header = JSON.parse(headerText) as SafetensorsHeader;
    return { header, headerBytes: 8 + headerLen };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Phase 6.1：safetensors → GPU tensor layout（不搬运数据）。
 * 仅解析 header 并生成每个 tensor 的 name/shape/dtype/offset 信息。
 */
export function buildGpuLayoutFromSafetensors(params: {
  filePath: string;
  targetDtype: NativeGpuDtype;
}): NativeGpuModelLayout {
  const { header, headerBytes } = readSafetensorsHeader(params.filePath);
  const tensors: NativeGpuTensorLayout[] = [];
  for (const [name, entry] of Object.entries(header)) {
    if (name === "__metadata__") {
      continue;
    }
    const t = entry as SafetensorsHeaderTensor;
    if (!t || typeof t !== "object" || !Array.isArray(t.shape) || !Array.isArray(t.data_offsets)) {
      continue;
    }
    const dtype = String(t.dtype ?? "");
    const [start, end] = t.data_offsets;
    const size = sizeofSafetensorsDtype(dtype);
    if (!size) {
      throw new Error(`native_gpu_unsupported_safetensors_dtype:${dtype}`);
    }
    const expected = product(t.shape) * size;
    const actual = Math.max(0, end - start);
    if (expected !== actual) {
      throw new Error(`native_gpu_safetensors_size_mismatch:${name}`);
    }
    tensors.push({
      name,
      shape: t.shape.map((v) => Math.trunc(v)),
      sourceDtype: dtype,
      targetDtype: params.targetDtype,
      dataOffsetBytes: headerBytes + start,
      dataLengthBytes: actual,
      sourceFile: params.filePath,
    });
  }
  tensors.sort((a, b) => a.name.localeCompare(b.name));
  return {
    format: "safetensors",
    tensors,
    notes: [
      "Parsed safetensors header into GPU tensor layout (no weight materialization).",
      `targetDtype=${params.targetDtype}`,
    ],
  };
}

