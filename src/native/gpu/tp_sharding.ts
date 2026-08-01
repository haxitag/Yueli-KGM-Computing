/**
 * Tensor-parallel sharding helpers（SIM）
 *
 * 目标：为 6.5 的 TP/PP/EP 骨架提供可回归的切分/聚合工具，不绑定具体算子实现。
 */

export function shardRowsF32(params: {
  weight: Float32Array; // [rows, cols]
  rows: number;
  cols: number;
  worldSize: number;
  rank: number;
}): { shard: Float32Array; shardRows: number; rowStart: number } {
  if (params.weight.length !== params.rows * params.cols) {
    throw new Error("native_gpu_tp_shard_rows_invalid_shape");
  }
  const base = Math.floor(params.rows / params.worldSize);
  const rem = params.rows % params.worldSize;
  const shardRows = base + (params.rank < rem ? 1 : 0);
  const rowStart = base * params.rank + Math.min(params.rank, rem);
  const out = new Float32Array(shardRows * params.cols);
  for (let r = 0; r < shardRows; r += 1) {
    const src = (rowStart + r) * params.cols;
    out.set(params.weight.subarray(src, src + params.cols), r * params.cols);
  }
  return { shard: out, shardRows, rowStart };
}

export function gatherShardedRowsF32(params: {
  shards: Array<{ shard: Float32Array; shardRows: number; rowStart: number }>;
  rows: number;
  cols: number;
}): Float32Array {
  const out = new Float32Array(params.rows * params.cols);
  for (const s of params.shards) {
    if (s.shard.length !== s.shardRows * params.cols) {
      throw new Error("native_gpu_tp_gather_rows_invalid_shard_shape");
    }
    for (let r = 0; r < s.shardRows; r += 1) {
      const dst = (s.rowStart + r) * params.cols;
      out.set(s.shard.subarray(r * params.cols, (r + 1) * params.cols), dst);
    }
  }
  return out;
}

