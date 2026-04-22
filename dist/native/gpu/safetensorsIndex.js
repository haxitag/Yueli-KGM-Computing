import fs from "node:fs";
import path from "node:path";
import { buildGpuLayoutFromSafetensors } from "./safetensors.js";
/**
 * Phase 6.1：sharded safetensors index（`model.safetensors.index.json`）→ GPU tensor layout（仅元数据）。
 *
 * 策略：
 * - 读取 index.json 的 `weight_map` 得到 tensorName → shardFilename
 * - 对每个 shard 读取 safetensors header，生成 shard 内的 layout
 * - 仅保留 weight_map 里声明的 tensor（避免把未引用的 key 带进来）
 */
export function buildGpuLayoutFromSafetensorsIndex(params) {
    const raw = JSON.parse(fs.readFileSync(params.indexPath, "utf8"));
    const weightMap = raw.weight_map ?? {};
    const indexDir = path.dirname(params.indexPath);
    const tensorToShard = new Map();
    for (const [tensorName, shardName] of Object.entries(weightMap)) {
        if (typeof shardName === "string" && shardName.trim()) {
            tensorToShard.set(tensorName, shardName);
        }
    }
    const shards = Array.from(new Set(tensorToShard.values())).sort();
    const shardTensorSet = new Map();
    for (const [tensorName, shardName] of tensorToShard.entries()) {
        if (!shardTensorSet.has(shardName)) {
            shardTensorSet.set(shardName, new Set());
        }
        shardTensorSet.get(shardName).add(tensorName);
    }
    const tensors = [];
    for (const shardName of shards) {
        const shardPath = path.join(indexDir, shardName);
        const shardLayout = buildGpuLayoutFromSafetensors({ filePath: shardPath, targetDtype: params.targetDtype });
        const wanted = shardTensorSet.get(shardName) ?? new Set();
        for (const t of shardLayout.tensors) {
            if (wanted.has(t.name)) {
                tensors.push(t);
            }
        }
    }
    tensors.sort((a, b) => a.name.localeCompare(b.name));
    return {
        format: "safetensors",
        tensors,
        notes: [
            "Parsed sharded safetensors index into GPU tensor layout (no weight materialization).",
            `targetDtype=${params.targetDtype}`,
            `shards=${shards.length}`,
        ],
    };
}
