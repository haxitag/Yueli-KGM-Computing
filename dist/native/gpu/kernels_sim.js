import { rmsNorm as rmsNormCpu, silu, softmax as softmaxCpu } from "../tensor.js";
import { decodeBFloat16, decodeFloat16 } from "./buffer.js";
function decodeRowToF32(params) {
    const out = new Float32Array(params.cols);
    const buf = Buffer.from(params.bytes);
    const rowOffset = params.row * params.cols * 2;
    for (let c = 0; c < params.cols; c += 1) {
        const u16 = buf.readUInt16LE(rowOffset + c * 2);
        out[c] = params.dtype === "bf16" ? decodeBFloat16(u16) : decodeFloat16(u16);
    }
    return out;
}
function decodeAllToF32(bytes, dtype) {
    const n = Math.floor(bytes.byteLength / 2);
    const out = new Float32Array(n);
    const buf = Buffer.from(bytes);
    for (let i = 0; i < n; i += 1) {
        const u16 = buf.readUInt16LE(i * 2);
        out[i] = dtype === "bf16" ? decodeBFloat16(u16) : decodeFloat16(u16);
    }
    return out;
}
function matVec(weight, rows, cols, x) {
    const out = new Float32Array(rows);
    for (let r = 0; r < rows; r += 1) {
        let sum = 0;
        const off = r * cols;
        for (let c = 0; c < cols; c += 1) {
            sum += weight[off + c] * x[c];
        }
        out[r] = sum;
    }
    return out;
}
function argmax(values) {
    let bestIdx = 0;
    let best = values[0] ?? Number.NEGATIVE_INFINITY;
    for (let i = 1; i < values.length; i += 1) {
        const v = values[i];
        if (v > best) {
            best = v;
            bestIdx = i;
        }
    }
    return bestIdx;
}
export function createSimGpuKernels(params) {
    return {
        embeddingLookup({ table, tokenId, hiddenSize }) {
            const bytes = params.memRead(table.ptr);
            return decodeRowToF32({ bytes, dtype: table.dtype, row: tokenId, cols: hiddenSize });
        },
        lmHeadMatVec({ weight, vocabSize, hiddenSize, hidden }) {
            const bytes = params.memRead(weight.ptr);
            const w = decodeAllToF32(bytes, weight.dtype);
            return matVec(w, vocabSize, hiddenSize, hidden);
        },
        argmax,
        rmsnorm({ input, weight, eps }) {
            return rmsNormCpu(input, weight, eps);
        },
        siluMul({ gate, up }) {
            const out = new Float32Array(gate.length);
            for (let i = 0; i < gate.length; i += 1) {
                out[i] = silu(gate[i]) * (up[i] ?? 0);
            }
            return out;
        },
        matVecF32({ weight, rows, cols, x }) {
            return matVec(weight, rows, cols, x);
        },
        softmax(values) {
            return softmaxCpu(values);
        },
    };
}
