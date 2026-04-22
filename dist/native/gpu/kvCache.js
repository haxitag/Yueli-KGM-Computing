function layerSize(params) {
    return params.maxPositions * params.kvHeads * params.headDim;
}
export function createKvCache(params) {
    const keys = [];
    const values = [];
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
export function kvWrite(params) {
    const { cache } = params;
    const base = params.pos * cache.kvHeads * cache.headDim;
    cache.keys[params.layer].set(params.key, base);
    cache.values[params.layer].set(params.value, base);
}
export function kvReadAll(params) {
    const { cache } = params;
    const positions = Math.min(cache.maxPositions, Math.max(0, params.uptoPosInclusive + 1));
    const len = positions * cache.kvHeads * cache.headDim;
    return {
        keys: cache.keys[params.layer].slice(0, len),
        values: cache.values[params.layer].slice(0, len),
        positions,
    };
}
