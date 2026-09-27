import type { NativeTensorEncoding, NativeTensorSource } from "./types.js";

export type DenseTensor = {
  shape: number[];
  dtype: "f32";
  data: Float32Array;
};

export type QuantizedTensor = {
  shape: number[];
  dtype: "q8_0";
  data: Int8Array;
  scales: Float32Array;
  blockSize?: number;
};

export type NativeTensor = DenseTensor | QuantizedTensor;

export function tensorToSource(tensor: NativeTensor): NativeTensorSource {
  if (tensor.dtype === "f32") {
    return {
      shape: [...tensor.shape],
      dtype: "f32",
      data: Array.from(tensor.data),
    };
  }
  return {
    shape: [...tensor.shape],
    dtype: "q8_0",
    data: Array.from(tensor.data),
    scales: Array.from(tensor.scales),
    blockSize: tensor.blockSize,
  };
}

export function loadTensor(source: NativeTensorSource, name: string): NativeTensor {
  const dtype = source.dtype ?? "f32";
  const expectedSize = source.shape.reduce((product, value) => product * value, 1);
  if (source.data.length !== expectedSize) {
    throw new Error(`tensor_size_mismatch:${name}`);
  }
  if (dtype === "q8_0") {
    if (!source.scales || source.scales.length === 0) {
      throw new Error(`quantized_tensor_scales_required:${name}`);
    }
    const rows = source.shape[0] ?? 0;
    const cols = source.shape[1] ?? 0;
    const blockSize = source.blockSize;
    const blocksPerRow = blockSize && blockSize > 0 ? Math.ceil(cols / blockSize) : 1;
    const expectedScaleCounts = new Set<number>([1, rows, rows * blocksPerRow]);
    if (source.shape.length !== 2 || !expectedScaleCounts.has(source.scales.length)) {
      throw new Error(`quantized_tensor_invalid_shape:${name}`);
    }
    return {
      shape: [...source.shape],
      dtype,
      data: Int8Array.from(source.data.map((value) => Math.max(-128, Math.min(127, Math.trunc(value))))),
      scales: Float32Array.from(source.scales),
      blockSize: blockSize && blockSize > 0 ? Math.trunc(blockSize) : undefined,
    };
  }
  return {
    shape: [...source.shape],
    dtype: "f32",
    data: Float32Array.from(source.data),
  };
}

export function tensorVector(tensor: NativeTensor, name: string): Float32Array {
  if (tensor.shape.length !== 1) {
    throw new Error(`tensor_rank_expected_1:${name}`);
  }
  return materialize(tensor);
}

export function matVec(tensor: NativeTensor, input: Float32Array, name: string): Float32Array {
  if (tensor.shape.length !== 2) {
    throw new Error(`tensor_rank_expected_2:${name}`);
  }
  const [rows, cols] = tensor.shape;
  if (cols !== input.length) {
    throw new Error(`matvec_shape_mismatch:${name}`);
  }
  const output = new Float32Array(rows);
  if (tensor.dtype === "f32") {
    for (let row = 0; row < rows; row += 1) {
      let sum = 0;
      const offset = row * cols;
      for (let col = 0; col < cols; col += 1) {
        sum += tensor.data[offset + col] * input[col];
      }
      output[row] = sum;
    }
    return output;
  }
  for (let row = 0; row < rows; row += 1) {
    output[row] = dotQuantizedRow(tensor, row, input);
  }
  return output;
}

export function materialize(tensor: NativeTensor): Float32Array {
  if (tensor.dtype === "f32") {
    return new Float32Array(tensor.data);
  }
  const output = new Float32Array(tensor.data.length);
  if (tensor.shape.length === 1) {
    const scale = tensor.scales[0] ?? 1;
    for (let index = 0; index < tensor.data.length; index += 1) {
      output[index] = tensor.data[index] * scale;
    }
    return output;
  }
  const [rows, cols] = tensor.shape;
  for (let row = 0; row < rows; row += 1) {
    output.set(materializeRow(tensor, row), row * cols);
  }
  return output;
}

export function materializeRow(tensor: NativeTensor, row: number): Float32Array {
  if (tensor.shape.length !== 2) {
    throw new Error("tensor_rank_expected_2:materialize_row");
  }
  const [rows, cols] = tensor.shape;
  if (row < 0 || row >= rows) {
    throw new Error(`tensor_row_out_of_range:${row}`);
  }
  if (tensor.dtype === "f32") {
    return tensor.data.slice(row * cols, (row + 1) * cols);
  }
  const output = new Float32Array(cols);
  const blockSize = tensor.blockSize && tensor.blockSize > 0 ? tensor.blockSize : cols;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const rowOffset = row * cols;
  for (let block = 0; block < blocksPerRow; block += 1) {
    const scale = resolveQuantScale(tensor, row, block, rows, blocksPerRow);
    const start = block * blockSize;
    const end = Math.min(start + blockSize, cols);
    for (let col = start; col < end; col += 1) {
      output[col] = tensor.data[rowOffset + col] * scale;
    }
  }
  return output;
}

export function rmsNorm(input: Float32Array, weight: Float32Array, eps: number): Float32Array {
  let meanSquare = 0;
  for (let index = 0; index < input.length; index += 1) {
    meanSquare += input[index] * input[index];
  }
  meanSquare /= Math.max(1, input.length);
  const scale = 1 / Math.sqrt(meanSquare + eps);
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[index] * scale * (weight[index] ?? 1);
  }
  return output;
}

export function silu(value: number): number {
  return value / (1 + Math.exp(-value));
}

export function addInPlace(target: Float32Array, delta: Float32Array): Float32Array {
  for (let index = 0; index < target.length; index += 1) {
    target[index] += delta[index] ?? 0;
  }
  return target;
}

export function softmax(values: Float32Array | number[]): Float32Array {
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value > max) {
      max = value;
    }
  }
  const output = new Float32Array(values.length);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const exponent = Math.exp(values[index] - max);
    output[index] = exponent;
    sum += exponent;
  }
  const normalized = sum <= 0 ? 1 : sum;
  for (let index = 0; index < output.length; index += 1) {
    output[index] /= normalized;
  }
  return output;
}

export function dot(
  left: Float32Array,
  right: Float32Array,
  leftOffset = 0,
  rightOffset = 0,
  length = Math.min(left.length - leftOffset, right.length - rightOffset),
): number {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += left[leftOffset + index] * right[rightOffset + index];
  }
  return sum;
}

export function copySlice(source: Float32Array, offset: number, length: number): Float32Array {
  return source.slice(offset, offset + length);
}

export function validateTensorShape(
  tensor: NativeTensor,
  shape: number[],
  name: string,
  allowedDtype?: NativeTensorEncoding[],
): void {
  if (tensor.shape.length !== shape.length || tensor.shape.some((value, index) => value !== shape[index])) {
    throw new Error(`tensor_shape_mismatch:${name}`);
  }
  if (allowedDtype && !allowedDtype.includes(tensor.dtype)) {
    throw new Error(`tensor_dtype_mismatch:${name}`);
  }
}

function dotQuantizedRow(
  tensor: QuantizedTensor,
  row: number,
  input: Float32Array,
): number {
  const [rows, cols] = tensor.shape;
  const blockSize = tensor.blockSize && tensor.blockSize > 0 ? tensor.blockSize : cols;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const rowOffset = row * cols;
  let sum = 0;
  for (let block = 0; block < blocksPerRow; block += 1) {
    const scale = resolveQuantScale(tensor, row, block, rows, blocksPerRow);
    const start = block * blockSize;
    const end = Math.min(start + blockSize, cols);
    let blockSum = 0;
    for (let col = start; col < end; col += 1) {
      blockSum += tensor.data[rowOffset + col] * input[col];
    }
    sum += blockSum * scale;
  }
  return sum;
}

function resolveQuantScale(
  tensor: QuantizedTensor,
  row: number,
  block: number,
  rows: number,
  blocksPerRow: number,
): number {
  if (tensor.scales.length === 1) {
    return tensor.scales[0] ?? 1;
  }
  if (tensor.scales.length === rows) {
    return tensor.scales[row] ?? 1;
  }
  return tensor.scales[row * blocksPerRow + block] ?? 1;
}
