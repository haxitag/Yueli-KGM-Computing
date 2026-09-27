import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeRuntimeEngine } from "../native/engine.js";
import { createCanonicalCheckpointForNativeCore } from "../native/checkpoint.js";
import { buildCanonicalCheckpointFromHfDecoder } from "../native/conversion/index.js";
import { loadNativeModel, type LoadedNativeModel } from "../native/loaders.js";
import type { NativeCheckpoint } from "../native/types.js";
import { withNativeCoreAddonShim } from "./native_core_smoke_support.js";

type SafetensorsTensor = {
  dtype: "F32";
  shape: number[];
  data: number[];
};

/** Phase 2.2：HF `config.json` → canonical IR 与 reference 可执行体 `NativeCheckpoint.config` 一致。 */
function assertHfDecoderCanonicalMatchesExecutable(
  loaded: LoadedNativeModel,
  executableCheckpoint: NativeCheckpoint,
): void {
  const decoderConfig = loaded.metadata.config;
  assert.ok(decoderConfig && typeof decoderConfig === "object");
  const tensorNames = loaded.metadata.tensors?.map((t) => t.name) ?? [];
  const fromHf = buildCanonicalCheckpointFromHfDecoder({
    decoderConfig: decoderConfig as Record<string, unknown>,
    rope: loaded.metadata.rope,
    tensorNames,
    source: "smoke-native-safetensors",
  });
  assert.ok(fromHf);
  assert.deepEqual(fromHf!.config, executableCheckpoint.config);
}

async function main(): Promise<void> {
  const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), "kgm-native-safetensors-"));
  const shardedDir = fs.mkdtempSync(path.join(os.tmpdir(), "kgm-native-safetensors-sharded-"));
  try {
    writeSyntheticModel(singleDir);
    writeSyntheticModel(shardedDir, { sharded: true });

    const single = await runScenario(singleDir);
    const sharded = await runScenario(shardedDir);
    const concurrent = await runConcurrentScenario(singleDir);
    const cacheBudget = await runCacheBudgetScenario(singleDir);

    console.log(JSON.stringify({
      single,
      sharded,
      concurrent,
      cacheBudget,
    }, null, 2));
  } finally {
    fs.rmSync(singleDir, { recursive: true, force: true });
    fs.rmSync(shardedDir, { recursive: true, force: true });
  }
}

async function runScenario(modelDir: string): Promise<Record<string, unknown>> {
  const loaded = loadNativeModel(modelDir);
  assert.equal(loaded.format, "safetensors");
  assert.equal(loaded.metadata.executable, true);
  assert.equal(loaded.executionBackend, "reference");
  assert.equal(loaded.manifest.executable, true);
  assert.ok(loaded.tokenizer);
  assert.ok(loaded.executableModel);
  const canonicalCheckpoint = createCanonicalCheckpointForNativeCore(loaded);
  assert.ok(canonicalCheckpoint);
  assertHfDecoderCanonicalMatchesExecutable(loaded, canonicalCheckpoint);
  assert.equal(canonicalCheckpoint?.tokenizer.kind, "hf-bpe");
  assert.equal(canonicalCheckpoint?.tensors["model.embed_tokens.weight"], undefined);
  assert.equal(canonicalCheckpoint?.tensors["token_embedding.weight"]?.dtype, "f32");

  const engine = new NativeRuntimeEngine(modelDir, { seed: 1 });
  const streamed: string[] = [];
  for await (const event of engine.streamComplete("", {
    model: "synthetic-safetensors",
    maxTokens: 2,
    temperature: 0,
  })) {
    if (event.type === "token") {
      streamed.push(event.text);
    }
    if (event.type === "finished") {
      assert.equal(event.result.text, "ok");
    }
  }

  const completed = await engine.complete("", {
    model: "synthetic-safetensors",
    maxTokens: 2,
    temperature: 0,
  });

  const sessionWarm = await engine.complete("ok", {
    model: "synthetic-safetensors",
    sessionId: "demo-session",
    maxTokens: 1,
    temperature: 0,
  });
  const sessionResume = await engine.complete("okok", {
    model: "synthetic-safetensors",
    sessionId: "demo-session",
    maxTokens: 1,
    temperature: 0,
  });
  const sessionResumeRaw = (sessionResume.raw as {
    nativeRuntime?: {
      cacheSource?: string;
      prefillTokens?: number;
    };
  }).nativeRuntime;

  assert.equal(streamed.join(""), "ok");
  assert.equal(completed.text, "ok");
  assert.equal((sessionWarm.raw as { nativeRuntime?: { cacheSource?: string } }).nativeRuntime?.cacheSource, "cold");
  assert.equal(sessionResumeRaw?.cacheSource, "session-prefix");
  assert.equal(sessionResumeRaw?.prefillTokens, 1);
  const nativeCore = await withNativeCoreAddonShim(async () => {
    const nativeCoreEngine = new NativeRuntimeEngine(modelDir, {
      servingBackend: "native-core",
      seed: 1,
    });
    const result = await nativeCoreEngine.complete("", {
      model: "synthetic-safetensors-native-core",
      requestId: "synthetic-safetensors-native-core",
      sessionId: "synthetic-safetensors-native-core",
      maxTokens: 2,
      temperature: 0,
    });
    const nativeRuntime = (result.raw as {
      nativeRuntime?: {
        scheduler?: { servingBackend?: string };
      };
    }).nativeRuntime;
    assert.equal(result.text, "ok");
    assert.equal(nativeCoreEngine.servingBackend(), "native-core");
    assert.equal(nativeRuntime?.scheduler?.servingBackend, "native-core");
    return {
      servingBackend: nativeCoreEngine.servingBackend(),
      result: result.text,
      raw: nativeRuntime,
    };
  });

  return {
    modelDir,
    metadataPath: loaded.metadata.path,
    executionBackend: loaded.executionBackend,
    nativeCoreTokenizerKind: canonicalCheckpoint?.tokenizer.kind,
    manifest: loaded.manifest.canonical,
    files: loaded.manifest.files.map((file) => path.basename(file.path)),
    result: completed.text,
    sessionResume: sessionResumeRaw,
    nativeCore,
  };
}

async function runConcurrentScenario(modelDir: string): Promise<Record<string, unknown>> {
  const engine = new NativeRuntimeEngine(modelDir, {
    seed: 1,
    schedulerMaxBatchSize: 2,
    schedulerMaxPrefillsPerTick: 2,
    kvCacheMode: "paged",
    kvPageSize: 2,
  });

  const [first, second] = await Promise.all([
    engine.complete("", {
      model: "synthetic-safetensors",
      requestId: "req-a",
      sessionId: "concurrent-a",
      maxTokens: 2,
      temperature: 0,
    }),
    engine.complete("", {
      model: "synthetic-safetensors",
      requestId: "req-b",
      sessionId: "concurrent-b",
      maxTokens: 2,
      temperature: 0,
    }),
  ]);

  const firstRaw = (first.raw as {
    nativeRuntime?: {
      scheduler?: { peakActiveRequests?: number; maxBatchSize?: number; servingBackend?: string };
      memory?: { kvAllocatedPages?: number; kvResidentBytes?: number };
    };
  }).nativeRuntime;
  const secondRaw = (second.raw as {
    nativeRuntime?: {
      scheduler?: { peakActiveRequests?: number; maxBatchSize?: number; servingBackend?: string };
      memory?: { kvAllocatedPages?: number; kvResidentBytes?: number };
    };
  }).nativeRuntime;

  assert.equal(first.text, "ok");
  assert.equal(second.text, "ok");
  assert.equal(firstRaw?.scheduler?.maxBatchSize, 2);
  assert.equal(secondRaw?.scheduler?.maxBatchSize, 2);
  assert.equal(firstRaw?.scheduler?.servingBackend, "js-reference");
  assert.equal(secondRaw?.scheduler?.servingBackend, "js-reference");
  assert.ok((firstRaw?.scheduler?.peakActiveRequests ?? 0) >= 2);
  assert.ok((secondRaw?.scheduler?.peakActiveRequests ?? 0) >= 2);
  assert.ok((firstRaw?.memory?.kvAllocatedPages ?? 0) >= 1);
  assert.ok((secondRaw?.memory?.kvAllocatedPages ?? 0) >= 1);

  return {
    first: firstRaw,
    second: secondRaw,
    engine: engine.schedulerMetrics(),
  };
}

async function runCacheBudgetScenario(modelDir: string): Promise<Record<string, unknown>> {
  const engine = new NativeRuntimeEngine(modelDir, {
    seed: 1,
    kvCacheMode: "paged",
    kvPageSize: 2,
    cachedKvPageBudget: 1,
  });

  await engine.complete("", {
    model: "synthetic-safetensors",
    sessionId: "budget-a",
    maxTokens: 2,
    temperature: 0,
  });
  await engine.complete("ok", {
    model: "synthetic-safetensors",
    sessionId: "budget-b",
    maxTokens: 1,
    temperature: 0,
  });
  const finalResult = await engine.complete("okok", {
    model: "synthetic-safetensors",
    sessionId: "budget-c",
    maxTokens: 1,
    temperature: 0,
  });
  const raw = (finalResult.raw as {
    nativeRuntime?: {
      memory?: { cachedKvResidentPages?: number; cachedKvPageBudget?: number };
      scheduler?: { servingBackend?: string };
      generatedTokens?: number;
    };
  }).nativeRuntime;

  assert.equal(raw?.scheduler?.servingBackend, "js-reference");
  assert.equal(raw?.memory?.cachedKvPageBudget, 1);
  assert.ok((raw?.memory?.cachedKvResidentPages ?? 0) <= 1);
  assert.ok((raw?.generatedTokens ?? 0) >= 0);

  return raw ?? {};
}

function writeSyntheticModel(modelDir: string, options?: { sharded?: boolean }): void {
  fs.writeFileSync(path.join(modelDir, "config.json"), JSON.stringify({
    model_type: "qwen2",
    architectures: ["Qwen2ForCausalLM"],
    vocab_size: 6,
    hidden_size: 2,
    intermediate_size: 2,
    num_hidden_layers: 1,
    num_attention_heads: 1,
    num_key_value_heads: 1,
    max_position_embeddings: 16,
    rms_norm_eps: 1e-5,
    rope_theta: 10000,
    bos_token_id: 0,
    eos_token_id: 1,
    pad_token_id: 1,
  }, null, 2));

  fs.writeFileSync(path.join(modelDir, "tokenizer_config.json"), JSON.stringify({
    bos_token: "<|bos|>",
    eos_token: "<|eos|>",
    pad_token: "<|eos|>",
    unk_token: "<|unk|>",
    chat_template: "{{ messages }}",
  }, null, 2));

  fs.writeFileSync(path.join(modelDir, "tokenizer.json"), JSON.stringify({
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: [
      { id: 0, content: "<|bos|>", special: true },
      { id: 1, content: "<|eos|>", special: true },
    ],
    normalizer: null,
    pre_tokenizer: { type: "ByteLevel", add_prefix_space: false },
    post_processor: null,
    decoder: { type: "ByteLevel", cleanup: false },
    model: {
      type: "BPE",
      dropout: null,
      unk_token: "<|unk|>",
      continuing_subword_prefix: "",
      end_of_word_suffix: "",
      fuse_unk: false,
      byte_fallback: false,
      vocab: {
        o: 2,
        k: 3,
        ok: 4,
        "<|unk|>": 5,
      },
      merges: ["o k"],
    },
  }, null, 2));

  const tensors: Record<string, SafetensorsTensor> = {
    "model.embed_tokens.weight": {
      dtype: "F32",
      shape: [6, 2],
      data: [
        1, 0,
        0, 0,
        0, 0,
        0, 0,
        0, 1,
        -1, 0,
      ],
    },
    "model.norm.weight": {
      dtype: "F32",
      shape: [2],
      data: [1, 1],
    },
    "model.layers.0.input_layernorm.weight": {
      dtype: "F32",
      shape: [2],
      data: [1, 1],
    },
    "model.layers.0.post_attention_layernorm.weight": {
      dtype: "F32",
      shape: [2],
      data: [1, 1],
    },
    "model.layers.0.self_attn.q_proj.weight": {
      dtype: "F32",
      shape: [2, 2],
      data: [0, 0, 0, 0],
    },
    "model.layers.0.self_attn.k_proj.weight": {
      dtype: "F32",
      shape: [2, 2],
      data: [0, 0, 0, 0],
    },
    "model.layers.0.self_attn.v_proj.weight": {
      dtype: "F32",
      shape: [2, 2],
      data: [0, 0, 0, 0],
    },
    "model.layers.0.self_attn.o_proj.weight": {
      dtype: "F32",
      shape: [2, 2],
      data: [0, 0, 0, 0],
    },
    "model.layers.0.mlp.gate_proj.weight": {
      dtype: "F32",
      shape: [2, 2],
      data: [0, 0, 0, 0],
    },
    "model.layers.0.mlp.down_proj.weight": {
      dtype: "F32",
      shape: [2, 2],
      data: [0, 0, 0, 0],
    },
    "model.layers.0.mlp.up_proj.weight": {
      dtype: "F32",
      shape: [2, 2],
      data: [0, 0, 0, 0],
    },
    "lm_head.weight": {
      dtype: "F32",
      shape: [6, 2],
      data: [
        0, 0,
        0.5, 2,
        0, 0,
        0, 0,
        2, 0,
        -1, -1,
      ],
    },
  };

  if (options?.sharded) {
    writeSafetensorsFile(path.join(modelDir, "model-00001-of-00002.safetensors"), {
      "model.embed_tokens.weight": tensors["model.embed_tokens.weight"]!,
      "model.norm.weight": tensors["model.norm.weight"]!,
      "model.layers.0.input_layernorm.weight": tensors["model.layers.0.input_layernorm.weight"]!,
      "model.layers.0.post_attention_layernorm.weight": tensors["model.layers.0.post_attention_layernorm.weight"]!,
      "model.layers.0.self_attn.q_proj.weight": tensors["model.layers.0.self_attn.q_proj.weight"]!,
      "model.layers.0.self_attn.k_proj.weight": tensors["model.layers.0.self_attn.k_proj.weight"]!,
      "model.layers.0.self_attn.v_proj.weight": tensors["model.layers.0.self_attn.v_proj.weight"]!,
      "model.layers.0.self_attn.o_proj.weight": tensors["model.layers.0.self_attn.o_proj.weight"]!,
      "model.layers.0.mlp.gate_proj.weight": tensors["model.layers.0.mlp.gate_proj.weight"]!,
      "model.layers.0.mlp.down_proj.weight": tensors["model.layers.0.mlp.down_proj.weight"]!,
      "model.layers.0.mlp.up_proj.weight": tensors["model.layers.0.mlp.up_proj.weight"]!,
    });
    writeSafetensorsFile(path.join(modelDir, "model-00002-of-00002.safetensors"), {
      "lm_head.weight": tensors["lm_head.weight"]!,
    });
    fs.writeFileSync(path.join(modelDir, "model.safetensors.index.json"), JSON.stringify({
      metadata: {
        total_size: Object.values(tensors).reduce((sum, tensor) => sum + tensor.data.length * 4, 0),
      },
      weight_map: {
        "model.embed_tokens.weight": "model-00001-of-00002.safetensors",
        "model.norm.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.input_layernorm.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.post_attention_layernorm.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.self_attn.q_proj.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.self_attn.k_proj.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.self_attn.v_proj.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.self_attn.o_proj.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.mlp.gate_proj.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.mlp.down_proj.weight": "model-00001-of-00002.safetensors",
        "model.layers.0.mlp.up_proj.weight": "model-00001-of-00002.safetensors",
        "lm_head.weight": "model-00002-of-00002.safetensors",
      },
    }, null, 2));
    return;
  }

  writeSafetensorsFile(path.join(modelDir, "model.safetensors"), tensors);
}

function writeSafetensorsFile(filePath: string, tensors: Record<string, SafetensorsTensor>): void {
  let offset = 0;
  const dataBuffers: Buffer[] = [];
  const header: Record<string, unknown> = {
    __metadata__: {
      format: "pt",
    },
  };

  for (const [name, tensor] of Object.entries(tensors)) {
    const dataBuffer = Buffer.alloc(tensor.data.length * 4);
    for (let index = 0; index < tensor.data.length; index += 1) {
      dataBuffer.writeFloatLE(tensor.data[index] ?? 0, index * 4);
    }
    dataBuffers.push(dataBuffer);
    header[name] = {
      dtype: tensor.dtype,
      shape: tensor.shape,
      data_offsets: [offset, offset + dataBuffer.length],
    };
    offset += dataBuffer.length;
  }

  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(headerBuffer.length), 0);
  fs.writeFileSync(filePath, Buffer.concat([prefix, headerBuffer, ...dataBuffers]));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
