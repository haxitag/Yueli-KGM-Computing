import { addInPlace, copySlice, dot, materializeRow, matVec, rmsNorm, silu, softmax, tensorToSource, tensorVector, validateTensorShape, type NativeTensor } from "./tensor.js";
import type { NativeCheckpoint, NativeModelConfig, NativeTokenizerSpec } from "./types.js";

type TransformerLayerWeights = {
  attnNorm: Float32Array;
  ffnNorm: Float32Array;
  wq: NativeTensor;
  wk: NativeTensor;
  wv: NativeTensor;
  wo: NativeTensor;
  w1: NativeTensor;
  w2: NativeTensor;
  w3: NativeTensor;
};

type TransformerWeights = {
  tokenEmbedding: NativeTensor;
  outputNorm: Float32Array;
  lmHead: NativeTensor;
  layers: TransformerLayerWeights[];
};

export type DenseKvCacheSnapshot = {
  kind: "dense";
  position: number;
  keys: Float32Array[];
  values: Float32Array[];
};

export type PagedKvCacheSnapshot = {
  kind: "paged";
  position: number;
  pageSize: number;
  keys: Array<Array<{ pageIndex: number; data: Float32Array }>>;
  values: Array<Array<{ pageIndex: number; data: Float32Array }>>;
};

export type KvCacheSnapshot = DenseKvCacheSnapshot | PagedKvCacheSnapshot;

export class GlobalPagedKvAllocator {
  private freePages = new Map<number, Float32Array[]>();
  private residentPageCount = 0;
  private peakResidentPageCount = 0;

  allocate(length: number): Float32Array {
    const normalizedLength = Math.max(1, length);
    const bucket = this.freePages.get(normalizedLength);
    const reused = bucket?.pop();
    const page = reused ?? new Float32Array(normalizedLength);
    page.fill(0);
    this.residentPageCount += 1;
    this.peakResidentPageCount = Math.max(this.peakResidentPageCount, this.residentPageCount);
    return page;
  }

  release(page: Float32Array): void {
    page.fill(0);
    const bucket = this.freePages.get(page.length) ?? [];
    bucket.push(page);
    this.freePages.set(page.length, bucket);
    this.residentPageCount = Math.max(0, this.residentPageCount - 1);
  }

  residentPages(): number {
    return this.residentPageCount;
  }

  peakResidentPages(): number {
    return this.peakResidentPageCount;
  }
}

export type NativeKvCache = {
  readonly kind: "dense" | "paged";
  readonly maxPositions: number;
  readonly numLayers: number;
  readonly numKvHeads: number;
  readonly headDim: number;
  position: number;
  clone(): NativeKvCache;
  snapshot(): KvCacheSnapshot;
  restore(snapshot: KvCacheSnapshot): void;
  release(): void;
  setKey(layer: number, position: number, kvHead: number, vector: Float32Array): void;
  setValue(layer: number, position: number, kvHead: number, vector: Float32Array): void;
  getKey(layer: number, position: number, kvHead: number): Float32Array;
  getValue(layer: number, position: number, kvHead: number): Float32Array;
  residentBytes(): number;
  allocatedPages(): number;
};

export class KvCache implements NativeKvCache {
  readonly kind = "dense" as const;
  readonly maxPositions: number;
  readonly numLayers: number;
  readonly numKvHeads: number;
  readonly headDim: number;
  position = 0;
  private keys: Float32Array[];
  private values: Float32Array[];

  constructor(params: {
    maxPositions: number;
    numLayers: number;
    numKvHeads: number;
    headDim: number;
  }) {
    this.maxPositions = params.maxPositions;
    this.numLayers = params.numLayers;
    this.numKvHeads = params.numKvHeads;
    this.headDim = params.headDim;
    this.keys = Array.from(
      { length: params.numLayers },
      () => new Float32Array(params.maxPositions * params.numKvHeads * params.headDim),
    );
    this.values = Array.from(
      { length: params.numLayers },
      () => new Float32Array(params.maxPositions * params.numKvHeads * params.headDim),
    );
  }

  clone(): KvCache {
    const cloned = new KvCache({
      maxPositions: this.maxPositions,
      numLayers: this.numLayers,
      numKvHeads: this.numKvHeads,
      headDim: this.headDim,
    });
    cloned.position = this.position;
    for (let layer = 0; layer < this.numLayers; layer += 1) {
      cloned.keys[layer].set(this.keys[layer]);
      cloned.values[layer].set(this.values[layer]);
    }
    return cloned;
  }

  snapshot(): KvCacheSnapshot {
    return {
      kind: "dense",
      position: this.position,
      keys: this.keys.map((value) => new Float32Array(value)),
      values: this.values.map((value) => new Float32Array(value)),
    };
  }

  restore(snapshot: KvCacheSnapshot): void {
    if (snapshot.kind !== "dense") {
      throw new Error("kv_cache_snapshot_kind_mismatch:dense");
    }
    this.position = snapshot.position;
    for (let layer = 0; layer < this.numLayers; layer += 1) {
      this.keys[layer].set(snapshot.keys[layer]);
      this.values[layer].set(snapshot.values[layer]);
    }
  }

  release(): void {
    this.position = 0;
    for (let layer = 0; layer < this.numLayers; layer += 1) {
      this.keys[layer].fill(0);
      this.values[layer].fill(0);
    }
  }

  setKey(layer: number, position: number, kvHead: number, vector: Float32Array): void {
    const offset = this.offset(position, kvHead);
    this.keys[layer].set(vector, offset);
  }

  setValue(layer: number, position: number, kvHead: number, vector: Float32Array): void {
    const offset = this.offset(position, kvHead);
    this.values[layer].set(vector, offset);
  }

  getKey(layer: number, position: number, kvHead: number): Float32Array {
    return copySlice(this.keys[layer], this.offset(position, kvHead), this.headDim);
  }

  getValue(layer: number, position: number, kvHead: number): Float32Array {
    return copySlice(this.values[layer], this.offset(position, kvHead), this.headDim);
  }

  private offset(position: number, kvHead: number): number {
    return (position * this.numKvHeads + kvHead) * this.headDim;
  }

  residentBytes(): number {
    const elements = this.maxPositions * this.numLayers * this.numKvHeads * this.headDim * 2;
    return elements * Float32Array.BYTES_PER_ELEMENT;
  }

  allocatedPages(): number {
    return this.numLayers * this.maxPositions;
  }
}

export class PagedKvCache implements NativeKvCache {
  readonly kind = "paged" as const;
  readonly maxPositions: number;
  readonly numLayers: number;
  readonly numKvHeads: number;
  readonly headDim: number;
  readonly pageSize: number;
  position = 0;
  private keys: Array<Map<number, Float32Array>>;
  private values: Array<Map<number, Float32Array>>;
  private pageElementCount: number;
  private allocator?: GlobalPagedKvAllocator;

  constructor(params: {
    maxPositions: number;
    numLayers: number;
    numKvHeads: number;
    headDim: number;
    pageSize: number;
    allocator?: GlobalPagedKvAllocator;
  }) {
    this.maxPositions = params.maxPositions;
    this.numLayers = params.numLayers;
    this.numKvHeads = params.numKvHeads;
    this.headDim = params.headDim;
    this.pageSize = Math.max(1, params.pageSize);
    this.pageElementCount = this.pageSize * this.numKvHeads * this.headDim;
    this.allocator = params.allocator;
    this.keys = Array.from({ length: params.numLayers }, () => new Map<number, Float32Array>());
    this.values = Array.from({ length: params.numLayers }, () => new Map<number, Float32Array>());
  }

  clone(): NativeKvCache {
    const cloned = new PagedKvCache({
      maxPositions: this.maxPositions,
      numLayers: this.numLayers,
      numKvHeads: this.numKvHeads,
      headDim: this.headDim,
      pageSize: this.pageSize,
      allocator: this.allocator,
    });
    cloned.restore(this.snapshot());
    return cloned;
  }

  snapshot(): KvCacheSnapshot {
    return {
      kind: "paged",
      position: this.position,
      pageSize: this.pageSize,
      keys: this.keys.map((pages) =>
        Array.from(pages.entries()).map(([pageIndex, data]) => ({
          pageIndex,
          data: new Float32Array(data),
        })),
      ),
      values: this.values.map((pages) =>
        Array.from(pages.entries()).map(([pageIndex, data]) => ({
          pageIndex,
          data: new Float32Array(data),
        })),
      ),
    };
  }

  restore(snapshot: KvCacheSnapshot): void {
    if (snapshot.kind !== "paged") {
      throw new Error("kv_cache_snapshot_kind_mismatch:paged");
    }
    this.release();
    this.position = snapshot.position;
    this.keys = snapshot.keys.map((pages) => new Map(
      pages.map((page) => {
        const allocated = this.allocatePage();
        allocated.set(page.data);
        return [page.pageIndex, allocated] as const;
      }),
    ));
    this.values = snapshot.values.map((pages) => new Map(
      pages.map((page) => {
        const allocated = this.allocatePage();
        allocated.set(page.data);
        return [page.pageIndex, allocated] as const;
      }),
    ));
  }

  release(): void {
    for (const pages of this.keys) {
      for (const page of pages.values()) {
        this.releasePage(page);
      }
      pages.clear();
    }
    for (const pages of this.values) {
      for (const page of pages.values()) {
        this.releasePage(page);
      }
      pages.clear();
    }
    this.position = 0;
  }

  setKey(layer: number, position: number, kvHead: number, vector: Float32Array): void {
    const { keyPage, offset } = this.ensurePages(layer, position);
    keyPage.set(vector, offset + kvHead * this.headDim);
  }

  setValue(layer: number, position: number, kvHead: number, vector: Float32Array): void {
    const { valuePage, offset } = this.ensurePages(layer, position);
    valuePage.set(vector, offset + kvHead * this.headDim);
  }

  getKey(layer: number, position: number, kvHead: number): Float32Array {
    const { keyPage, offset } = this.getPages(layer, position);
    return copySlice(keyPage, offset + kvHead * this.headDim, this.headDim);
  }

  getValue(layer: number, position: number, kvHead: number): Float32Array {
    const { valuePage, offset } = this.getPages(layer, position);
    return copySlice(valuePage, offset + kvHead * this.headDim, this.headDim);
  }

  residentBytes(): number {
    return this.allocatedPages() * this.pageElementCount * Float32Array.BYTES_PER_ELEMENT * 2;
  }

  allocatedPages(): number {
    return this.keys.reduce((count, pages) => count + pages.size, 0);
  }

  private ensurePages(layer: number, position: number): {
    keyPage: Float32Array;
    valuePage: Float32Array;
    offset: number;
  } {
    const pageIndex = Math.floor(position / this.pageSize);
    const offset = (position % this.pageSize) * this.numKvHeads * this.headDim;
    let keyPage = this.keys[layer]!.get(pageIndex);
    let valuePage = this.values[layer]!.get(pageIndex);
    if (!keyPage || !valuePage) {
      keyPage = this.allocatePage();
      valuePage = this.allocatePage();
      this.keys[layer]!.set(pageIndex, keyPage);
      this.values[layer]!.set(pageIndex, valuePage);
    }
    return { keyPage, valuePage, offset };
  }

  private getPages(layer: number, position: number): {
    keyPage: Float32Array;
    valuePage: Float32Array;
    offset: number;
  } {
    const pageIndex = Math.floor(position / this.pageSize);
    const offset = (position % this.pageSize) * this.numKvHeads * this.headDim;
    const keyPage = this.keys[layer]!.get(pageIndex);
    const valuePage = this.values[layer]!.get(pageIndex);
    if (!keyPage || !valuePage) {
      throw new Error(`kv_page_missing:layer=${layer}:position=${position}`);
    }
    return { keyPage, valuePage, offset };
  }

  private allocatePage(): Float32Array {
    return this.allocator?.allocate(this.pageElementCount) ?? new Float32Array(this.pageElementCount);
  }

  private releasePage(page: Float32Array): void {
    if (this.allocator) {
      this.allocator.release(page);
      return;
    }
    page.fill(0);
  }
}

export function countKvSnapshotPages(snapshot: KvCacheSnapshot): number {
  if (snapshot.kind !== "paged") {
    return 0;
  }
  return snapshot.keys.reduce((count, pages) => count + pages.length, 0);
}

export class NativeTransformerModel {
  readonly config: NativeModelConfig;
  readonly weights: TransformerWeights;
  readonly numKvHeads: number;
  readonly headDim: number;
  readonly ropeTheta: number;
  readonly ropeDimension: number;

  constructor(checkpoint: NativeCheckpoint, tensors: Record<string, NativeTensor>) {
    this.config = checkpoint.config;
    this.numKvHeads = checkpoint.config.numKvHeads ?? checkpoint.config.numHeads;
    this.headDim = checkpoint.config.hiddenSize / checkpoint.config.numHeads;
    if (!Number.isInteger(this.headDim)) {
      throw new Error("hidden_size_must_be_divisible_by_num_heads");
    }
    this.ropeTheta = checkpoint.config.ropeTheta ?? 10000;
    this.ropeDimension = checkpoint.config.ropeDimension ?? this.headDim;
    this.weights = buildWeights(checkpoint.config, tensors);
    validateWeights(this.config, this.weights, this.numKvHeads, this.headDim);
  }

  createCache(options?: { kind?: "dense" | "paged"; pageSize?: number; allocator?: GlobalPagedKvAllocator }): NativeKvCache {
    if (options?.kind === "paged") {
      return new PagedKvCache({
        maxPositions: this.config.maxPositionEmbeddings,
        numLayers: this.config.numLayers,
        numKvHeads: this.numKvHeads,
        headDim: this.headDim,
        pageSize: options.pageSize ?? 16,
        allocator: options.allocator,
      });
    }
    return new KvCache({
      maxPositions: this.config.maxPositionEmbeddings,
      numLayers: this.config.numLayers,
      numKvHeads: this.numKvHeads,
      headDim: this.headDim,
    });
  }

  forwardToken(tokenId: number, cache: NativeKvCache): Float32Array {
    if (cache.position >= cache.maxPositions) {
      throw new Error("native_runtime_context_window_exceeded");
    }

    let hidden = embeddingLookup(this.weights.tokenEmbedding, tokenId);
    const kvGroupSize = this.config.numHeads / this.numKvHeads;
    const position = cache.position;
    for (let layerIndex = 0; layerIndex < this.weights.layers.length; layerIndex += 1) {
      const layer = this.weights.layers[layerIndex];
      const normed = rmsNorm(hidden, layer.attnNorm, this.config.normEps ?? 1e-5);
      const q = matVec(layer.wq, normed, `layers.${layerIndex}.attention.wq.weight`);
      const k = matVec(layer.wk, normed, `layers.${layerIndex}.attention.wk.weight`);
      const v = matVec(layer.wv, normed, `layers.${layerIndex}.attention.wv.weight`);

      for (let head = 0; head < this.config.numHeads; head += 1) {
        applyRotaryEmbedding(q, head * this.headDim, position, this.ropeTheta, this.ropeDimension, this.headDim);
      }
      for (let head = 0; head < this.numKvHeads; head += 1) {
        applyRotaryEmbedding(k, head * this.headDim, position, this.ropeTheta, this.ropeDimension, this.headDim);
        cache.setKey(layerIndex, position, head, copySlice(k, head * this.headDim, this.headDim));
        cache.setValue(layerIndex, position, head, copySlice(v, head * this.headDim, this.headDim));
      }

      const attentionCombined = new Float32Array(this.config.hiddenSize);
      for (let head = 0; head < this.config.numHeads; head += 1) {
        const kvHead = Math.floor(head / kvGroupSize);
        const qOffset = head * this.headDim;
        const scores = new Float32Array(position + 1);
        for (let timestep = 0; timestep <= position; timestep += 1) {
          const key = cache.getKey(layerIndex, timestep, kvHead);
          scores[timestep] = dot(q, key, qOffset, 0, this.headDim) / Math.sqrt(this.headDim);
        }
        const weights = softmax(scores);
        const context = new Float32Array(this.headDim);
        for (let timestep = 0; timestep <= position; timestep += 1) {
          const value = cache.getValue(layerIndex, timestep, kvHead);
          const weight = weights[timestep] ?? 0;
          for (let dim = 0; dim < this.headDim; dim += 1) {
            context[dim] += value[dim] * weight;
          }
        }
        attentionCombined.set(context, qOffset);
      }

      addInPlace(hidden, matVec(layer.wo, attentionCombined, `layers.${layerIndex}.attention.wo.weight`));

      const ffnInput = rmsNorm(hidden, layer.ffnNorm, this.config.normEps ?? 1e-5);
      const gate = matVec(layer.w1, ffnInput, `layers.${layerIndex}.feed_forward.w1.weight`);
      const up = matVec(layer.w3, ffnInput, `layers.${layerIndex}.feed_forward.w3.weight`);
      const activated = new Float32Array(gate.length);
      for (let index = 0; index < gate.length; index += 1) {
        activated[index] = silu(gate[index]) * up[index];
      }
      addInPlace(hidden, matVec(layer.w2, activated, `layers.${layerIndex}.feed_forward.w2.weight`));
    }

    cache.position += 1;
    const output = rmsNorm(hidden, this.weights.outputNorm, this.config.normEps ?? 1e-5);
    return matVec(this.weights.lmHead, output, "lm_head.weight");
  }

  toCheckpoint(tokenizer: NativeTokenizerSpec): NativeCheckpoint {
    const tensors: Record<string, NativeCheckpoint["tensors"][string]> = {
      "token_embedding.weight": tensorToSource(this.weights.tokenEmbedding),
      "output_norm.weight": {
        shape: [this.weights.outputNorm.length],
        dtype: "f32",
        data: Array.from(this.weights.outputNorm),
      },
      "lm_head.weight": tensorToSource(this.weights.lmHead),
    };
    for (let index = 0; index < this.weights.layers.length; index += 1) {
      const layer = this.weights.layers[index];
      tensors[`layers.${index}.attn_norm.weight`] = {
        shape: [layer.attnNorm.length],
        dtype: "f32",
        data: Array.from(layer.attnNorm),
      };
      tensors[`layers.${index}.ffn_norm.weight`] = {
        shape: [layer.ffnNorm.length],
        dtype: "f32",
        data: Array.from(layer.ffnNorm),
      };
      tensors[`layers.${index}.attention.wq.weight`] = tensorToSource(layer.wq);
      tensors[`layers.${index}.attention.wk.weight`] = tensorToSource(layer.wk);
      tensors[`layers.${index}.attention.wv.weight`] = tensorToSource(layer.wv);
      tensors[`layers.${index}.attention.wo.weight`] = tensorToSource(layer.wo);
      tensors[`layers.${index}.feed_forward.w1.weight`] = tensorToSource(layer.w1);
      tensors[`layers.${index}.feed_forward.w2.weight`] = tensorToSource(layer.w2);
      tensors[`layers.${index}.feed_forward.w3.weight`] = tensorToSource(layer.w3);
    }
    return {
      format: "kgm-transformer-checkpoint",
      version: 1,
      config: { ...this.config },
      tokenizer: { ...tokenizer },
      tensors,
      metadata: {
        source: "native-transformer-model",
      },
    };
  }
}

function buildWeights(config: NativeModelConfig, tensors: Record<string, NativeTensor>): TransformerWeights {
  const layers: TransformerLayerWeights[] = [];
  for (let index = 0; index < config.numLayers; index += 1) {
    layers.push({
      attnNorm: tensorVector(requireTensor(tensors, `layers.${index}.attn_norm.weight`), `layers.${index}.attn_norm.weight`),
      ffnNorm: tensorVector(requireTensor(tensors, `layers.${index}.ffn_norm.weight`), `layers.${index}.ffn_norm.weight`),
      wq: requireTensor(tensors, `layers.${index}.attention.wq.weight`),
      wk: requireTensor(tensors, `layers.${index}.attention.wk.weight`),
      wv: requireTensor(tensors, `layers.${index}.attention.wv.weight`),
      wo: requireTensor(tensors, `layers.${index}.attention.wo.weight`),
      w1: requireTensor(tensors, `layers.${index}.feed_forward.w1.weight`),
      w2: requireTensor(tensors, `layers.${index}.feed_forward.w2.weight`),
      w3: requireTensor(tensors, `layers.${index}.feed_forward.w3.weight`),
    });
  }
  return {
    tokenEmbedding: requireTensor(tensors, "token_embedding.weight"),
    outputNorm: tensorVector(requireTensor(tensors, "output_norm.weight"), "output_norm.weight"),
    lmHead: requireTensor(tensors, "lm_head.weight"),
    layers,
  };
}

function validateWeights(
  config: NativeModelConfig,
  weights: TransformerWeights,
  numKvHeads: number,
  headDim: number,
): void {
  validateTensorShape(weights.tokenEmbedding, [config.vocabSize, config.hiddenSize], "token_embedding.weight", ["f32", "q8_0"]);
  validateTensorShape(weights.lmHead, [config.vocabSize, config.hiddenSize], "lm_head.weight", ["f32", "q8_0"]);
  if (weights.outputNorm.length !== config.hiddenSize) {
    throw new Error("tensor_shape_mismatch:output_norm.weight");
  }
  for (let index = 0; index < weights.layers.length; index += 1) {
    const layer = weights.layers[index];
    if (layer.attnNorm.length !== config.hiddenSize || layer.ffnNorm.length !== config.hiddenSize) {
      throw new Error(`tensor_shape_mismatch:layers.${index}.*norm.weight`);
    }
    validateTensorShape(layer.wq, [config.hiddenSize, config.hiddenSize], `layers.${index}.attention.wq.weight`, ["f32", "q8_0"]);
    validateTensorShape(layer.wk, [numKvHeads * headDim, config.hiddenSize], `layers.${index}.attention.wk.weight`, ["f32", "q8_0"]);
    validateTensorShape(layer.wv, [numKvHeads * headDim, config.hiddenSize], `layers.${index}.attention.wv.weight`, ["f32", "q8_0"]);
    validateTensorShape(layer.wo, [config.hiddenSize, config.hiddenSize], `layers.${index}.attention.wo.weight`, ["f32", "q8_0"]);
    validateTensorShape(layer.w1, [config.intermediateSize, config.hiddenSize], `layers.${index}.feed_forward.w1.weight`, ["f32", "q8_0"]);
    validateTensorShape(layer.w2, [config.hiddenSize, config.intermediateSize], `layers.${index}.feed_forward.w2.weight`, ["f32", "q8_0"]);
    validateTensorShape(layer.w3, [config.intermediateSize, config.hiddenSize], `layers.${index}.feed_forward.w3.weight`, ["f32", "q8_0"]);
  }
}

function requireTensor(tensors: Record<string, NativeTensor>, name: string): NativeTensor {
  const tensor = tensors[name];
  if (!tensor) {
    throw new Error(`tensor_missing:${name}`);
  }
  return tensor;
}

function embeddingLookup(tensor: NativeTensor, tokenId: number): Float32Array {
  if (tensor.shape.length !== 2) {
    throw new Error("token_embedding_rank_mismatch");
  }
  const [rows, cols] = tensor.shape;
  if (tokenId < 0 || tokenId >= rows) {
    throw new Error(`token_out_of_range:${tokenId}`);
  }
  return materializeRow(tensor, tokenId);
}

function applyRotaryEmbedding(
  vector: Float32Array,
  offset: number,
  position: number,
  theta: number,
  ropeDimension: number,
  headDim: number,
): void {
  const limit = Math.min(ropeDimension, headDim);
  for (let index = 0; index + 1 < limit; index += 2) {
    const exponent = index / Math.max(1, limit);
    const frequency = 1 / Math.pow(theta, exponent);
    const angle = position * frequency;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const left = vector[offset + index];
    const right = vector[offset + index + 1];
    vector[offset + index] = left * cos - right * sin;
    vector[offset + index + 1] = left * sin + right * cos;
  }
}
