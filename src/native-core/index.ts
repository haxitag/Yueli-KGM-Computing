import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { CompletionOptions, CompletionResult, CompletionStreamEvent } from "../llm/client.js";
import { createTokenizer } from "../native/tokenizer.js";
import type {
  NativeCoreBindingBackend,
  NativeCoreBindingCreateParams,
  NativeCoreBindingModule,
  NativeCoreBindingSchedulerStats,
} from "../native/bindings.js";
import type { NativeCheckpoint } from "../native/types.js";

type NativeCoreAddonBackend = {
  isExecutable(): boolean;
  submit(payload: {
    prompt: string;
    promptTokens?: number[];
    model?: string;
    requestId?: string;
    sessionId?: string;
    maxTokens?: number;
    temperature?: number;
    topK?: number;
    topP?: number;
    repetitionPenalty?: number;
    stop?: string[];
    seed?: number;
  }): string | number;
  poll(requestId: string | number, maxEvents?: number): CompletionStreamEvent[];
  cancel?(requestId: string | number): void;
  schedulerMetrics?(): NativeCoreBindingSchedulerStats;
  close?(): void;
};

type NativeCoreAddonModule = {
  createBackend(payload: {
    modelPath: string;
    manifest: NativeCoreBindingCreateParams["manifest"];
    metadata: NativeCoreBindingCreateParams["metadata"];
    checkpoint: NativeCheckpoint;
    options?: Record<string, unknown>;
  }): NativeCoreAddonBackend;
};

export function createBackend(params: NativeCoreBindingCreateParams): NativeCoreBindingBackend {
  const checkpoint = params.checkpoint ?? loadKgmJsonCheckpoint(params.modelPath);
  const addon = loadNativeCoreAddon();
  const backend = addon.createBackend({
    modelPath: params.modelPath,
    manifest: params.manifest,
    metadata: params.metadata,
    checkpoint,
    options: params.options,
  });

  return {
    backend: "native-core",
    name: "kgm-native-core-addon",
    isExecutable: () => backend.isExecutable(),
    streamComplete: (prompt: string, options?: CompletionOptions) => streamFromAddonBackend(backend, checkpoint, prompt, options),
    schedulerMetrics: () => backend.schedulerMetrics?.() ?? emptySchedulerStats(),
    close: () => backend.close?.(),
  };
}

async function* streamFromAddonBackend(
  backend: NativeCoreAddonBackend,
  checkpoint: NativeCheckpoint,
  prompt: string,
  options?: CompletionOptions,
): AsyncIterable<CompletionStreamEvent> {
  const tokenizer = createTokenizer(checkpoint.tokenizer);
  const wrapperStops = normalizeStopSequences(options?.stop);
  const delegateStopsToAddon = checkpoint.tokenizer.kind === "character";
  const promptTokens = tokenizer.encode(prompt, {
    addBos: prompt.length === 0 || typeof tokenizer.spec.bosTokenId === "number",
  });
  if (promptTokens.length === 0 && typeof tokenizer.spec.bosTokenId === "number") {
    promptTokens.push(tokenizer.spec.bosTokenId);
  }
  const generatedTokens: number[] = [];
  let emittedText = "";
  const requestId = backend.submit({
    prompt,
    promptTokens,
    model: options?.model,
    requestId: options?.requestId,
    sessionId: options?.sessionId,
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    topK: options?.topK,
    topP: options?.topP,
    repetitionPenalty: options?.repetitionPenalty,
    stop: delegateStopsToAddon ? wrapperStops : undefined,
    seed: options?.seed,
  });

  try {
    while (true) {
      if (options?.signal?.aborted) {
        backend.cancel?.(requestId);
        throw new Error("native_runtime_request_aborted");
      }

      const events = backend.poll(requestId, 16) ?? [];
      if (events.length === 0) {
        await yieldToEventLoop();
        continue;
      }

      for (const event of events) {
        if (event.type === "started") {
          yield {
            type: "started",
            model: event.model,
          };
          continue;
        }
        if (event.type === "token") {
          const previousText = emittedText;
          if (typeof event.tokenId === "number") {
            generatedTokens.push(event.tokenId);
          }
          const decodedText = typeof event.tokenId === "number"
            ? tokenizer.decode(generatedTokens, { skipSpecialTokens: true })
            : `${emittedText}${event.text ?? ""}`;
          const visibleText = !delegateStopsToAddon && wrapperStops.length > 0
            ? truncateAtStop(decodedText, wrapperStops)
            : decodedText;
          const delta = visibleText.slice(previousText.length);
          emittedText = visibleText;
          yield {
            type: "token",
            text: delta,
            index: event.index,
            tokenId: event.tokenId,
          };
          if (!delegateStopsToAddon && wrapperStops.length > 0 && visibleText.length !== decodedText.length) {
            backend.cancel?.(requestId);
            yield {
              type: "finished",
              result: createSyntheticStopResult({
                text: visibleText,
                promptTokens: promptTokens.length,
                generatedTokens: generatedTokens.length,
                requestId: options?.requestId,
                sessionId: options?.sessionId,
              }),
            };
            return;
          }
          continue;
        }
        if (event.type === "finished") {
          const decodedText = generatedTokens.length > 0
            ? tokenizer.decode(generatedTokens, { skipSpecialTokens: true })
            : emittedText;
          const finishedText = !delegateStopsToAddon && wrapperStops.length > 0
            ? truncateAtStop(decodedText, wrapperStops)
            : decodedText;
          yield {
            type: "finished",
            result: normalizeCompletionResult(
              event.result,
              finishedText,
              !delegateStopsToAddon && finishedText.length !== decodedText.length ? "stop" : undefined,
            ),
          };
          return;
        }
        throw new Error(`native_core_addon_unknown_event:${String((event as { type?: unknown }).type)}`);
      }
    }
  } finally {
    if (options?.signal?.aborted) {
      backend.cancel?.(requestId);
    }
  }
}

function normalizeCompletionResult(
  result: CompletionResult,
  text: string,
  finishReason?: "stop",
): CompletionResult {
  const raw = result?.raw && typeof result.raw === "object"
    ? { ...(result.raw as Record<string, unknown>) }
    : {};
  const nativeRuntime = raw.nativeRuntime && typeof raw.nativeRuntime === "object"
    ? { ...(raw.nativeRuntime as Record<string, unknown>) }
    : undefined;
  if (nativeRuntime) {
    nativeRuntime.text = text;
    if (finishReason) {
      nativeRuntime.finishReason = finishReason;
    }
    raw.nativeRuntime = nativeRuntime;
  }
  return {
    text,
    raw,
  };
}

function loadNativeCoreAddon(): NativeCoreAddonModule {
  const require = createRequire(import.meta.url);
  const configured = process.env.KGM_NATIVE_CORE_ADDON?.trim();
  const defaultPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../native-core/build/Release/kgm_native_core.node",
  );
  const addonPath = path.resolve(configured || defaultPath);
  if (!fs.existsSync(addonPath)) {
    throw new Error(`native_core_addon_binary_missing:${addonPath}`);
  }
  const loaded = require(addonPath) as NativeCoreAddonModule;
  if (!loaded || typeof loaded.createBackend !== "function") {
    throw new Error(`native_core_addon_invalid_exports:${addonPath}`);
  }
  return loaded;
}

function loadKgmJsonCheckpoint(modelPath: string): NativeCheckpoint {
  const resolved = path.resolve(modelPath);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return JSON.parse(fs.readFileSync(resolved, "utf8")) as NativeCheckpoint;
  }
  for (const candidate of ["model.kgm.json", "kgm-model.json", "checkpoint.kgm.json"]) {
    const filePath = path.join(resolved, candidate);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as NativeCheckpoint;
    }
  }
  throw new Error(`native_core_addon_checkpoint_not_found:${resolved}`);
}

function emptySchedulerStats(): NativeCoreBindingSchedulerStats {
  return {
    submitted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    cycles: 0,
    prefills: 0,
    decodeSteps: 0,
    peakActive: 0,
    peakQueued: 0,
  };
}

function createSyntheticStopResult(params: {
  text: string;
  promptTokens: number;
  generatedTokens: number;
  requestId?: string;
  sessionId?: string;
}): CompletionResult {
  const nativeRuntime: Record<string, unknown> = {
    text: params.text,
    promptTokens: params.promptTokens,
    prefillTokens: params.promptTokens,
    generatedTokens: params.generatedTokens,
    finishReason: "stop",
    device: "cpu",
    scheduler: {
      servingBackend: "native-core",
      continuousBatching: true,
    },
  };
  if (params.requestId) {
    nativeRuntime.requestId = params.requestId;
  }
  if (params.sessionId) {
    nativeRuntime.sessionId = params.sessionId;
  }
  return {
    text: params.text,
    raw: {
      nativeRuntime,
    },
  };
}

function normalizeStopSequences(value?: string[]): string[] {
  return (value ?? []).filter((entry) => entry.length > 0);
}

function truncateAtStop(value: string, stops: string[]): string {
  const match = findStop(value, stops);
  return match ? value.slice(0, match.index) : value;
}

function findStop(value: string, stops: string[]): { index: number } | null {
  let best: number | null = null;
  for (const stop of stops) {
    const index = value.indexOf(stop);
    if (index !== -1 && (best === null || index < best)) {
      best = index;
    }
  }
  return best === null ? null : { index: best };
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const moduleBinding: NativeCoreBindingModule = {
  kind: "kgm-native-core-binding",
  version: 1,
  createBackend,
};

export default moduleBinding;
