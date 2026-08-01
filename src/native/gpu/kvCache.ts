export type KvCache = {
  /** [layer][pos][kvHeads][headDim] flattened */
  keys: Float32Array[];
  values: Float32Array[];
  numLayers: number;
  maxPositions: number;
  kvHeads: number;
  headDim: number;
  /** current filled positions */
  position: number;
};

function layerSize(params: { maxPositions: number; kvHeads: number; headDim: number }): number {
  return params.maxPositions * params.kvHeads * params.headDim;
}

export function createKvCache(params: {
  numLayers: number;
  maxPositions: number;
  kvHeads: number;
  headDim: number;
}): KvCache {
  const keys: Float32Array[] = [];
  const values: Float32Array[] = [];
  const size = layerSize(params);
  for (let l = 0; l < params.numLayers; l += 1) {
    keys.push(new Float32Array(size));
    values.push(new Float32Array(size));
  }
  return {
    keys,
    values,
    numLayers: params.numLayers,
    maxPositions: params.maxPositions,
    kvHeads: params.kvHeads,
    headDim: params.headDim,
    position: 0,
  };
}

export function kvWrite(params: {
  cache: KvCache;
  layer: number;
  pos: number;
  key: Float32Array; // [kvHeads*headDim]
  value: Float32Array; // [kvHeads*headDim]
}): void {
  const { cache } = params;
  const base = params.pos * cache.kvHeads * cache.headDim;
  cache.keys[params.layer]!.set(params.key, base);
  cache.values[params.layer]!.set(params.value, base);
}

export function kvReadAll(params: {
  cache: KvCache;
  layer: number;
  uptoPosInclusive: number;
}): { keys: Float32Array; values: Float32Array; positions: number } {
  const { cache } = params;
  const positions = Math.min(cache.maxPositions, Math.max(0, params.uptoPosInclusive + 1));
  const len = positions * cache.kvHeads * cache.headDim;
  return {
    keys: cache.keys[params.layer]!.slice(0, len),
    values: cache.values[params.layer]!.slice(0, len),
    positions,
  };
}

