import fs from "node:fs";
import path from "node:path";

export type PytorchIndexValidation = {
  tensorCount: number;
  shardFiles: string[];
  missingShardFiles: string[];
  invalidWeightMapEntries: string[];
};

/**
 * 内容级校验（不读权重内容）：
 * - weight_map 里的 value 必须是 string（文件名）
 * - 去重得到 shardFiles
 * - 统计缺失的 shard 文件（相对 modelDir）
 */
export function validatePytorchModelIndexJson(params: {
  modelDir: string;
  index: { weight_map?: Record<string, unknown> };
}): PytorchIndexValidation {
  const wm = params.index.weight_map ?? {};
  const invalid: string[] = [];
  const shardSet = new Set<string>();
  for (const [k, v] of Object.entries(wm)) {
    if (typeof v !== "string" || v.trim() === "") {
      invalid.push(k);
      continue;
    }
    shardSet.add(v);
  }
  const shardFiles = Array.from(shardSet).sort();
  const missing = shardFiles.filter((f) => !fs.existsSync(path.join(params.modelDir, f)));
  return {
    tensorCount: Object.keys(wm).length,
    shardFiles,
    missingShardFiles: missing,
    invalidWeightMapEntries: invalid.sort(),
  };
}

