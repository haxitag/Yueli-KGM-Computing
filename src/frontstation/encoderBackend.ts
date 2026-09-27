/**
 * Encoder 轨：MiniLM / ONNX 本地推理（与 decoder-only Native GPU 分轨）。
 * 惰性动态加载 `@huggingface/transformers`；失败则返回 null，由 factory 回退。
 */
import { INTENT_PROTOTYPE_TEXTS } from "./intentPrototypes.js";
import type { FrontStationIntentLabel } from "./types.js";

export type EncoderEmbedBackend = {
  readonly kind: "onnx_minilm";
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dispose?(): Promise<void>;
};

type FeaturePipeline = (
  input: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] } | { tolist: () => number[][] }>;

let loading: Promise<EncoderEmbedBackend | null> | undefined;
let cached: EncoderEmbedBackend | null | undefined;

function toVector(output: unknown, index = 0): Float32Array {
  if (output && typeof output === "object" && "tolist" in output && typeof (output as { tolist: () => unknown }).tolist === "function") {
    const list = (output as { tolist: () => number[] | number[][] }).tolist();
    const row = Array.isArray(list[0]) ? (list as number[][])[index]! : (list as number[]);
    return Float32Array.from(row);
  }
  const tensor = output as { data?: Float32Array | number[]; dims?: number[] };
  if (tensor?.data && tensor.dims && tensor.dims.length >= 2) {
    const dim = tensor.dims[tensor.dims.length - 1]!;
    const start = index * dim;
    const slice = Array.from(tensor.data).slice(start, start + dim);
    return Float32Array.from(slice);
  }
  if (tensor?.data) {
    return Float32Array.from(tensor.data);
  }
  throw new Error("frontstation_onnx_bad_output");
}

export async function tryCreateOnnxEmbedBackend(params: {
  modelId: string;
  dtype?: string;
  device?: string;
}): Promise<EncoderEmbedBackend | null> {
  if (cached !== undefined) {
    return cached;
  }
  if (!loading) {
    loading = (async () => {
      try {
        const mod = await import("@huggingface/transformers");
        const pipeline = (mod as { pipeline: (...args: unknown[]) => Promise<FeaturePipeline> }).pipeline;
        const opts: Record<string, unknown> = {};
        if (params.dtype) opts.dtype = params.dtype;
        if (params.device) opts.device = params.device;
        const extractor = await pipeline("feature-extraction", params.modelId, opts);
        const backend: EncoderEmbedBackend = {
          kind: "onnx_minilm",
          async embed(text: string) {
            const out = await extractor(text, { pooling: "mean", normalize: true });
            return toVector(out, 0);
          },
          async embedBatch(texts: string[]) {
            if (texts.length === 0) return [];
            const out = await extractor(texts, { pooling: "mean", normalize: true });
            return texts.map((_, i) => toVector(out, i));
          },
        };
        cached = backend;
        return backend;
      } catch {
        cached = null;
        return null;
      }
    })();
  }
  return loading;
}

/** 测试钩子：注入/清空后端 */
export function setOnnxEmbedBackendForTests(backend: EncoderEmbedBackend | null | undefined): void {
  cached = backend;
  loading = backend === undefined ? undefined : Promise.resolve(backend);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export async function embedIntentPrototypes(
  backend: EncoderEmbedBackend,
): Promise<Map<FrontStationIntentLabel, Float32Array>> {
  const labels = Object.keys(INTENT_PROTOTYPE_TEXTS) as FrontStationIntentLabel[];
  const texts = labels.map((l) => INTENT_PROTOTYPE_TEXTS[l].join(" \n "));
  const vecs = await backend.embedBatch(texts);
  const map = new Map<FrontStationIntentLabel, Float32Array>();
  labels.forEach((label, i) => map.set(label, vecs[i]!));
  return map;
}
