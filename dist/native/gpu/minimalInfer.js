import { createTokenizer } from "../tokenizer.js";
import { encodeBFloat16, encodeFloat16 } from "./buffer.js";
import { CudaSimApi } from "./cuda_sim.js";
import { createSimGpuKernels } from "./kernels_sim.js";
function product(shape) {
    let out = 1;
    for (const v of shape) {
        out *= Math.max(0, Math.trunc(v));
    }
    return out;
}
function readRequiredTensorF32(checkpoint, name) {
    const src = checkpoint.tensors[name];
    if (!src) {
        throw new Error(`native_gpu_minimal_missing_tensor:${name}`);
    }
    if ((src.dtype ?? "f32") !== "f32") {
        throw new Error(`native_gpu_minimal_expected_f32:${name}`);
    }
    const expected = product(src.shape);
    if ((src.data?.length ?? 0) !== expected) {
        throw new Error(`native_gpu_minimal_tensor_size_mismatch:${name}`);
    }
    return { shape: src.shape.map((v) => Math.trunc(v)), data: Float32Array.from(src.data) };
}
function encodeF32ToDtypeBytes(values, dtype) {
    const out = new Uint8Array(values.length * 2);
    const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    if (dtype === "bf16") {
        for (let i = 0; i < values.length; i += 1) {
            buf.writeUInt16LE(encodeBFloat16(values[i]), i * 2);
        }
        return out;
    }
    for (let i = 0; i < values.length; i += 1) {
        buf.writeUInt16LE(encodeFloat16(values[i]), i * 2);
    }
    return out;
}
function uploadTensorF32ToDevice(params) {
    const bytes = encodeF32ToDtypeBytes(params.values, params.dtype);
    const ptr = params.cuda.malloc(bytes.byteLength);
    params.cuda.memcpyHtoD(ptr, bytes);
    return { name: params.name, shape: params.shape, dtype: params.dtype, ptr, byteLength: bytes.byteLength };
}
function rowSlice(weight, cols, row) {
    return weight.slice(row * cols, (row + 1) * cols);
}
/**
 * Phase 6.3（SIM）：GPU 最小闭环（embedding + lm_head + greedy）。
 *
 * 注意：
 * - 当前实现只在 SIM 侧进行计算（float32），但仍会走 `CudaLikeApi` 上传权重字节；
 * - 后续接入真实 CUDA kernels 时，这里的 host 计算将被 device kernels 替换。
 */
export function minimalGpuGenerateSim(params) {
    const tokenizer = createTokenizer(params.checkpoint.tokenizer);
    const vocab = params.checkpoint.config.vocabSize;
    const hidden = params.checkpoint.config.hiddenSize;
    const emb = readRequiredTensorF32(params.checkpoint, "token_embedding.weight");
    const head = readRequiredTensorF32(params.checkpoint, "lm_head.weight");
    if (emb.shape.length !== 2 || emb.shape[0] !== vocab || emb.shape[1] !== hidden) {
        throw new Error("native_gpu_minimal_embedding_shape_invalid");
    }
    if (head.shape.length !== 2 || head.shape[0] !== vocab || head.shape[1] !== hidden) {
        throw new Error("native_gpu_minimal_lm_head_shape_invalid");
    }
    // Upload weights into device buffers (SIM) and execute kernels against device bytes.
    const cuda = new CudaSimApi();
    const { devEmb, devHead, kernels } = prepareDeviceAndKernels({
        cuda,
        dtype: params.dtype,
        embedding: emb,
        lmHead: head,
    });
    const tokens = [...params.promptTokens];
    for (let step = 0; step < params.maxNewTokens; step += 1) {
        const last = tokens[tokens.length - 1] ?? 0;
        // embedding 从 device buffer 解码；lm_head 从 device buffer 解码并 matvec（SIM）。
        const h = kernels.embeddingLookup({ table: devEmb, tokenId: last, hiddenSize: hidden });
        const logits = kernels.lmHeadMatVec({ weight: devHead, vocabSize: vocab, hiddenSize: hidden, hidden: h });
        const next = kernels.argmax(logits);
        tokens.push(next);
    }
    const text = tokenizer.decode(tokens, { skipSpecialTokens: true });
    return { tokens, text };
}
export function prepareDeviceAndKernels(params) {
    const devEmb = uploadTensorF32ToDevice({
        cuda: params.cuda,
        name: "token_embedding.weight",
        shape: params.embedding.shape,
        values: params.embedding.data,
        dtype: params.dtype,
    });
    const devHead = uploadTensorF32ToDevice({
        cuda: params.cuda,
        name: "lm_head.weight",
        shape: params.lmHead.shape,
        values: params.lmHead.data,
        dtype: params.dtype,
    });
    const kernels = createSimGpuKernels({ memRead: (ptr) => params.cuda.read(ptr) });
    return { devEmb, devHead, kernels };
}
