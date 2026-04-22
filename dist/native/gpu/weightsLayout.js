import { buildQwen2SafetensorsAliases } from "./qwen2.js";
import { importSafetensorsToGpuLayout } from "./importer.js";
import { buildGpuLayoutFromSafetensorsIndex } from "./safetensorsIndex.js";
function isSameShape(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((v, i) => v === b[i]);
}
export function buildQwen2GpuWeightsLayoutFromSafetensors(params) {
    const cfg = params.checkpoint.config;
    const aliases = buildQwen2SafetensorsAliases({ config: cfg, tieWordEmbeddings: params.tieWordEmbeddings });
    const srcLayout = importSafetensorsToGpuLayout({ safetensorsPath: params.safetensorsPath, targetDtype: params.dtype });
    const bySource = new Map(srcLayout.tensors.map((t) => [t.name, t]));
    const out = {};
    for (const alias of aliases) {
        const src = bySource.get(alias.source);
        if (!src) {
            throw new Error(`native_gpu_missing_tensor:${alias.source}`);
        }
        if (src.shape.length > 0 && !isSameShape(src.shape, alias.shape)) {
            throw new Error(`native_gpu_tensor_shape_mismatch:${alias.source}`);
        }
        out[alias.target] = {
            ...src,
            name: alias.target,
            sourceFile: src.sourceFile,
        };
    }
    return {
        family: "qwen2",
        dtype: params.dtype,
        device: params.device,
        tensors: out,
        notes: [
            "Qwen2.x safetensors → GPU weights layout (metadata-only, no materialization).",
            ...srcLayout.notes,
        ],
    };
}
export function buildQwen2GpuWeightsLayoutFromSafetensorsIndex(params) {
    const cfg = params.checkpoint.config;
    const aliases = buildQwen2SafetensorsAliases({ config: cfg, tieWordEmbeddings: params.tieWordEmbeddings });
    const srcLayout = buildGpuLayoutFromSafetensorsIndex({ indexPath: params.indexPath, targetDtype: params.dtype });
    const bySource = new Map(srcLayout.tensors.map((t) => [t.name, t]));
    const out = {};
    for (const alias of aliases) {
        const src = bySource.get(alias.source);
        if (!src) {
            throw new Error(`native_gpu_missing_tensor:${alias.source}`);
        }
        if (src.shape.length > 0 && !isSameShape(src.shape, alias.shape)) {
            throw new Error(`native_gpu_tensor_shape_mismatch:${alias.source}`);
        }
        out[alias.target] = { ...src, name: alias.target, sourceFile: src.sourceFile };
    }
    return {
        family: "qwen2",
        dtype: params.dtype,
        device: params.device,
        tensors: out,
        notes: [
            "Qwen2.x sharded safetensors → GPU weights layout (metadata-only, no materialization).",
            ...srcLayout.notes,
        ],
    };
}
