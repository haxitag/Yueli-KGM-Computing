import type { CompletionOptions, CompletionResult, CompletionStreamEvent } from "../llm/client.js";
import {
  createNativeServingBackend,
  type NativeServingBackend,
  type NativeServingBackendOptions,
  type SchedulerStats,
} from "./backend.js";
import type { LoadedNativeModel } from "./loaders.js";

export type NativeRuntimeEngineOptions = NativeServingBackendOptions;

export class NativeRuntimeEngine {
  private backend: NativeServingBackend;

  constructor(modelPath: string, options?: NativeRuntimeEngineOptions) {
    this.backend = createNativeServingBackend(modelPath, options);
  }

  get modelPath(): string {
    return this.backend.modelPath;
  }

  isExecutable(): boolean {
    return this.backend.isExecutable();
  }

  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    return this.backend.complete(prompt, options);
  }

  streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    return this.backend.streamComplete(prompt, options);
  }

  metadata(): LoadedNativeModel["metadata"] {
    return this.backend.metadata();
  }

  manifest(): LoadedNativeModel["manifest"] {
    return this.backend.manifest();
  }

  executionBackend(): LoadedNativeModel["executionBackend"] {
    return this.backend.executionBackend();
  }

  servingBackend(): NativeServingBackend["kind"] {
    return this.backend.kind;
  }

  schedulerMetrics(): SchedulerStats {
    return this.backend.schedulerMetrics();
  }
}
