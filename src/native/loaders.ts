import fs from "node:fs";
import path from "node:path";

import { hfDecoderConfigToNativeModelConfig } from "./conversion/hfDecoderConfig.js";
import { analyzeGgufDescriptorLayoutIssues, mapGgufDtypeLabel } from "./gguf_layout.js";
import { detectJangInModelDirectory } from "./jang.js";
import { createNativeModelManifest, readModelSidecars } from "./manifest.js";
import { createTokenizer, createTokenizerFromHfTokenizerJson, type NativeTokenizer } from "./tokenizer.js";
import { loadTensor, type NativeTensor } from "./tensor.js";
import { NativeTransformerModel } from "./transformer.js";
import type {
  NativeBackendKind,
  NativeCheckpoint,
  NativeModelArtifactFile,
  NativeModelMetadata,
  NativeModelManifest,
  NativeRuntimeFormat,
} from "./types.js";

export type LoadedNativeModel = {
  format: NativeRuntimeFormat;
  metadata: NativeModelMetadata;
  manifest: NativeModelManifest;
  executionBackend?: NativeBackendKind;
  tokenizer?: NativeTokenizer;
  executableModel?: NativeTransformerModel;
};

export type LoadNativeModelOptions = {
  modelRef?: string;
};

type ExecutableModelAttempt = {
  model?: NativeTransformerModel;
  reason?: string;
};

type ParsedSafetensorsTensorEntry = {
  filePath: string;
  dtype?: string;
  shape?: number[];
  dataOffsets?: [number, number];
};

type ParsedSafetensorsDescriptor = {
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  tokenizerConfig?: Record<string, unknown>;
  generationConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
  rope?: Record<string, unknown>;
  chatTemplate?: string;
  files: NativeModelArtifactFile[];
  tensors: Array<{ name: string; shape?: number[]; dtype?: string }>;
  tensorEntries: Record<string, ParsedSafetensorsTensorEntry>;
};

type ParsedGgufTensorEntry = {
  filePath: string;
  ggmlShape: number[];
  shape: number[];
  dtypeCode: number;
  dataOffset: number;
};

type ParsedGgufDescriptor = {
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  rope?: Record<string, unknown>;
  chatTemplate?: string;
  files: NativeModelArtifactFile[];
  tensors: Array<{ name: string; shape?: number[]; dtype?: string }>;
  tensorEntries: Record<string, ParsedGgufTensorEntry>;
  metadata: Record<string, unknown>;
};

type DetectedLocalModelLayout = {
  format: "transformers" | "pytorch" | "tensorflow";
  files: NativeModelArtifactFile[];
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  tokenizerConfig?: Record<string, unknown>;
  generationConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
  chatTemplate?: string;
  notes: string[];
};

type OllamaManifestLayer = {
  mediaType?: string;
  digest?: string;
  size?: number;
};

type OllamaManifest = {
  schemaVersion?: number;
  mediaType?: string;
  config?: OllamaManifestLayer;
  layers?: OllamaManifestLayer[];
};

type ResolvedOllamaModel = {
  storeRoot: string;
  requestedPath: string;
  manifestPath: string;
  modelRef?: string;
  manifest: OllamaManifest;
  modelLayer: OllamaManifestLayer;
  configLayer?: OllamaManifestLayer;
  formatHint?: string;
};

export function loadNativeModel(modelPath: string, options?: LoadNativeModelOptions): LoadedNativeModel {
  const resolved = path.resolve(modelPath);
  const ollamaResolved = resolveOllamaModel(resolved, options);
  if (ollamaResolved) {
    return loadFromOllamaModel(ollamaResolved);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return loadFromDirectory(resolved);
  }
  return loadFromFile(resolved);
}

function loadFromDirectory(modelDir: string): LoadedNativeModel {
  const checkpointFile = findFirstExisting(modelDir, ["model.kgm.json", "kgm-model.json", "checkpoint.kgm.json"]);
  if (checkpointFile) {
    return loadJsonCheckpoint(checkpointFile);
  }
  const ggufFile = firstFileByExtension(modelDir, ".gguf");
  if (ggufFile) {
    return loadGgufMetadata(ggufFile);
  }
  const safetensorsIndexFile = firstFileBySuffix(modelDir, ".safetensors.index.json");
  if (safetensorsIndexFile) {
    return loadSafetensorsMetadataFromIndex(safetensorsIndexFile);
  }
  const safetensorsFile = firstFileByExtension(modelDir, ".safetensors");
  if (safetensorsFile) {
    return loadSafetensorsMetadata(safetensorsFile);
  }
  const onnxFile = firstFileByExtension(modelDir, ".onnx");
  if (onnxFile) {
    return loadOnnxMetadata(onnxFile);
  }
  const detectedLayout = detectLocalModelLayout(modelDir);
  if (detectedLayout) {
    return loadDetectedLocalModelLayout(modelDir, detectedLayout);
  }
  throw new Error(`native_model_checkpoint_not_found:${modelDir}`);
}

function loadFromFile(filePath: string): LoadedNativeModel {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".kgm.json") || lower.endsWith("model.json")) {
    return loadJsonCheckpoint(filePath);
  }
  if (lower.endsWith(".safetensors.index.json")) {
    return loadSafetensorsMetadataFromIndex(filePath);
  }
  if (lower.endsWith(".gguf")) {
    return loadGgufMetadata(filePath);
  }
  if (lower.endsWith(".safetensors")) {
    return loadSafetensorsMetadata(filePath);
  }
  if (lower.endsWith(".onnx")) {
    return loadOnnxMetadata(filePath);
  }
  if (isPyTorchFile(filePath)) {
    return loadPyTorchMetadata(filePath);
  }
  if (isTensorFlowFile(filePath)) {
    return loadTensorFlowMetadata(filePath);
  }
  if (path.basename(filePath) === "config.json" || path.basename(filePath) === "tokenizer.json") {
    const detectedLayout = detectLocalModelLayout(path.dirname(filePath));
    if (detectedLayout) {
      return loadDetectedLocalModelLayout(path.dirname(filePath), detectedLayout);
    }
  }
  throw new Error(`Yueli KGM Runtime model format unsupported:${filePath}`);
}

function loadFromOllamaModel(resolved: ResolvedOllamaModel): LoadedNativeModel {
  const blobPath = digestToBlobPath(resolved.storeRoot, resolved.modelLayer.digest);
  const format = detectOllamaBlobFormat(blobPath, resolved.formatHint);
  const loaded = loadFromDetectedFormat(blobPath, format);
  const manifestFiles = buildOllamaManifestFiles(resolved);
  const notes = [
    `Resolved from Ollama model store: ${resolved.requestedPath}`,
    `Ollama manifest: ${resolved.manifestPath}`,
    ...(resolved.modelRef ? [`Ollama model ref: ${resolved.modelRef}`] : []),
    ...loaded.metadata.notes,
  ];
  const metadata: NativeModelMetadata = {
    ...loaded.metadata,
    notes,
  };
  const manifest: NativeModelManifest = {
    ...loaded.manifest,
    metadata,
    files: [...manifestFiles, ...loaded.manifest.files],
  };
  return {
    ...loaded,
    metadata,
    manifest,
  };
}

function loadJsonCheckpoint(filePath: string): LoadedNativeModel {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as NativeCheckpoint;
  if (raw.format !== "kgm-transformer-checkpoint") {
    throw new Error(`Yueli KGM Runtime invalid checkpoint format:${filePath}`);
  }
  const tensors: Record<string, NativeTensor> = {};
  for (const [name, tensor] of Object.entries(raw.tensors)) {
    tensors[name] = loadTensor(tensor, name);
  }
  const executableModel = new NativeTransformerModel(raw, tensors);
  const tokenizer = createTokenizer(raw.tokenizer);
  const metadata: NativeModelMetadata = {
    format: "kgm-json",
    path: filePath,
    executable: true,
    config: raw.config as unknown as Record<string, unknown>,
    tokenizer: raw.tokenizer as unknown as Record<string, unknown>,
    rope: {
      theta: raw.config.ropeTheta ?? 10000,
      dimension: raw.config.ropeDimension ?? executableModel.headDim,
    },
    chatTemplate: raw.tokenizer.chatTemplate ?? raw.config.chatTemplate,
    notes: ["Loaded executable KGM JSON checkpoint."],
    tensors: Object.entries(raw.tensors).map(([name, tensor]) => ({
      name,
      shape: tensor.shape,
      dtype: tensor.dtype ?? "f32",
    })),
  };
  const manifest = createNativeModelManifest({
    format: "kgm-json",
    path: filePath,
    executable: true,
    metadata,
    files: [
      createFileRecord(filePath, "checkpoint", "kgm-json", true),
    ],
    config: raw.config as unknown as Record<string, unknown>,
    tokenizer: raw.tokenizer as unknown as Record<string, unknown>,
    rope: metadata.rope,
    chatTemplate: metadata.chatTemplate,
    tensors: metadata.tensors,
  });
  return {
    format: "kgm-json",
    metadata,
    manifest,
    executionBackend: "reference",
    tokenizer,
    executableModel,
  };
}

function loadGgufMetadata(filePath: string): LoadedNativeModel {
  const descriptor = parseGgufMetadata(filePath);
  const sidecars = readModelSidecars(path.dirname(filePath));
  const tokenizer = buildTokenizerFromSidecars(sidecars) ?? buildTokenizerFromGgufMetadata(descriptor);
  const executableAttempt = tokenizer
    ? tryCreateExecutableGgufModel(descriptor)
    : { reason: "No compatible tokenizer metadata or tokenizer sidecar was found for this GGUF." } satisfies ExecutableModelAttempt;
  const executableModel = executableAttempt.model;
  const executable = Boolean(tokenizer && executableModel);
  const notes = [
    "GGUF metadata parsed successfully.",
  ];
  if (executable) {
    notes.push("Executable GGUF tensors loaded into the CPU reference backend.");
  } else if (executableAttempt.reason) {
    notes.push(executableAttempt.reason);
  } else {
    notes.push("Executable GGUF tensor loading is not implemented for this model layout or tokenizer in the CPU reference backend yet.");
  }
  const metadata: NativeModelMetadata = {
    format: "gguf",
    path: filePath,
    executable,
    config: descriptor.config,
    tokenizer: descriptor.tokenizer,
    rope: descriptor.rope,
    chatTemplate: descriptor.chatTemplate,
    notes,
    tensors: descriptor.tensors,
  };
  const manifest = createNativeModelManifest({
    format: "gguf",
    path: filePath,
    executable,
    metadata,
    files: descriptor.files,
    config: descriptor.config,
    tokenizer: descriptor.tokenizer,
    rope: descriptor.rope,
    chatTemplate: descriptor.chatTemplate,
    tensors: descriptor.tensors,
  });
  return {
    format: "gguf",
    metadata,
    manifest,
    executionBackend: executable ? "reference" : undefined,
    tokenizer,
    executableModel,
  };
}

function loadSafetensorsMetadata(filePath: string): LoadedNativeModel {
  const modelDir = path.dirname(filePath);
  const jang = detectJangInModelDirectory(modelDir);
  const descriptor = parseSafetensorsMetadata(filePath);
  const tokenizer = buildTokenizerFromSidecars({
    tokenizer: descriptor.tokenizer,
    tokenizerConfig: descriptor.tokenizerConfig,
    specialTokensMap: descriptor.specialTokensMap,
    chatTemplate: descriptor.chatTemplate,
  });
  let executableModel = tokenizer ? tryCreateExecutableSafetensorsModel(descriptor) : undefined;
  if (jang) {
    executableModel = undefined;
  }
  const executable = Boolean(tokenizer && executableModel && !jang);
  const notes = [
    "Safetensors header parsed successfully.",
  ];
  if (jang) {
    notes.push(jang.summary);
    notes.push(
      "JANG mixed-precision weights are not executed on the CPU reference backend; use an MLX runtime worker (planned) or external MLX-compatible serving.",
    );
  }
  if (executable) {
    notes.push("Executable safetensors tensors loaded into the CPU reference backend.");
  } else if (!jang) {
    notes.push("Executable safetensors weight loading is not implemented for this model layout in the CPU reference backend yet.");
  }
  const jangExtraFiles: NativeModelArtifactFile[] =
    jang?.configPath && fs.existsSync(jang.configPath) && jang.configPath.endsWith("jang_config.json")
      ? [createFileRecord(jang.configPath, "config", "jang-config", true)]
      : [];
  const metadata: NativeModelMetadata = {
    format: "safetensors",
    path: filePath,
    executable,
    config: descriptor.config,
    tokenizer: descriptor.tokenizer,
    rope: descriptor.rope,
    chatTemplate: descriptor.chatTemplate,
    notes,
    tensors: descriptor.tensors,
    jang,
  };
  const manifest = createNativeModelManifest({
    format: "safetensors",
    path: filePath,
    executable,
    metadata,
    files: [
      createFileRecord(filePath, "weights", "safetensors", true),
      ...jangExtraFiles,
      ...descriptor.files,
    ],
    config: descriptor.config,
    tokenizer: descriptor.tokenizer,
    rope: descriptor.rope,
    chatTemplate: descriptor.chatTemplate,
    tensors: descriptor.tensors,
  });
  return {
    format: "safetensors",
    metadata,
    manifest,
    executionBackend: executable ? "reference" : undefined,
    tokenizer,
    executableModel,
  };
}

function loadSafetensorsMetadataFromIndex(indexPath: string): LoadedNativeModel {
  const modelDir = path.dirname(indexPath);
  const jang = detectJangInModelDirectory(modelDir);
  const descriptor = parseShardedSafetensorsMetadata(indexPath);
  const tokenizer = buildTokenizerFromSidecars({
    tokenizer: descriptor.tokenizer,
    tokenizerConfig: descriptor.tokenizerConfig,
    specialTokensMap: descriptor.specialTokensMap,
    chatTemplate: descriptor.chatTemplate,
  });
  let executableModel = tokenizer ? tryCreateExecutableSafetensorsModel(descriptor) : undefined;
  if (jang) {
    executableModel = undefined;
  }
  const executable = Boolean(tokenizer && executableModel && !jang);
  const notes = [
    "Sharded safetensors index parsed successfully.",
  ];
  if (jang) {
    notes.push(jang.summary);
    notes.push(
      "JANG mixed-precision weights are not executed on the CPU reference backend; use an MLX runtime worker (planned) or external MLX-compatible serving.",
    );
  }
  if (executable) {
    notes.push("Executable sharded safetensors tensors loaded into the CPU reference backend.");
  } else if (!jang) {
    notes.push("Executable sharded safetensors weight loading is not implemented for this model layout in the CPU reference backend yet.");
  }
  const jangExtraFiles: NativeModelArtifactFile[] =
    jang?.configPath && fs.existsSync(jang.configPath) && jang.configPath.endsWith("jang_config.json")
      ? [createFileRecord(jang.configPath, "config", "jang-config", true)]
      : [];
  const metadata: NativeModelMetadata = {
    format: "safetensors",
    path: indexPath,
    executable,
    config: descriptor.config,
    tokenizer: descriptor.tokenizer,
    rope: descriptor.rope,
    chatTemplate: descriptor.chatTemplate,
    notes,
    tensors: descriptor.tensors,
    jang,
  };
  const manifest = createNativeModelManifest({
    format: "safetensors",
    path: indexPath,
    executable,
    metadata,
    files: dedupeJangFiles(descriptor.files, jangExtraFiles),
    config: descriptor.config,
    tokenizer: descriptor.tokenizer,
    rope: descriptor.rope,
    chatTemplate: descriptor.chatTemplate,
    tensors: descriptor.tensors,
  });
  return {
    format: "safetensors",
    metadata,
    manifest,
    executionBackend: executable ? "reference" : undefined,
    tokenizer,
    executableModel,
  };
}

function dedupeJangFiles(
  base: NativeModelArtifactFile[],
  extra: NativeModelArtifactFile[],
): NativeModelArtifactFile[] {
  const paths = new Set(base.map((f) => path.resolve(f.path)));
  const merged = [...base];
  for (const file of extra) {
    const resolved = path.resolve(file.path);
    if (!paths.has(resolved)) {
      paths.add(resolved);
      merged.push(file);
    }
  }
  return merged;
}

function loadOnnxMetadata(filePath: string): LoadedNativeModel {
  const stat = fs.statSync(filePath);
  const metadata: NativeModelMetadata = {
    format: "onnx",
    path: filePath,
    executable: false,
    notes: [
      `ONNX graph detected (${stat.size} bytes).`,
      "Executable ONNX graph evaluation is not implemented in the CPU reference backend yet.",
    ],
  };
  const sidecars = readModelSidecars(path.dirname(filePath));
  const tokenizer = buildTokenizerFromSidecars(sidecars);
  const manifest = createNativeModelManifest({
    format: "onnx",
    path: filePath,
    executable: false,
    metadata,
    files: [
      createFileRecord(filePath, "onnx_graph", "onnx", true),
      ...sidecars.files,
    ],
    config: sidecars.config,
    tokenizer: sidecars.tokenizer,
    chatTemplate: sidecars.chatTemplate,
  });
  return {
    format: "onnx",
    metadata,
    manifest,
    tokenizer,
  };
}

function loadDetectedLocalModelLayout(modelDir: string, layout: DetectedLocalModelLayout): LoadedNativeModel {
  const executable = false;
  const metadata: NativeModelMetadata = {
    format: layout.format,
    path: modelDir,
    executable,
    config: layout.config,
    tokenizer: layout.tokenizer,
    chatTemplate: layout.chatTemplate,
    notes: layout.notes,
  };
  const manifest = createNativeModelManifest({
    format: layout.format,
    path: modelDir,
    executable,
    metadata,
    files: layout.files,
    config: layout.config,
    tokenizer: layout.tokenizer,
    chatTemplate: layout.chatTemplate,
  });
  const tokenizer = buildTokenizerFromSidecars({
    tokenizer: layout.tokenizer,
    tokenizerConfig: layout.tokenizerConfig,
    specialTokensMap: layout.specialTokensMap,
    chatTemplate: layout.chatTemplate,
  });
  return {
    format: layout.format,
    metadata,
    manifest,
    tokenizer,
  };
}

function loadPyTorchMetadata(filePath: string): LoadedNativeModel {
  const modelDir = path.dirname(filePath);
  const sidecar = readDirectorySidecars(modelDir);
  if (path.basename(filePath).toLowerCase() === "pytorch_model.bin.index.json") {
    return loadDetectedLocalModelLayout(modelDir, loadPyTorchLayoutFromIndex(modelDir, filePath, sidecar));
  }
  return loadDetectedLocalModelLayout(modelDir, {
    format: "pytorch",
    files: [createFileRecord(filePath, "weights", "pytorch", true), ...sidecar.files],
    config: sidecar.config,
    tokenizer: sidecar.tokenizer,
    tokenizerConfig: sidecar.tokenizerConfig,
    generationConfig: sidecar.generationConfig,
    specialTokensMap: sidecar.specialTokensMap,
    chatTemplate: sidecar.chatTemplate,
    notes: [
      "PyTorch checkpoint detected.",
      "Raw PyTorch checkpoints are recognized for metadata inspection and runtime routing.",
      "Native execution for raw PyTorch checkpoints is not implemented; prefer vLLM or SGLang for serving.",
    ],
  });
}

function loadTensorFlowMetadata(filePath: string): LoadedNativeModel {
  const modelDir = path.dirname(filePath);
  const sidecar = readDirectorySidecars(modelDir);
  const files = [createFileRecord(filePath, inferTensorFlowFileKind(filePath), "tensorflow", true), ...sidecar.files];
  return loadDetectedLocalModelLayout(modelDir, {
    format: "tensorflow",
    files,
    config: sidecar.config,
    tokenizer: sidecar.tokenizer,
    tokenizerConfig: sidecar.tokenizerConfig,
    generationConfig: sidecar.generationConfig,
    specialTokensMap: sidecar.specialTokensMap,
    chatTemplate: sidecar.chatTemplate,
    notes: [
      "TensorFlow model artifact detected.",
      "TensorFlow checkpoints are recognized for metadata inspection and runtime routing.",
      "Native execution for TensorFlow checkpoints is not implemented; prefer conversion or an external runtime.",
    ],
  });
}

function detectLocalModelLayout(modelDir: string): DetectedLocalModelLayout | null {
  const sidecar = readDirectorySidecars(modelDir);
  const pytorchIndex = findFirstExisting(modelDir, ["pytorch_model.bin.index.json"]);
  const pytorchFiles = findMatchingFiles(modelDir, (entry) =>
    /^pytorch_model.*\.(bin|pt|pth)$/i.test(entry.name)
    || /^consolidated.*\.(pt|pth|bin)$/i.test(entry.name),
  );
  const tensorflowSavedModel = findFirstExisting(modelDir, ["saved_model.pb", "saved_model.pbtxt"]);
  const tensorflowFiles = findMatchingFiles(modelDir, (entry) =>
    /^tf_model.*\.h5$/i.test(entry.name)
    || /^model.*\.h5$/i.test(entry.name)
    || entry.name.endsWith(".ckpt.index")
    || entry.name.endsWith(".ckpt"),
  );

  if (pytorchIndex) {
    return loadPyTorchLayoutFromIndex(modelDir, pytorchIndex, sidecar);
  }
  if (pytorchFiles.length > 0) {
    return {
      format: "pytorch",
      files: [
        ...pytorchFiles.map((filePath) => createFileRecord(filePath, "weights", "pytorch", true)),
        ...sidecar.files,
      ],
      config: sidecar.config,
      tokenizer: sidecar.tokenizer,
      tokenizerConfig: sidecar.tokenizerConfig,
      generationConfig: sidecar.generationConfig,
      specialTokensMap: sidecar.specialTokensMap,
      chatTemplate: sidecar.chatTemplate,
      notes: [
        "Transformers-compatible PyTorch model directory detected.",
        "PyTorch weights were recognized from the local directory layout.",
        "Prefer vLLM or SGLang for execution; native execution for raw PyTorch weights is not implemented.",
      ],
    };
  }
  if (tensorflowSavedModel || tensorflowFiles.length > 0) {
    const files = [
      ...(tensorflowSavedModel ? [createFileRecord(tensorflowSavedModel, "weights", "tensorflow-savedmodel", true)] : []),
      ...tensorflowFiles.map((filePath) => createFileRecord(filePath, inferTensorFlowFileKind(filePath), "tensorflow", true)),
      ...sidecar.files,
    ];
    const variablesDir = path.join(modelDir, "variables");
    if (fs.existsSync(variablesDir) && fs.statSync(variablesDir).isDirectory()) {
      for (const entry of fs.readdirSync(variablesDir, { withFileTypes: true })) {
        if (!entry.isFile()) {
          continue;
        }
        files.push(createFileRecord(path.join(variablesDir, entry.name), "weights", "tensorflow-variables", true));
      }
    }
    return {
      format: "tensorflow",
      files,
      config: sidecar.config,
      tokenizer: sidecar.tokenizer,
      tokenizerConfig: sidecar.tokenizerConfig,
      generationConfig: sidecar.generationConfig,
      specialTokensMap: sidecar.specialTokensMap,
      chatTemplate: sidecar.chatTemplate,
      notes: [
        "Transformers-compatible TensorFlow model directory detected.",
        "TensorFlow weights were recognized from the local directory layout.",
        "Prefer conversion or an external runtime for execution; native TensorFlow execution is not implemented.",
      ],
    };
  }
  if (sidecar.config || sidecar.tokenizer) {
    return {
      format: "transformers",
      files: sidecar.files,
      config: sidecar.config,
      tokenizer: sidecar.tokenizer,
      tokenizerConfig: sidecar.tokenizerConfig,
      generationConfig: sidecar.generationConfig,
      specialTokensMap: sidecar.specialTokensMap,
      chatTemplate: sidecar.chatTemplate,
      notes: [
        "Transformers/Hugging Face model directory metadata detected.",
        "The directory contains config or tokenizer sidecars but no directly supported native weight file.",
        "Use this layout with vLLM, SGLang, or another OpenAI-compatible runtime.",
      ],
    };
  }
  return null;
}

function loadPyTorchLayoutFromIndex(
  modelDir: string,
  indexPath: string,
  sidecar: ReturnType<typeof readDirectorySidecars>,
): DetectedLocalModelLayout {
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
    weight_map?: Record<string, unknown>;
  };
  const shardNames = Array.from(
    new Set(
      Object.values(index.weight_map ?? {})
        .filter((value): value is string => typeof value === "string"),
    ),
  ).sort();
  return {
    format: "pytorch",
    files: [
      createFileRecord(indexPath, "weights", "pytorch-index", true),
      ...shardNames
        .map((name) => path.join(modelDir, name))
        .filter((filePath) => fs.existsSync(filePath))
        .map((filePath) => createFileRecord(filePath, "weights", "pytorch", true)),
      ...sidecar.files,
    ],
    config: sidecar.config,
    tokenizer: sidecar.tokenizer,
    tokenizerConfig: sidecar.tokenizerConfig,
    generationConfig: sidecar.generationConfig,
    specialTokensMap: sidecar.specialTokensMap,
    chatTemplate: sidecar.chatTemplate,
    notes: [
      "Sharded PyTorch checkpoint index detected.",
      "PyTorch shard files were recognized from the Transformers directory layout.",
      "Prefer vLLM or SGLang for execution; native execution for raw PyTorch weights is not implemented.",
    ],
  };
}

function loadFromDetectedFormat(filePath: string, format: NativeRuntimeFormat): LoadedNativeModel {
  switch (format) {
    case "gguf":
      return loadGgufMetadata(filePath);
    case "safetensors":
      return loadSafetensorsMetadata(filePath);
    case "onnx":
      return loadOnnxMetadata(filePath);
    case "kgm-json":
      return loadJsonCheckpoint(filePath);
    default:
      throw new Error(`Yueli KGM Runtime model format unsupported:${filePath}`);
  }
}

function resolveOllamaModel(modelPath: string, options?: LoadNativeModelOptions): ResolvedOllamaModel | null {
  const stat = fs.statSync(modelPath);
  if (stat.isDirectory()) {
    if (isOllamaStoreRoot(modelPath)) {
      return resolveOllamaFromStoreRoot(modelPath, options?.modelRef ?? process.env.KGM_OLLAMA_MODEL);
    }
    if (isOllamaManifestDirectory(modelPath)) {
      const manifestPath = resolveOllamaManifestFromDirectory(modelPath);
      return resolveOllamaFromManifest(manifestPath, modelPath);
    }
    return null;
  }
  if (isOllamaManifestFile(modelPath)) {
    return resolveOllamaFromManifest(modelPath, modelPath);
  }
  return null;
}

function resolveOllamaFromStoreRoot(storeRoot: string, rawModelRef?: string): ResolvedOllamaModel {
  const manifestRoot = path.join(storeRoot, "manifests");
  const normalizedRef = normalizeOllamaModelRef(rawModelRef);
  if (!normalizedRef) {
    const manifests = listOllamaManifestFiles(manifestRoot);
    if (manifests.length === 1) {
      return resolveOllamaFromManifest(manifests[0], storeRoot);
    }
    throw new Error(`ollama_model_ref_required_for_store_root:${storeRoot}`);
  }
  const manifestPath = resolveOllamaManifestPath(manifestRoot, normalizedRef);
  return resolveOllamaFromManifest(manifestPath, storeRoot, normalizedRef);
}

function resolveOllamaFromManifest(manifestPath: string, requestedPath: string, modelRef?: string): ResolvedOllamaModel {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as OllamaManifest;
  const modelLayer = Array.isArray(manifest.layers)
    ? manifest.layers.find((layer) => layer.mediaType === "application/vnd.ollama.image.model")
    : undefined;
  if (!modelLayer?.digest) {
    throw new Error(`ollama_manifest_without_model_layer:${manifestPath}`);
  }
  const configLayer = manifest.config?.digest ? manifest.config : undefined;
  const storeRoot = findOllamaStoreRootFromManifestPath(manifestPath);
  const formatHint = readOllamaFormatHint(storeRoot, configLayer);
  return {
    storeRoot,
    requestedPath,
    manifestPath,
    modelRef: modelRef ?? deriveOllamaModelRefFromManifestPath(manifestPath),
    manifest,
    modelLayer,
    configLayer,
    formatHint,
  };
}

function isOllamaStoreRoot(targetPath: string): boolean {
  return fs.existsSync(path.join(targetPath, "manifests")) && fs.existsSync(path.join(targetPath, "blobs"));
}

function isOllamaManifestDirectory(targetPath: string): boolean {
  return targetPath.includes(`${path.sep}manifests${path.sep}`) && fs.existsSync(path.join(targetPath, "latest"));
}

function isOllamaManifestFile(targetPath: string): boolean {
  return targetPath.includes(`${path.sep}manifests${path.sep}`) && path.basename(targetPath) !== ".DS_Store";
}

function resolveOllamaManifestFromDirectory(manifestDir: string): string {
  const latestPath = path.join(manifestDir, "latest");
  if (fs.existsSync(latestPath)) {
    return latestPath;
  }
  const files = fs.readdirSync(manifestDir)
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => path.join(manifestDir, entry))
    .filter((entry) => fs.statSync(entry).isFile());
  if (files.length === 1) {
    return files[0];
  }
  throw new Error(`ollama_manifest_file_not_found:${manifestDir}`);
}

function resolveOllamaManifestPath(manifestRoot: string, modelRef: string): string {
  const candidates = buildOllamaManifestCandidates(manifestRoot, modelRef);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`ollama_manifest_not_found:${modelRef}`);
}

function buildOllamaManifestCandidates(manifestRoot: string, modelRef: string): string[] {
  const candidates = new Set<string>();
  const normalized = modelRef.trim().replace(/^ollama:\/\//, "").replace(/^\/+|\/+$/g, "");
  const { name, tag } = splitOllamaModelRef(normalized);
  if (!name) {
    return [];
  }
  const nameParts = name.split("/").filter(Boolean);
  if (nameParts[0] === "registry.ollama.ai" || nameParts[0] === "hub") {
    candidates.add(path.join(manifestRoot, ...nameParts, tag));
  }
  candidates.add(path.join(manifestRoot, normalized));
  candidates.add(path.join(manifestRoot, name, tag));
  if (nameParts.length === 1) {
    candidates.add(path.join(manifestRoot, "registry.ollama.ai", "library", nameParts[0], tag));
    candidates.add(path.join(manifestRoot, "hub", nameParts[0], tag));
  } else {
    candidates.add(path.join(manifestRoot, "registry.ollama.ai", ...nameParts, tag));
    candidates.add(path.join(manifestRoot, "hub", ...nameParts, tag));
  }
  return [...candidates];
}

function splitOllamaModelRef(value: string): { name: string; tag: string } {
  const pivot = value.lastIndexOf(":");
  if (pivot === -1 || value.slice(pivot).includes("/")) {
    return { name: value, tag: "latest" };
  }
  return {
    name: value.slice(0, pivot),
    tag: value.slice(pivot + 1) || "latest",
  };
}

function normalizeOllamaModelRef(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function listOllamaManifestFiles(manifestRoot: string): string[] {
  const manifests: string[] = [];
  const queue = [manifestRoot];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      manifests.push(entryPath);
    }
  }
  return manifests;
}

function findOllamaStoreRootFromManifestPath(manifestPath: string): string {
  const marker = `${path.sep}manifests${path.sep}`;
  const pivot = manifestPath.lastIndexOf(marker);
  if (pivot === -1) {
    throw new Error(`ollama_store_root_not_found:${manifestPath}`);
  }
  return manifestPath.slice(0, pivot);
}

function deriveOllamaModelRefFromManifestPath(manifestPath: string): string | undefined {
  const marker = `${path.sep}manifests${path.sep}`;
  const pivot = manifestPath.lastIndexOf(marker);
  if (pivot === -1) {
    return undefined;
  }
  const relative = manifestPath.slice(pivot + marker.length).split(path.sep).filter(Boolean);
  if (relative.length < 2) {
    return undefined;
  }
  const tag = relative.pop()!;
  if (relative[0] === "registry.ollama.ai") {
    relative.shift();
  }
  if (relative[0] === "library") {
    relative.shift();
  }
  return `${relative.join("/")}:${tag}`;
}

function readOllamaFormatHint(storeRoot: string, configLayer?: OllamaManifestLayer): string | undefined {
  if (!configLayer?.digest) {
    return undefined;
  }
  try {
    const blobPath = digestToBlobPath(storeRoot, configLayer.digest);
    const raw = JSON.parse(fs.readFileSync(blobPath, "utf8")) as { model_format?: unknown };
    return typeof raw.model_format === "string" ? raw.model_format.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function digestToBlobPath(storeRoot: string, digest?: string): string {
  if (!digest) {
    throw new Error("ollama_blob_digest_required");
  }
  return path.join(storeRoot, "blobs", digest.replace(":", "-"));
}

function detectOllamaBlobFormat(filePath: string, formatHint?: string): NativeRuntimeFormat {
  if (formatHint === "gguf") {
    return "gguf";
  }
  if (formatHint === "safetensors") {
    return "safetensors";
  }
  if (formatHint === "onnx") {
    return "onnx";
  }
  const handle = fs.openSync(filePath, "r");
  const header = Buffer.alloc(8);
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.subarray(0, 4).toString("utf8") === "GGUF") {
    return "gguf";
  }
  throw new Error(`ollama_blob_format_unsupported:${filePath}`);
}

function buildOllamaManifestFiles(resolved: ResolvedOllamaModel): NativeModelArtifactFile[] {
  const files: NativeModelArtifactFile[] = [
    createFileRecord(resolved.manifestPath, "config", "ollama-manifest", true),
  ];
  if (resolved.configLayer?.digest) {
    const configPath = digestToBlobPath(resolved.storeRoot, resolved.configLayer.digest);
    files.push(createFileRecord(configPath, "config", "ollama-config", true));
  }
  for (const layer of resolved.manifest.layers ?? []) {
    if (!layer.digest) {
      continue;
    }
    const blobPath = digestToBlobPath(resolved.storeRoot, layer.digest);
    files.push(createFileRecord(
      blobPath,
      layer.mediaType === "application/vnd.ollama.image.model" ? "weights" : "unknown",
      layer.mediaType ?? "ollama-layer",
      layer.mediaType === "application/vnd.ollama.image.model",
      { digest: layer.digest, size: layer.size },
    ));
  }
  return files;
}

function findFirstExisting(baseDir: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const target = path.join(baseDir, candidate);
    if (fs.existsSync(target)) {
      return target;
    }
  }
  return null;
}

function findMatchingFiles(
  baseDir: string,
  matcher: (entry: fs.Dirent) => boolean,
): string[] {
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher(entry))
    .map((entry) => path.join(baseDir, entry.name))
    .sort();
}

function isPyTorchFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return basename === "pytorch_model.bin"
    || basename === "pytorch_model.bin.index.json"
    || basename.endsWith(".pt")
    || basename.endsWith(".pth")
    || /^consolidated.*\.(pt|pth|bin)$/i.test(basename);
}

function isTensorFlowFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return basename === "saved_model.pb"
    || basename === "saved_model.pbtxt"
    || basename === "tf_model.h5"
    || basename.endsWith(".ckpt")
    || basename.endsWith(".ckpt.index")
    || basename.endsWith(".h5");
}

function inferTensorFlowFileKind(filePath: string): NativeModelArtifactFile["kind"] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".pb") || lower.endsWith(".pbtxt")) {
    return "config";
  }
  return "weights";
}

function firstFileByExtension(baseDir: string, extension: string): string | null {
  const entry = fs.readdirSync(baseDir).find((value) => value.toLowerCase().endsWith(extension));
  return entry ? path.join(baseDir, entry) : null;
}

function firstFileBySuffix(baseDir: string, suffix: string): string | null {
  const entry = fs.readdirSync(baseDir).find((value) => value.toLowerCase().endsWith(suffix));
  return entry ? path.join(baseDir, entry) : null;
}

function parseSafetensorsMetadata(filePath: string): ParsedSafetensorsDescriptor {
  const shard = parseSafetensorsShard(filePath);
  const sidecar = readDirectorySidecars(path.dirname(filePath));
  return {
    config: sidecar.config,
    tokenizer: sidecar.tokenizer,
    tokenizerConfig: sidecar.tokenizerConfig,
    generationConfig: sidecar.generationConfig,
    specialTokensMap: sidecar.specialTokensMap,
    rope: extractRopeMetadata(shard.metadata, sidecar.config),
    chatTemplate: sidecar.chatTemplate,
    files: [
      createFileRecord(filePath, "weights", "safetensors", true),
      ...sidecar.files,
    ],
    tensors: shard.tensors,
    tensorEntries: shard.tensorEntries,
  };
}

function parseShardedSafetensorsMetadata(indexPath: string): ParsedSafetensorsDescriptor {
  const modelDir = path.dirname(indexPath);
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
    metadata?: Record<string, unknown>;
    weight_map?: Record<string, unknown>;
  };
  const weightMap = index.weight_map;
  if (!weightMap || typeof weightMap !== "object") {
    throw new Error(`invalid_safetensors_index:${indexPath}`);
  }

  const shardNames = Array.from(
    new Set(
      Object.values(weightMap)
        .filter((value): value is string => typeof value === "string" && value.endsWith(".safetensors")),
    ),
  ).sort();
  if (shardNames.length === 0) {
    throw new Error(`safetensors_index_without_shards:${indexPath}`);
  }

  const sidecar = readDirectorySidecars(modelDir);
  const tensors: Array<{ name: string; shape?: number[]; dtype?: string }> = [];
  const tensorEntries: Record<string, ParsedSafetensorsTensorEntry> = {};
  let metadata: Record<string, unknown> | undefined;
  for (const shardName of shardNames) {
    const shardPath = path.join(modelDir, shardName);
    const shard = parseSafetensorsShard(shardPath);
    metadata ??= shard.metadata;
    tensors.push(...shard.tensors);
    Object.assign(tensorEntries, shard.tensorEntries);
  }

  return {
    config: sidecar.config,
    tokenizer: sidecar.tokenizer,
    tokenizerConfig: sidecar.tokenizerConfig,
    generationConfig: sidecar.generationConfig,
    specialTokensMap: sidecar.specialTokensMap,
    rope: extractRopeMetadata(metadata ?? index.metadata, sidecar.config),
    chatTemplate: sidecar.chatTemplate,
    files: [
      createFileRecord(indexPath, "weights", "safetensors-index", true),
      ...shardNames.map((shardName) => createFileRecord(path.join(modelDir, shardName), "weights", "safetensors", true)),
      ...sidecar.files,
    ],
    tensors,
    tensorEntries,
  };
}

function parseSafetensorsShard(filePath: string): {
  metadata?: Record<string, unknown>;
  tensors: Array<{ name: string; shape?: number[]; dtype?: string }>;
  tensorEntries: Record<string, ParsedSafetensorsTensorEntry>;
} {
  const handle = fs.openSync(filePath, "r");
  try {
    const lengthBuffer = Buffer.alloc(8);
    fs.readSync(handle, lengthBuffer, 0, 8, 0);
    const headerLength = Number(lengthBuffer.readBigUInt64LE(0));
    const headerBuffer = Buffer.alloc(headerLength);
    fs.readSync(handle, headerBuffer, 0, headerLength, 8);
    const header = JSON.parse(headerBuffer.toString("utf8")) as Record<string, any>;
    const tensors = Object.entries(header)
      .filter(([name]) => name !== "__metadata__")
      .map(([name, descriptor]) => ({
        name,
        shape: Array.isArray(descriptor?.shape) ? descriptor.shape.map((value: unknown) => Number(value)) : undefined,
        dtype: typeof descriptor?.dtype === "string" ? descriptor.dtype : undefined,
      }));
    const tensorEntries = Object.fromEntries(
      Object.entries(header)
        .filter(([name]) => name !== "__metadata__")
        .map(([name, descriptor]) => [
          name,
          {
            filePath,
            dtype: typeof descriptor?.dtype === "string" ? descriptor.dtype : undefined,
            shape: Array.isArray(descriptor?.shape) ? descriptor.shape.map((value: unknown) => Number(value)) : undefined,
            dataOffsets: Array.isArray(descriptor?.data_offsets) && descriptor.data_offsets.length === 2
              ? [Number(descriptor.data_offsets[0]), Number(descriptor.data_offsets[1])] as [number, number]
              : undefined,
          } satisfies ParsedSafetensorsTensorEntry,
        ]),
    );
    return {
      metadata: header.__metadata__ as Record<string, unknown> | undefined,
      tensors,
      tensorEntries,
    };
  } finally {
    fs.closeSync(handle);
  }
}

function parseGgufMetadata(filePath: string): ParsedGgufDescriptor {
  const handle = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(24);
    fs.readSync(handle, header, 0, 24, 0);
    const magic = header.toString("utf8", 0, 4);
    if (magic !== "GGUF") {
      throw new Error(`invalid_gguf_magic:${filePath}`);
    }
    const version = header.readUInt32LE(4);
    const tensorCount = Number(header.readBigUInt64LE(8));
    const kvCount = Number(header.readBigUInt64LE(16));
    let offset = 24;
    const metadata = new Map<string, unknown>();
    for (let index = 0; index < kvCount; index += 1) {
      const keyLength = readUint64(handle, offset);
      offset += 8;
      const key = readString(handle, offset, keyLength);
      offset += keyLength;
      const valueType = readUint32(handle, offset);
      offset += 4;
      const parsed = readGgufValue(handle, offset, valueType);
      offset += parsed.bytes;
      metadata.set(key, parsed.value);
    }
    const architecture = typeof metadata.get("general.architecture") === "string"
      ? String(metadata.get("general.architecture"))
      : "llama";
    const alignment = readNumber(metadata.get("general.alignment")) ?? 32;
    const tensors: Array<{ name: string; shape?: number[]; dtype?: string }> = [];
    const tensorEntries: Record<string, ParsedGgufTensorEntry> = {};
    for (let index = 0; index < tensorCount; index += 1) {
      const nameLength = readUint64(handle, offset);
      offset += 8;
      const name = readString(handle, offset, nameLength);
      offset += nameLength;
      const rank = readUint32(handle, offset);
      offset += 4;
      const ggmlShape: number[] = [];
      for (let axis = 0; axis < rank; axis += 1) {
        ggmlShape.push(readUint64(handle, offset));
        offset += 8;
      }
      const dtypeCode = readUint32(handle, offset);
      offset += 4;
      const relativeOffset = readUint64(handle, offset);
      offset += 8;
      const shape = [...ggmlShape].reverse();
      tensorEntries[name] = {
        filePath,
        ggmlShape,
        shape,
        dtypeCode,
        dataOffset: relativeOffset,
      };
      tensors.push({
        name,
        shape,
        dtype: mapGgufDtypeLabel(dtypeCode),
      });
    }
    const dataSectionOffset = alignOffset(offset, alignment);
    for (const entry of Object.values(tensorEntries)) {
      entry.dataOffset += dataSectionOffset;
    }
    const sidecar = readDirectorySidecars(path.dirname(filePath));
    const tokenizerModel = metadata.get("tokenizer.ggml.model");
    const tokenizerTokens = metadata.get("tokenizer.ggml.tokens");
    const tokenizerScores = metadata.get("tokenizer.ggml.scores");
    const bosTokenId = metadata.get("tokenizer.ggml.bos_token_id");
    const eosTokenId = metadata.get("tokenizer.ggml.eos_token_id");
    const unkTokenId = metadata.get("tokenizer.ggml.unknown_token_id");
    const padTokenId = metadata.get("tokenizer.ggml.padding_token_id");
    return {
      config: {
        ggufVersion: version,
        architecture,
        name: metadata.get("general.name"),
        model_type: architecture,
        contextLength: metadata.get(`${architecture}.context_length`) ?? metadata.get("llama.context_length"),
        embeddingLength: metadata.get(`${architecture}.embedding_length`) ?? metadata.get("llama.embedding_length"),
        blockCount: metadata.get(`${architecture}.block_count`) ?? metadata.get("llama.block_count"),
        feedForwardLength: metadata.get(`${architecture}.feed_forward_length`) ?? metadata.get("llama.feed_forward_length"),
        headCount: metadata.get(`${architecture}.attention.head_count`) ?? metadata.get("llama.attention.head_count"),
        headCountKv: metadata.get(`${architecture}.attention.head_count_kv`) ?? metadata.get("llama.attention.head_count_kv"),
        rope_theta: metadata.get(`${architecture}.rope.freq_base`) ?? metadata.get("llama.rope.freq_base"),
        bos_token_id: bosTokenId,
        eos_token_id: eosTokenId,
        unk_token_id: unkTokenId,
        pad_token_id: padTokenId,
        vocab_size: Array.isArray(tokenizerTokens) ? tokenizerTokens.length : undefined,
      },
      tokenizer: {
        type: tokenizerModel,
        size: Array.isArray(tokenizerTokens) ? tokenizerTokens.length : undefined,
        tokens: Array.isArray(tokenizerTokens) ? tokenizerTokens : undefined,
        scores: Array.isArray(tokenizerScores) ? tokenizerScores : undefined,
        bos_token_id: bosTokenId,
        eos_token_id: eosTokenId,
        unk_token_id: unkTokenId,
        pad_token_id: padTokenId,
      },
      rope: extractRopeMetadata(Object.fromEntries(metadata.entries()), sidecar.config),
      chatTemplate: typeof metadata.get("tokenizer.chat_template") === "string"
        ? String(metadata.get("tokenizer.chat_template"))
        : sidecar.chatTemplate,
      files: [
        createFileRecord(filePath, "weights", "gguf", true),
        ...sidecar.files,
      ],
      tensors,
      tensorEntries,
      metadata: Object.fromEntries(metadata.entries()),
    };
  } finally {
    fs.closeSync(handle);
  }
}

function readDirectorySidecars(modelDir: string): {
  config?: Record<string, unknown>;
  tokenizer?: Record<string, unknown>;
  tokenizerConfig?: Record<string, unknown>;
  generationConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
  chatTemplate?: string;
  files: NativeModelArtifactFile[];
} {
  const sidecars = readModelSidecars(modelDir);
  return {
    config: sidecars.config,
    tokenizer: sidecars.tokenizer,
    tokenizerConfig: sidecars.tokenizerConfig,
    generationConfig: sidecars.generationConfig,
    specialTokensMap: sidecars.specialTokensMap,
    chatTemplate: sidecars.chatTemplate,
    files: sidecars.files,
  };
}

function extractRopeMetadata(
  source?: Record<string, unknown> | null,
  config?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const theta = source?.["llama.rope.freq_base"] ?? config?.rope_theta ?? config?.rope_base;
  const scaling = source?.["llama.rope.scaling.type"] ?? config?.rope_scaling;
  if (typeof theta === "undefined" && typeof scaling === "undefined") {
    return undefined;
  }
  return {
    theta,
    scaling,
  };
}

function alignOffset(offset: number, alignment: number): number {
  const normalized = Math.max(1, alignment);
  return Math.ceil(offset / normalized) * normalized;
}

function readUint32(handle: number, offset: number): number {
  const buffer = Buffer.alloc(4);
  fs.readSync(handle, buffer, 0, 4, offset);
  return buffer.readUInt32LE(0);
}

function readUint64(handle: number, offset: number): number {
  const buffer = Buffer.alloc(8);
  fs.readSync(handle, buffer, 0, 8, offset);
  return Number(buffer.readBigUInt64LE(0));
}

function readString(handle: number, offset: number, length: number): string {
  const buffer = Buffer.alloc(length);
  fs.readSync(handle, buffer, 0, length, offset);
  return buffer.toString("utf8");
}

function readGgufValue(handle: number, offset: number, type: number): { value: unknown; bytes: number } {
  switch (type) {
    case 0: {
      const buffer = Buffer.alloc(1);
      fs.readSync(handle, buffer, 0, 1, offset);
      return { value: buffer.readUInt8(0), bytes: 1 };
    }
    case 1: {
      const buffer = Buffer.alloc(1);
      fs.readSync(handle, buffer, 0, 1, offset);
      return { value: buffer.readInt8(0), bytes: 1 };
    }
    case 2: {
      const buffer = Buffer.alloc(2);
      fs.readSync(handle, buffer, 0, 2, offset);
      return { value: buffer.readUInt16LE(0), bytes: 2 };
    }
    case 3: {
      const buffer = Buffer.alloc(2);
      fs.readSync(handle, buffer, 0, 2, offset);
      return { value: buffer.readInt16LE(0), bytes: 2 };
    }
    case 4: {
      const buffer = Buffer.alloc(4);
      fs.readSync(handle, buffer, 0, 4, offset);
      return { value: buffer.readUInt32LE(0), bytes: 4 };
    }
    case 5: {
      const buffer = Buffer.alloc(4);
      fs.readSync(handle, buffer, 0, 4, offset);
      return { value: buffer.readInt32LE(0), bytes: 4 };
    }
    case 6: {
      const buffer = Buffer.alloc(4);
      fs.readSync(handle, buffer, 0, 4, offset);
      return { value: buffer.readFloatLE(0), bytes: 4 };
    }
    case 7: {
      const length = readUint8(handle, offset) ? 1 : 1;
      const buffer = Buffer.alloc(1);
      fs.readSync(handle, buffer, 0, 1, offset);
      return { value: buffer.readUInt8(0) !== 0, bytes: length };
    }
    case 8: {
      const length = readUint64(handle, offset);
      return {
        value: readString(handle, offset + 8, length),
        bytes: 8 + length,
      };
    }
    case 9: {
      const subtype = readUint32(handle, offset);
      const length = readUint64(handle, offset + 4);
      let consumed = 12;
      const values: unknown[] = [];
      let cursor = offset + 12;
      for (let index = 0; index < length; index += 1) {
        const parsed = readGgufValue(handle, cursor, subtype);
        cursor += parsed.bytes;
        consumed += parsed.bytes;
        values.push(parsed.value);
      }
      return { value: values, bytes: consumed };
    }
    case 10: {
      const buffer = Buffer.alloc(8);
      fs.readSync(handle, buffer, 0, 8, offset);
      return { value: Number(buffer.readBigUInt64LE(0)), bytes: 8 };
    }
    case 11: {
      const buffer = Buffer.alloc(8);
      fs.readSync(handle, buffer, 0, 8, offset);
      return { value: Number(buffer.readBigInt64LE(0)), bytes: 8 };
    }
    case 12: {
      const buffer = Buffer.alloc(8);
      fs.readSync(handle, buffer, 0, 8, offset);
      return { value: buffer.readDoubleLE(0), bytes: 8 };
    }
    default:
      throw new Error(`unsupported_gguf_value_type:${type}`);
  }
}

function readUint8(handle: number, offset: number): number {
  const buffer = Buffer.alloc(1);
  fs.readSync(handle, buffer, 0, 1, offset);
  return buffer.readUInt8(0);
}

function createFileRecord(
  filePath: string,
  kind: NativeModelArtifactFile["kind"],
  format: string,
  required: boolean,
  metadata?: Record<string, unknown>,
): NativeModelArtifactFile {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  return {
    kind,
    path: resolved,
    format,
    sizeBytes: stat.size,
    required,
    metadata,
  };
}

function buildTokenizerFromSidecars(sidecars: {
  tokenizer?: Record<string, unknown>;
  tokenizerConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
  chatTemplate?: string;
}): NativeTokenizer | undefined {
  if (!sidecars.tokenizer) {
    return undefined;
  }
  return createTokenizerFromHfTokenizerJson({
    tokenizer: sidecars.tokenizer,
    tokenizerConfig: sidecars.tokenizerConfig,
    specialTokensMap: sidecars.specialTokensMap,
    chatTemplate: sidecars.chatTemplate,
  }) ?? undefined;
}

function buildTokenizerFromGgufMetadata(descriptor: ParsedGgufDescriptor): NativeTokenizer | undefined {
  const metadata = descriptor.metadata;
  const tokens = Array.isArray(metadata["tokenizer.ggml.tokens"])
    ? metadata["tokenizer.ggml.tokens"].filter((value): value is string => typeof value === "string")
    : [];
  if (tokens.length === 0) {
    return undefined;
  }
  const scores = Array.isArray(metadata["tokenizer.ggml.scores"])
    ? metadata["tokenizer.ggml.scores"].map((value) => readNumber(value) ?? 0)
    : undefined;
  const bosTokenId = readNumber(metadata["tokenizer.ggml.bos_token_id"]);
  const eosTokenId = readNumber(metadata["tokenizer.ggml.eos_token_id"]);
  const unkTokenId = readNumber(metadata["tokenizer.ggml.unknown_token_id"]);
  const padTokenId = readNumber(metadata["tokenizer.ggml.padding_token_id"]);
  const specialTokens: Record<string, number> = {};
  for (const id of [bosTokenId, eosTokenId, unkTokenId, padTokenId]) {
    if (typeof id === "number" && id >= 0 && id < tokens.length) {
      specialTokens[tokens[id]!] = id;
    }
  }
  const tokenizerType = typeof metadata["tokenizer.ggml.model"] === "string"
    ? String(metadata["tokenizer.ggml.model"]).toLowerCase()
    : "";
  if (tokenizerType === "llama" || tokenizerType === "sentencepiece" || scores) {
    return createTokenizer({
      kind: "hf-unigram",
      vocab: tokens,
      scores,
      bosTokenId,
      eosTokenId,
      unkTokenId,
      padTokenId,
      specialTokens,
      metaspaceReplacement: "▁",
      metaspacePrependScheme: "always",
      chatTemplate: descriptor.chatTemplate,
    });
  }
  return createTokenizer({
    kind: "character",
    vocab: tokens,
    bosTokenId,
    eosTokenId,
    unkTokenId,
    padTokenId,
    specialTokens,
    chatTemplate: descriptor.chatTemplate,
  });
}

function tryCreateExecutableGgufModel(
  descriptor: ParsedGgufDescriptor,
): ExecutableModelAttempt {
  const layoutIssues = analyzeGgufDescriptorLayoutIssues(descriptor);
  if (layoutIssues.length > 0) {
    return {
      reason: `CPU reference backend cannot execute this GGUF yet: ${layoutIssues.join("; ")}.`,
    };
  }
  const nativeConfig = buildNativeConfigFromGgufConfig(descriptor.config);
  if (!nativeConfig) {
    return {
      reason: "GGUF metadata is missing required decoder-only dimensions for native execution.",
    };
  }
  try {
    const tensors = loadExecutableGgufTensors(nativeConfig, descriptor.tensorEntries);
    const checkpoint: NativeCheckpoint = {
      format: "kgm-transformer-checkpoint",
      version: 1,
      config: nativeConfig,
      tokenizer: {
        kind: "byte",
      },
      tensors: {},
      metadata: {
        source: "gguf-reference-loader",
      },
    };
    return {
      model: new NativeTransformerModel(checkpoint, tensors),
    };
  } catch (error) {
    return {
      reason: explainExecutableGgufFailure(error),
    };
  }
}

function tryCreateExecutableSafetensorsModel(
  descriptor: {
    config?: Record<string, unknown>;
    rope?: Record<string, unknown>;
    tensorEntries: Record<string, ParsedSafetensorsTensorEntry>;
  },
): NativeTransformerModel | undefined {
  const nativeConfig = hfDecoderConfigToNativeModelConfig(descriptor.config, descriptor.rope);
  if (!nativeConfig) {
    return undefined;
  }

  try {
    const tensors = loadExecutableSafetensorsTensors(nativeConfig, descriptor.tensorEntries, descriptor.config);
    const checkpoint: NativeCheckpoint = {
      format: "kgm-transformer-checkpoint",
      version: 1,
      config: nativeConfig,
      tokenizer: {
        kind: "byte",
      },
      tensors: {},
      metadata: {
        source: "safetensors-reference-loader",
      },
    };
    return new NativeTransformerModel(checkpoint, tensors);
  } catch {
    return undefined;
  }
}

function buildNativeConfigFromGgufConfig(
  config?: Record<string, unknown>,
): NativeCheckpoint["config"] | undefined {
  if (!config) {
    return undefined;
  }
  const hiddenSize = readConfigNumber(config, ["hidden_size", "embeddingLength"]);
  const intermediateSize = readConfigNumber(config, ["intermediate_size", "feedForwardLength"]);
  const numLayers = readConfigNumber(config, ["num_hidden_layers", "blockCount"]);
  const numHeads = readConfigNumber(config, ["num_attention_heads", "headCount"]);
  const vocabSize = readConfigNumber(config, ["vocab_size"]) ?? readNumber(config.tokenizerSize);
  const maxPositionEmbeddings = readConfigNumber(config, ["max_position_embeddings", "contextLength"]);
  if (
    typeof hiddenSize !== "number" ||
    typeof intermediateSize !== "number" ||
    typeof numLayers !== "number" ||
    typeof numHeads !== "number" ||
    typeof vocabSize !== "number" ||
    typeof maxPositionEmbeddings !== "number"
  ) {
    return undefined;
  }
  return {
    architecture: "decoder-only",
    vocabSize,
    hiddenSize,
    intermediateSize,
    numLayers,
    numHeads,
    numKvHeads: readConfigNumber(config, ["num_key_value_heads"]) ?? readConfigNumberArray(config, ["headCountKv"]),
    maxPositionEmbeddings,
    ropeTheta: readConfigNumber(config, ["rope_theta"]),
    ropeDimension: hiddenSize / numHeads,
    normEps: 1e-5,
    normKind: "rmsnorm",
    activation: "silu",
    bosTokenId: readConfigNumber(config, ["bos_token_id"]),
    eosTokenId: readConfigNumber(config, ["eos_token_id"]),
    padTokenId: readConfigNumber(config, ["pad_token_id"]),
    chatTemplate: typeof config.chat_template === "string" ? config.chat_template : undefined,
  };
}

function loadExecutableGgufTensors(
  config: NativeCheckpoint["config"],
  tensorEntries: Record<string, ParsedGgufTensorEntry>,
): Record<string, NativeTensor> {
  const tensors: Record<string, NativeTensor> = {};
  const aliases = buildGgufTensorAliases(config);
  for (const [targetName, sourceName] of Object.entries(aliases)) {
    const entry = tensorEntries[sourceName];
    if (!entry?.shape?.length) {
      throw new Error(`gguf_tensor_missing:${sourceName}`);
    }
    tensors[targetName] = loadGgufTensor(entry);
  }
  if (!tensors["lm_head.weight"] && tensors["token_embedding.weight"]) {
    tensors["lm_head.weight"] = tensors["token_embedding.weight"]!;
  }
  return tensors;
}

function buildGgufTensorAliases(
  config: NativeCheckpoint["config"],
): Record<string, string> {
  const aliases: Record<string, string> = {
    "token_embedding.weight": "token_embd.weight",
    "output_norm.weight": "output_norm.weight",
    "lm_head.weight": "output.weight",
  };
  for (let index = 0; index < config.numLayers; index += 1) {
    aliases[`layers.${index}.attn_norm.weight`] = `blk.${index}.attn_norm.weight`;
    aliases[`layers.${index}.ffn_norm.weight`] = `blk.${index}.ffn_norm.weight`;
    aliases[`layers.${index}.attention.wq.weight`] = `blk.${index}.attn_q.weight`;
    aliases[`layers.${index}.attention.wk.weight`] = `blk.${index}.attn_k.weight`;
    aliases[`layers.${index}.attention.wv.weight`] = `blk.${index}.attn_v.weight`;
    aliases[`layers.${index}.attention.wo.weight`] = `blk.${index}.attn_output.weight`;
    aliases[`layers.${index}.feed_forward.w1.weight`] = `blk.${index}.ffn_gate.weight`;
    aliases[`layers.${index}.feed_forward.w2.weight`] = `blk.${index}.ffn_down.weight`;
    aliases[`layers.${index}.feed_forward.w3.weight`] = `blk.${index}.ffn_up.weight`;
  }
  return aliases;
}

function loadExecutableSafetensorsTensors(
  config: NativeCheckpoint["config"],
  tensorEntries: Record<string, ParsedSafetensorsTensorEntry>,
  rawConfig?: Record<string, unknown>,
): Record<string, NativeTensor> {
  const tensors: Record<string, NativeTensor> = {};
  const aliases = buildSafetensorsTensorAliases(config, rawConfig);
  for (const [targetName, sourceName] of Object.entries(aliases)) {
    const entry = tensorEntries[sourceName];
    if (!entry?.shape || !entry.dataOffsets) {
      throw new Error(`safetensors_tensor_missing:${sourceName}`);
    }
    tensors[targetName] = loadSafetensorsTensor(entry.filePath, entry.shape, entry.dtype, entry.dataOffsets);
  }

  if (!tensors["lm_head.weight"] && tensors["token_embedding.weight"]) {
    tensors["lm_head.weight"] = tensors["token_embedding.weight"]!;
  }
  return tensors;
}

function loadGgufTensor(entry: ParsedGgufTensorEntry): NativeTensor {
  const { shape, dtypeCode, dataOffset, filePath } = entry;
  if (shape.length === 1) {
    if (dtypeCode === 0 || dtypeCode === 1) {
      return loadGgufDenseTensor(filePath, shape, dtypeCode, dataOffset);
    }
    throw new Error(`unsupported_gguf_vector_dtype:${dtypeCode}`);
  }
  if (shape.length !== 2) {
    throw new Error(`unsupported_gguf_tensor_rank:${shape.length}`);
  }
  if (dtypeCode === 0 || dtypeCode === 1) {
    return loadGgufDenseTensor(filePath, shape, dtypeCode, dataOffset);
  }
  if (dtypeCode === 8) {
    return loadGgufQ80Tensor(filePath, shape, dataOffset);
  }
  if (dtypeCode === 12) {
    return loadGgufQ4KTensor(filePath, shape, dataOffset);
  }
  if (dtypeCode === 13) {
    return loadGgufQ5KTensor(filePath, shape, dataOffset);
  }
  if (dtypeCode === 14) {
    return loadGgufQ6KTensor(filePath, shape, dataOffset);
  }
  throw new Error(`unsupported_gguf_tensor_dtype:${dtypeCode}`);
}

function loadGgufDenseTensor(
  filePath: string,
  shape: number[],
  dtypeCode: number,
  dataOffset: number,
): NativeTensor {
  const size = shape.reduce((product, value) => product * value, 1);
  const bytesPerElement = dtypeCode === 0 ? 4 : 2;
  const buffer = Buffer.alloc(size * bytesPerElement);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, buffer, 0, buffer.length, dataOffset);
  } finally {
    fs.closeSync(handle);
  }
  const data = new Float32Array(size);
  if (dtypeCode === 0) {
    for (let index = 0; index < size; index += 1) {
      data[index] = buffer.readFloatLE(index * 4);
    }
  } else {
    for (let index = 0; index < size; index += 1) {
      data[index] = decodeFloat16(buffer.readUInt16LE(index * 2));
    }
  }
  return {
    shape: [...shape],
    dtype: "f32",
    data,
  };
}

function loadGgufQ80Tensor(
  filePath: string,
  shape: number[],
  dataOffset: number,
): NativeTensor {
  const [rows, cols] = shape;
  const blockSize = 32;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const buffer = Buffer.alloc(rows * blocksPerRow * 34);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, buffer, 0, buffer.length, dataOffset);
  } finally {
    fs.closeSync(handle);
  }

  const data = new Int8Array(rows * cols);
  const scales = new Float32Array(rows * blocksPerRow);
  let cursor = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let block = 0; block < blocksPerRow; block += 1) {
      const scale = decodeFloat16(buffer.readUInt16LE(cursor));
      cursor += 2;
      scales[row * blocksPerRow + block] = scale;
      const start = row * cols + block * blockSize;
      const remaining = Math.max(0, cols - block * blockSize);
      const copyLength = Math.min(blockSize, remaining);
      for (let index = 0; index < blockSize; index += 1) {
        const value = buffer.readInt8(cursor++);
        if (index < copyLength) {
          data[start + index] = value;
        }
      }
    }
  }
  return {
    shape: [...shape],
    dtype: "q8_0",
    data,
    scales,
    blockSize,
  };
}

function loadGgufQ4KTensor(
  filePath: string,
  shape: number[],
  dataOffset: number,
): NativeTensor {
  const [rows, cols] = shape;
  const blockSize = 256;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const bytesPerBlock = 2 + 2 + 12 + 128;
  const buffer = Buffer.alloc(rows * blocksPerRow * bytesPerBlock);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, buffer, 0, buffer.length, dataOffset);
  } finally {
    fs.closeSync(handle);
  }

  const data = new Float32Array(rows * cols);
  let cursor = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let block = 0; block < blocksPerRow; block += 1) {
      const d = decodeFloat16(buffer.readUInt16LE(cursor));
      cursor += 2;
      const dmin = decodeFloat16(buffer.readUInt16LE(cursor));
      cursor += 2;
      const scales = buffer.subarray(cursor, cursor + 12);
      cursor += 12;
      const qs = buffer.subarray(cursor, cursor + 128);
      cursor += 128;
      const unpacked = unpackKQuantScalesAndMins(scales);
      const rowOffset = row * cols + block * blockSize;
      const remaining = Math.max(0, cols - block * blockSize);
      const limit = Math.min(blockSize, remaining);
      for (let group = 0; group < 8; group += 1) {
        const scale = d * unpacked.scales[group]!;
        const min = dmin * unpacked.mins[group]!;
        for (let index = 0; index < 32; index += 1) {
          const blockIndex = group * 32 + index;
          if (blockIndex >= limit) {
            break;
          }
          const q = readNibble(qs, blockIndex);
          data[rowOffset + blockIndex] = scale * q - min;
        }
      }
    }
  }

  return {
    shape: [...shape],
    dtype: "f32",
    data,
  };
}

function loadGgufQ5KTensor(
  filePath: string,
  shape: number[],
  dataOffset: number,
): NativeTensor {
  const [rows, cols] = shape;
  const blockSize = 256;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const bytesPerBlock = 2 + 2 + 12 + 32 + 128;
  const buffer = Buffer.alloc(rows * blocksPerRow * bytesPerBlock);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, buffer, 0, buffer.length, dataOffset);
  } finally {
    fs.closeSync(handle);
  }

  const data = new Float32Array(rows * cols);
  let cursor = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let block = 0; block < blocksPerRow; block += 1) {
      const d = decodeFloat16(buffer.readUInt16LE(cursor));
      cursor += 2;
      const dmin = decodeFloat16(buffer.readUInt16LE(cursor));
      cursor += 2;
      const scales = buffer.subarray(cursor, cursor + 12);
      cursor += 12;
      const qh = buffer.subarray(cursor, cursor + 32);
      cursor += 32;
      const qs = buffer.subarray(cursor, cursor + 128);
      cursor += 128;
      const unpacked = unpackKQuantScalesAndMins(scales);
      const rowOffset = row * cols + block * blockSize;
      const remaining = Math.max(0, cols - block * blockSize);
      const limit = Math.min(blockSize, remaining);
      for (let group = 0; group < 8; group += 1) {
        const scale = d * unpacked.scales[group]!;
        const min = dmin * unpacked.mins[group]!;
        for (let index = 0; index < 32; index += 1) {
          const blockIndex = group * 32 + index;
          if (blockIndex >= limit) {
            break;
          }
          const q = readNibble(qs, blockIndex) + (readBit(qh, blockIndex) ? 16 : 0);
          data[rowOffset + blockIndex] = scale * q - min;
        }
      }
    }
  }

  return {
    shape: [...shape],
    dtype: "f32",
    data,
  };
}

function loadGgufQ6KTensor(
  filePath: string,
  shape: number[],
  dataOffset: number,
): NativeTensor {
  const [rows, cols] = shape;
  const blockSize = 256;
  const blocksPerRow = Math.ceil(cols / blockSize);
  const bytesPerBlock = 2 + 128 + 64 + 16;
  const buffer = Buffer.alloc(rows * blocksPerRow * bytesPerBlock);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, buffer, 0, buffer.length, dataOffset);
  } finally {
    fs.closeSync(handle);
  }

  const data = new Float32Array(rows * cols);
  let cursor = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let block = 0; block < blocksPerRow; block += 1) {
      const d = decodeFloat16(buffer.readUInt16LE(cursor));
      cursor += 2;
      const ql = buffer.subarray(cursor, cursor + 128);
      cursor += 128;
      const qh = buffer.subarray(cursor, cursor + 64);
      cursor += 64;
      const scales = buffer.subarray(cursor, cursor + 16);
      cursor += 16;
      const rowOffset = row * cols + block * blockSize;
      const remaining = Math.max(0, cols - block * blockSize);
      const limit = Math.min(blockSize, remaining);
      for (let group = 0; group < 16; group += 1) {
        const scale = d * scales.readInt8(group);
        for (let index = 0; index < 16; index += 1) {
          const blockIndex = group * 16 + index;
          if (blockIndex >= limit) {
            break;
          }
          const low = readNibble(ql, blockIndex);
          const high = readTwoBits(qh, blockIndex);
          data[rowOffset + blockIndex] = scale * ((low | (high << 4)) - 32);
        }
      }
    }
  }

  return {
    shape: [...shape],
    dtype: "f32",
    data,
  };
}

function unpackKQuantScalesAndMins(buffer: Buffer): { scales: number[]; mins: number[] } {
  const scales = new Array<number>(8).fill(0);
  const mins = new Array<number>(8).fill(0);
  for (let index = 0; index < 4; index += 1) {
    const lowScaleByte = buffer[index] ?? 0;
    const lowMinByte = buffer[index + 4] ?? 0;
    const packed = buffer[index + 8] ?? 0;
    scales[index] = lowScaleByte & 0x3f;
    mins[index] = lowMinByte & 0x3f;
    scales[index + 4] = (packed & 0x0f) | ((lowScaleByte >> 6) << 4);
    mins[index + 4] = ((packed >> 4) & 0x0f) | ((lowMinByte >> 6) << 4);
  }
  return { scales, mins };
}

function readNibble(buffer: Buffer, index: number): number {
  const value = buffer[Math.floor(index / 2)] ?? 0;
  return index % 2 === 0 ? (value & 0x0f) : (value >> 4);
}

function readBit(buffer: Buffer, index: number): boolean {
  const value = buffer[Math.floor(index / 8)] ?? 0;
  return ((value >> (index % 8)) & 0x1) === 1;
}

function readTwoBits(buffer: Buffer, index: number): number {
  const value = buffer[Math.floor(index / 4)] ?? 0;
  return (value >> ((index % 4) * 2)) & 0x03;
}

function buildSafetensorsTensorAliases(
  config: NativeCheckpoint["config"],
  rawConfig?: Record<string, unknown>,
): Record<string, string> {
  const aliases: Record<string, string> = {
    "token_embedding.weight": "model.embed_tokens.weight",
    "output_norm.weight": "model.norm.weight",
    "lm_head.weight": "lm_head.weight",
  };

  const tieWordEmbeddings = rawConfig?.tie_word_embeddings === true;
  if (tieWordEmbeddings) {
    aliases["lm_head.weight"] = "model.embed_tokens.weight";
  }

  for (let index = 0; index < config.numLayers; index += 1) {
    aliases[`layers.${index}.attn_norm.weight`] = `model.layers.${index}.input_layernorm.weight`;
    aliases[`layers.${index}.ffn_norm.weight`] = `model.layers.${index}.post_attention_layernorm.weight`;
    aliases[`layers.${index}.attention.wq.weight`] = `model.layers.${index}.self_attn.q_proj.weight`;
    aliases[`layers.${index}.attention.wk.weight`] = `model.layers.${index}.self_attn.k_proj.weight`;
    aliases[`layers.${index}.attention.wv.weight`] = `model.layers.${index}.self_attn.v_proj.weight`;
    aliases[`layers.${index}.attention.wo.weight`] = `model.layers.${index}.self_attn.o_proj.weight`;
    aliases[`layers.${index}.feed_forward.w1.weight`] = `model.layers.${index}.mlp.gate_proj.weight`;
    aliases[`layers.${index}.feed_forward.w2.weight`] = `model.layers.${index}.mlp.down_proj.weight`;
    aliases[`layers.${index}.feed_forward.w3.weight`] = `model.layers.${index}.mlp.up_proj.weight`;
  }
  return aliases;
}

function loadSafetensorsTensor(
  filePath: string,
  shape: number[],
  dtype: string | undefined,
  dataOffsets: [number, number],
): NativeTensor {
  const headerLengthBuffer = Buffer.alloc(8);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, headerLengthBuffer, 0, 8, 0);
    const headerLength = Number(headerLengthBuffer.readBigUInt64LE(0));
    const start = 8 + headerLength + dataOffsets[0];
    const byteLength = dataOffsets[1] - dataOffsets[0];
    const buffer = Buffer.alloc(byteLength);
    fs.readSync(handle, buffer, 0, byteLength, start);
    return {
      shape: [...shape],
      dtype: "f32",
      data: decodeSafetensorsData(buffer, shape, dtype),
    };
  } finally {
    fs.closeSync(handle);
  }
}

function decodeSafetensorsData(
  buffer: Buffer,
  shape: number[],
  dtype?: string,
): Float32Array {
  const size = shape.reduce((product, value) => product * value, 1);
  const normalized = (dtype ?? "F32").toUpperCase();
  if (normalized === "F32") {
    const output = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      output[index] = buffer.readFloatLE(index * 4);
    }
    return output;
  }
  if (normalized === "F16") {
    const output = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      output[index] = decodeFloat16(buffer.readUInt16LE(index * 2));
    }
    return output;
  }
  if (normalized === "BF16") {
    const output = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      output[index] = decodeBFloat16(buffer.readUInt16LE(index * 2));
    }
    return output;
  }
  throw new Error(`unsupported_safetensors_dtype:${normalized}`);
}

function decodeFloat16(value: number): number {
  const sign = (value & 0x8000) >> 15;
  const exponent = (value & 0x7c00) >> 10;
  const fraction = value & 0x03ff;
  if (exponent === 0) {
    if (fraction === 0) {
      return sign ? -0 : 0;
    }
    return (sign ? -1 : 1) * 2 ** (-14) * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? (sign ? -Infinity : Infinity) : Number.NaN;
  }
  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function decodeBFloat16(value: number): number {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(value, 2);
  return buffer.readFloatLE(0);
}

function readConfigNumber(config: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(config[key]);
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function readConfigNumberArray(config: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = config[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const normalized = value
      .map((entry) => readNumber(entry))
      .filter((entry): entry is number => typeof entry === "number" && entry > 0);
    if (normalized.length === 0) {
      continue;
    }
    return Math.max(...normalized);
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function explainExecutableGgufFailure(error: unknown): string {
  const message = String((error as Error)?.message ?? error ?? "unknown");
  if (message.startsWith("gguf_tensor_missing:")) {
    const tensorName = message.slice("gguf_tensor_missing:".length);
    return `CPU reference backend is missing required GGUF tensor '${tensorName}' for decoder-only execution.`;
  }
  if (message.startsWith("unsupported_gguf_tensor_dtype:")) {
    return `CPU reference backend encountered an unsupported GGUF tensor dtype (${message.slice("unsupported_gguf_tensor_dtype:".length)}).`;
  }
  if (message.startsWith("tensor_shape_mismatch:")) {
    const tensorName = message.slice("tensor_shape_mismatch:".length);
    return `CPU reference backend found an unexpected tensor shape for '${tensorName}'.`;
  }
  if (message.startsWith("tensor_dtype_mismatch:")) {
    const tensorName = message.slice("tensor_dtype_mismatch:".length);
    return `CPU reference backend found an unsupported materialized dtype for '${tensorName}'.`;
  }
  if (message.startsWith("hidden_size_must_be_divisible_by_num_heads")) {
    return "GGUF metadata produced an invalid decoder-only head configuration.";
  }
  return `CPU reference backend could not materialize an executable GGUF checkpoint (${message}).`;
}
