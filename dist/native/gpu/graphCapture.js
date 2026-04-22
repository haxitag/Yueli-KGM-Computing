/**
 * Graph capture（SIM 占位）
 *
 * - 目的：为后续 CUDA Graph / kernel fusion 留出“捕获 + 回放”接口形状
 * - 当前实现：记录 kernel 调用序列，并在 replay 时顺序执行（无性能收益）
 */
export function captureKernels(params) {
    const ops = [];
    const wrapped = {
        embeddingLookup: (args) => {
            ops.push({ op: "embeddingLookup", args });
            return params.kernels.embeddingLookup(args);
        },
        lmHeadMatVec: (args) => {
            ops.push({ op: "lmHeadMatVec", args });
            return params.kernels.lmHeadMatVec(args);
        },
        argmax: (args) => {
            ops.push({ op: "argmax", args });
            return params.kernels.argmax(args);
        },
        rmsnorm: (args) => params.kernels.rmsnorm(args),
        siluMul: (args) => params.kernels.siluMul(args),
        matVecF32: (args) => params.kernels.matVecF32(args),
        softmax: (args) => params.kernels.softmax(args),
    };
    return {
        kernels: wrapped,
        stop: () => ({ ops: [...ops] }),
    };
}
export function replayCapturedGraph(params) {
    let last;
    for (const item of params.graph.ops) {
        if (item.op === "embeddingLookup") {
            last = params.kernels.embeddingLookup(item.args);
        }
        else if (item.op === "lmHeadMatVec") {
            last = params.kernels.lmHeadMatVec(item.args);
        }
        else if (item.op === "argmax") {
            last = params.kernels.argmax(item.args);
        }
        else {
            const _exhaustive = item;
            throw new Error(`native_gpu_graph_capture_unknown_op:${String(_exhaustive?.op)}`);
        }
    }
    return last;
}
