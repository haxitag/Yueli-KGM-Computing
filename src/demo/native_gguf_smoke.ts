import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeRuntimeEngine } from "../native/engine.js";
import { createCanonicalCheckpointForNativeCore } from "../native/checkpoint.js";
import { loadNativeModel } from "../native/loaders.js";
import { withNativeCoreAddonShim } from "./native_core_smoke_support.js";

type QuantTensorKind = "Q8_0" | "Q4_K" | "Q5_K" | "Q6_K";

type GgufTensor =
  | {
      type: "F32";
      shape: number[];
      data: number[];
    }
  | {
      type: QuantTensorKind;
      shape: number[];
      rows: number[][];
    };

async function main(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "kgm-native-gguf-"));
  try {
    const scenarios = await Promise.all([
      runScenario(rootDir, "Q8_0"),
      runScenario(rootDir, "Q4_K"),
      runScenario(rootDir, "Q5_K"),
      runScenario(rootDir, "Q6_K"),
    ]);

    console.log(JSON.stringify({
      scenarios,
    }, null, 2));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runScenario(rootDir: string, quantization: QuantTensorKind): Promise<Record<string, unknown>> {
  const modelDir = path.join(rootDir, quantization.toLowerCase());
  fs.mkdirSync(modelDir, { recursive: true });
  const ggufPath = path.join(modelDir, "model.gguf");
  writeSyntheticGgufModel(ggufPath, quantization);

  const loaded = loadNativeModel(modelDir);
  assert.equal(loaded.format, "gguf");
  assert.equal(loaded.metadata.executable, true);
  assert.equal(loaded.executionBackend, "reference");
  assert.equal(loaded.manifest.executable, true);
  assert.ok(loaded.tokenizer);
  assert.ok(loaded.executableModel);
  assert.equal(loaded.manifest.canonical?.quantization, quantization);
  const canonicalCheckpoint = createCanonicalCheckpointForNativeCore(loaded);
  assert.ok(canonicalCheckpoint);
  assert.equal(canonicalCheckpoint?.tokenizer.kind, "hf-unigram");
  assert.equal(
    canonicalCheckpoint?.tensors["token_embedding.weight"]?.dtype,
    quantization === "Q8_0" ? "q8_0" : "f32",
  );

  const engine = new NativeRuntimeEngine(modelDir, {
    schedulerMaxBatchSize: 2,
    schedulerMaxPrefillsPerTick: 2,
    kvCacheMode: "paged",
    kvPageSize: 2,
    cachedKvPageBudget: 4,
    seed: 1,
  });

  const completed = await engine.complete("", {
    model: `synthetic-${quantization.toLowerCase()}`,
    requestId: `${quantization.toLowerCase()}-req`,
    sessionId: `${quantization.toLowerCase()}-session`,
    maxTokens: 2,
    temperature: 0,
  });
  const raw = (completed.raw as {
    nativeRuntime?: {
      cacheSource?: string;
      scheduler?: { kvCacheKind?: string; servingBackend?: string };
      memory?: { kvAllocatedPages?: number; cachedKvPageBudget?: number };
    };
  }).nativeRuntime;

  assert.equal(completed.text, "ok");
  assert.equal(raw?.cacheSource, "cold");
  assert.equal(raw?.scheduler?.kvCacheKind, "paged");
  assert.equal(raw?.scheduler?.servingBackend, "js-reference");
  assert.equal(raw?.memory?.cachedKvPageBudget, 4);
  assert.ok((raw?.memory?.kvAllocatedPages ?? 0) >= 1);
  const nativeCore = await withNativeCoreAddonShim(async () => {
    const nativeCoreEngine = new NativeRuntimeEngine(modelDir, {
      servingBackend: "native-core",
      seed: 1,
    });
    const result = await nativeCoreEngine.complete("", {
      model: `synthetic-${quantization.toLowerCase()}-native-core`,
      requestId: `${quantization.toLowerCase()}-native-core`,
      sessionId: `${quantization.toLowerCase()}-native-core`,
      maxTokens: 2,
      temperature: 0,
    });
    const nativeRuntime = (result.raw as {
      nativeRuntime?: {
        scheduler?: { servingBackend?: string };
      };
    }).nativeRuntime;
    assert.equal(result.text, "ok");
    assert.equal(nativeCoreEngine.servingBackend(), "native-core");
    assert.equal(nativeRuntime?.scheduler?.servingBackend, "native-core");
    return {
      servingBackend: nativeCoreEngine.servingBackend(),
      result: result.text,
      raw: nativeRuntime,
    };
  });

  return {
    quantization,
    nativeCoreTokenizerKind: canonicalCheckpoint?.tokenizer.kind,
    format: loaded.format,
    executionBackend: loaded.executionBackend,
    manifest: loaded.manifest.canonical,
    result: completed.text,
    raw,
    nativeCore,
  };
}

function writeSyntheticGgufModel(filePath: string, quantization: QuantTensorKind): void {
  const alignment = 32;
  const metadata = new Map<string, unknown>([
    ["general.architecture", "llama"],
    ["general.name", `synthetic-gguf-${quantization.toLowerCase()}`],
    ["general.alignment", 32],
    ["llama.context_length", 16],
    ["llama.embedding_length", 2],
    ["llama.block_count", 1],
    ["llama.feed_forward_length", 2],
    ["llama.attention.head_count", 1],
    ["llama.attention.head_count_kv", 1],
    ["llama.rope.freq_base", 10000],
    ["tokenizer.ggml.model", "llama"],
    ["tokenizer.ggml.tokens", ["<s>", "</s>", "▁ok", "<unk>"]],
    ["tokenizer.ggml.scores", [0, 0, -0.1, 0]],
    ["tokenizer.ggml.bos_token_id", 0],
    ["tokenizer.ggml.eos_token_id", 1],
    ["tokenizer.ggml.unknown_token_id", 3],
    ["tokenizer.ggml.padding_token_id", 1],
    ["tokenizer.chat_template", "{{ messages }}"],
  ]);

  const tensors = new Map<string, GgufTensor>([
    ["token_embd.weight", { type: quantization, shape: [4, 2], rows: [
      [1, 0],
      [0, 0],
      [0, 1],
      [-1, 0],
    ] }],
    ["output_norm.weight", { type: "F32", shape: [2], data: [1, 1] }],
    ["blk.0.attn_norm.weight", { type: "F32", shape: [2], data: [1, 1] }],
    ["blk.0.ffn_norm.weight", { type: "F32", shape: [2], data: [1, 1] }],
    ["blk.0.attn_q.weight", { type: quantization, shape: [2, 2], rows: [[0, 0], [0, 0]] }],
    ["blk.0.attn_k.weight", { type: quantization, shape: [2, 2], rows: [[0, 0], [0, 0]] }],
    ["blk.0.attn_v.weight", { type: quantization, shape: [2, 2], rows: [[0, 0], [0, 0]] }],
    ["blk.0.attn_output.weight", { type: quantization, shape: [2, 2], rows: [[0, 0], [0, 0]] }],
    ["blk.0.ffn_gate.weight", { type: quantization, shape: [2, 2], rows: [[0, 0], [0, 0]] }],
    ["blk.0.ffn_down.weight", { type: quantization, shape: [2, 2], rows: [[0, 0], [0, 0]] }],
    ["blk.0.ffn_up.weight", { type: quantization, shape: [2, 2], rows: [[0, 0], [0, 0]] }],
    ["output.weight", { type: quantization, shape: [4, 2], rows: [
      [0, 0],
      [1, 2],
      [2, 0],
      [-1, -1],
    ] }],
  ]);

  const metadataEntries = Array.from(metadata.entries()).map(([key, value]) => encodeMetadataEntry(key, value));
  const tensorBuffers = Array.from(tensors.entries()).map(([name, tensor]) => ({
    name,
    tensor,
    buffer: encodeGgufTensorData(tensor),
  }));

  let relativeOffset = 0;
  const tensorInfos = tensorBuffers.map(({ name, tensor, buffer }) => {
    relativeOffset = alignOffset(relativeOffset, alignment);
    const info = encodeTensorInfo(name, tensor, encodeDtypeCode(tensor.type), relativeOffset);
    relativeOffset += buffer.length;
    return info;
  });

  const header = Buffer.alloc(24);
  header.write("GGUF", 0, "utf8");
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(BigInt(tensors.size), 8);
  header.writeBigUInt64LE(BigInt(metadataEntries.length), 16);

  const prefix = Buffer.concat([
    header,
    ...metadataEntries,
    ...tensorInfos,
  ]);
  const dataSectionOffset = alignOffset(prefix.length, alignment);
  const data = Buffer.alloc(relativeOffset);
  for (const [index, { buffer }] of tensorBuffers.entries()) {
    const infoOffset = decodeTensorInfoOffset(tensorInfos[index]!);
    buffer.copy(data, infoOffset);
  }

  fs.writeFileSync(filePath, Buffer.concat([
    prefix,
    Buffer.alloc(dataSectionOffset - prefix.length),
    data,
  ]));
}

function encodeMetadataEntry(key: string, value: unknown): Buffer {
  const keyBytes = Buffer.from(key, "utf8");
  const keyLength = Buffer.alloc(8);
  keyLength.writeBigUInt64LE(BigInt(keyBytes.length), 0);
  const encoded = encodeMetadataValue(value);
  const type = Buffer.alloc(4);
  type.writeUInt32LE(encoded.type, 0);
  return Buffer.concat([keyLength, keyBytes, type, encoded.buffer]);
}

function encodeMetadataValue(value: unknown): { type: number; buffer: Buffer } {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length), 0);
    return { type: 8, buffer: Buffer.concat([length, bytes]) };
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value, 0);
    return { type: 4, buffer };
  }
  if (typeof value === "number") {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatLE(value, 0);
    return { type: 6, buffer };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const subtype = Buffer.alloc(4);
    subtype.writeUInt32LE(8, 0);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(value.length), 0);
    const items = value.map((item) => encodeMetadataValue(item).buffer);
    return { type: 9, buffer: Buffer.concat([subtype, length, ...items]) };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    const subtype = Buffer.alloc(4);
    subtype.writeUInt32LE(6, 0);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(value.length), 0);
    const items = value.map((item) => encodeMetadataValue(item).buffer);
    return { type: 9, buffer: Buffer.concat([subtype, length, ...items]) };
  }
  throw new Error(`unsupported_gguf_metadata_value:${String(value)}`);
}

function encodeTensorInfo(name: string, tensor: GgufTensor, dtypeCode: number, relativeOffset: number): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const nameLength = Buffer.alloc(8);
  nameLength.writeBigUInt64LE(BigInt(nameBytes.length), 0);
  const rank = tensor.shape.length;
  const rankBuffer = Buffer.alloc(4);
  rankBuffer.writeUInt32LE(rank, 0);
  const ggmlShape = tensor.shape.length === 2
    ? [tensor.shape[1]!, tensor.shape[0]!]
    : [...tensor.shape];
  const dims = ggmlShape.map((value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value), 0);
    return buffer;
  });
  const type = Buffer.alloc(4);
  type.writeUInt32LE(dtypeCode, 0);
  const offset = Buffer.alloc(8);
  offset.writeBigUInt64LE(BigInt(relativeOffset), 0);
  return Buffer.concat([nameLength, nameBytes, rankBuffer, ...dims, type, offset]);
}

function decodeTensorInfoOffset(info: Buffer): number {
  return Number(info.readBigUInt64LE(info.length - 8));
}

function encodeDtypeCode(type: GgufTensor["type"]): number {
  switch (type) {
    case "F32":
      return 0;
    case "Q8_0":
      return 8;
    case "Q4_K":
      return 12;
    case "Q5_K":
      return 13;
    case "Q6_K":
      return 14;
  }
}

function encodeGgufTensorData(tensor: GgufTensor): Buffer {
  if (tensor.type === "F32") {
    const buffer = Buffer.alloc(tensor.data.length * 4);
    for (let index = 0; index < tensor.data.length; index += 1) {
      buffer.writeFloatLE(tensor.data[index] ?? 0, index * 4);
    }
    return buffer;
  }
  if (tensor.type === "Q8_0") {
    return encodeQ80Rows(tensor.shape, tensor.rows);
  }
  if (tensor.type === "Q4_K") {
    return encodeQ4KRows(tensor.shape, tensor.rows);
  }
  if (tensor.type === "Q5_K") {
    return encodeQ5KRows(tensor.shape, tensor.rows);
  }
  return encodeQ6KRows(tensor.shape, tensor.rows);
}

function encodeQ80Rows(shape: number[], rows: number[][]): Buffer {
  const blockSize = 32;
  const cols = shape[1]!;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const chunks: Buffer[] = [];
  for (const row of rows) {
    for (let block = 0; block < blocksPerRow; block += 1) {
      const start = block * blockSize;
      const values = row.slice(start, start + blockSize);
      const integral = values.every((value) => Number.isInteger(value) && Math.abs(value) <= 127);
      const scale = integral
        ? (values.some((value) => value !== 0) ? 1 : 0)
        : values.reduce((max, value) => Math.max(max, Math.abs(value) / 127), 0);
      const scaleBuffer = Buffer.alloc(2);
      scaleBuffer.writeUInt16LE(float32ToFloat16Bits(scale), 0);
      const quantized = Buffer.alloc(blockSize);
      for (let index = 0; index < blockSize; index += 1) {
        const value = values[index] ?? 0;
        const quant = scale === 0 ? 0 : Math.max(-128, Math.min(127, Math.round(value / scale)));
        quantized.writeInt8(quant, index);
      }
      chunks.push(scaleBuffer, quantized);
    }
  }
  return Buffer.concat(chunks);
}

function encodeQ4KRows(shape: number[], rows: number[][]): Buffer {
  return encodeKQuantRows(shape, rows, 4);
}

function encodeQ5KRows(shape: number[], rows: number[][]): Buffer {
  return encodeKQuantRows(shape, rows, 5);
}

function encodeQ6KRows(shape: number[], rows: number[][]): Buffer {
  const blockSize = 256;
  const cols = shape[1]!;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const chunks: Buffer[] = [];
  const zeroBlock = new Array<number>(blockSize).fill(0);
  for (const row of rows) {
    for (let block = 0; block < blocksPerRow; block += 1) {
      const blockValues = zeroBlock.slice();
      const start = block * blockSize;
      const rowSlice = row.slice(start, start + blockSize);
      for (let index = 0; index < rowSlice.length; index += 1) {
        blockValues[index] = rowSlice[index] ?? 0;
      }
      const dBuffer = Buffer.alloc(2);
      dBuffer.writeUInt16LE(float32ToFloat16Bits(1), 0);
      const ql = Buffer.alloc(128);
      const qh = Buffer.alloc(64);
      const scales = Buffer.alloc(16);
      for (let group = 0; group < 16; group += 1) {
        const groupValues = blockValues.slice(group * 16, group * 16 + 16);
        if (!groupValues.some((value) => value !== 0)) {
          continue;
        }
        scales.writeInt8(1, group);
        for (let index = 0; index < 16; index += 1) {
          const blockIndex = group * 16 + index;
          const quantized = Math.max(0, Math.min(63, Math.round((groupValues[index] ?? 0) + 32)));
          writeNibble(ql, blockIndex, quantized & 0x0f);
          writeTwoBits(qh, blockIndex, (quantized >> 4) & 0x03);
        }
      }
      chunks.push(dBuffer, ql, qh, scales);
    }
  }
  return Buffer.concat(chunks);
}

function encodeKQuantRows(shape: number[], rows: number[][], bits: 4 | 5): Buffer {
  const blockSize = 256;
  const cols = shape[1]!;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const chunks: Buffer[] = [];
  const zeroBlock = new Array<number>(blockSize).fill(0);
  for (const row of rows) {
    for (let block = 0; block < blocksPerRow; block += 1) {
      const blockValues = zeroBlock.slice();
      const start = block * blockSize;
      const rowSlice = row.slice(start, start + blockSize);
      for (let index = 0; index < rowSlice.length; index += 1) {
        blockValues[index] = rowSlice[index] ?? 0;
      }
      const groupOffset = bits === 4 ? 8 : 16;
      const d = 1;
      const dmin = 1;
      const scales = new Array<number>(8).fill(0);
      const mins = new Array<number>(8).fill(0);
      const qh = bits === 5 ? Buffer.alloc(32) : undefined;
      const qs = Buffer.alloc(128);
      for (let group = 0; group < 8; group += 1) {
        const groupValues = blockValues.slice(group * 32, group * 32 + 32);
        if (!groupValues.some((value) => value !== 0)) {
          continue;
        }
        scales[group] = 1;
        mins[group] = groupOffset;
        for (let index = 0; index < 32; index += 1) {
          const quantized = Math.max(0, Math.min((1 << bits) - 1, Math.round((groupValues[index] ?? 0) + groupOffset)));
          const blockIndex = group * 32 + index;
          writeNibble(qs, blockIndex, quantized & 0x0f);
          if (qh && quantized >= 16) {
            writeBit(qh, blockIndex);
          }
        }
      }
      const dBuffer = Buffer.alloc(2);
      const dMinBuffer = Buffer.alloc(2);
      dBuffer.writeUInt16LE(float32ToFloat16Bits(d), 0);
      dMinBuffer.writeUInt16LE(float32ToFloat16Bits(dmin), 0);
      chunks.push(dBuffer, dMinBuffer, packKQuantScalesMins(scales, mins));
      if (qh) {
        chunks.push(qh);
      }
      chunks.push(qs);
    }
  }
  return Buffer.concat(chunks);
}

function packKQuantScalesMins(scales: number[], mins: number[]): Buffer {
  const buffer = Buffer.alloc(12);
  for (let index = 0; index < 4; index += 1) {
    buffer[index] = (scales[index]! & 0x3f) | ((scales[index + 4]! >> 4) << 6);
    buffer[index + 4] = (mins[index]! & 0x3f) | ((mins[index + 4]! >> 4) << 6);
    buffer[index + 8] = (scales[index + 4]! & 0x0f) | ((mins[index + 4]! & 0x0f) << 4);
  }
  return buffer;
}

function writeNibble(buffer: Buffer, index: number, value: number): void {
  const byteIndex = Math.floor(index / 2);
  const existing = buffer[byteIndex] ?? 0;
  buffer[byteIndex] = index % 2 === 0
    ? ((existing & 0xf0) | (value & 0x0f))
    : ((existing & 0x0f) | ((value & 0x0f) << 4));
}

function writeBit(buffer: Buffer, index: number): void {
  const byteIndex = Math.floor(index / 8);
  buffer[byteIndex] = (buffer[byteIndex] ?? 0) | (1 << (index % 8));
}

function writeTwoBits(buffer: Buffer, index: number, value: number): void {
  const byteIndex = Math.floor(index / 4);
  const shift = (index % 4) * 2;
  const existing = buffer[byteIndex] ?? 0;
  buffer[byteIndex] = (existing & ~(0x03 << shift)) | ((value & 0x03) << shift);
}

function float32ToFloat16Bits(value: number): number {
  if (value === 0) {
    return 0;
  }
  const sign = value < 0 ? 1 : 0;
  const abs = Math.abs(value);
  const exponent = Math.floor(Math.log2(abs));
  const mantissa = abs / 2 ** exponent - 1;
  const halfExponent = exponent + 15;
  if (halfExponent <= 0) {
    return sign << 15;
  }
  if (halfExponent >= 0x1f) {
    return (sign << 15) | 0x7c00;
  }
  const halfMantissa = Math.round(mantissa * 1024) & 0x03ff;
  return (sign << 15) | (halfExponent << 10) | halfMantissa;
}

function alignOffset(offset: number, alignment: number): number {
  const normalized = Math.max(1, alignment);
  return Math.ceil(offset / normalized) * normalized;
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
