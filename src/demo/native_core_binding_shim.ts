import type { CompletionOptions, CompletionResult, CompletionStreamEvent } from "../llm/client.js";
import {
  createNativeServingBackend,
  type NativeServingBackend,
  type NativeServingBackendOptions,
} from "../native/backend.js";
import type { NativeCoreBindingBackend, NativeCoreBindingCreateParams, NativeCoreBindingModule } from "../native/bindings.js";

export function createBackend(params: NativeCoreBindingCreateParams): NativeCoreBindingBackend {
  const delegated = createNativeServingBackend(params.modelPath, {
    ...(params.options as NativeServingBackendOptions | undefined),
    servingBackend: "js-reference",
  });
  return new NativeCoreBindingShimBackend(delegated);
}

class NativeCoreBindingShimBackend implements NativeCoreBindingBackend {
  readonly backend = "native-core" as const;
  readonly name = "native-core-binding-shim";
  private delegated: NativeServingBackend;

  constructor(delegated: NativeServingBackend) {
    this.delegated = delegated;
  }

  isExecutable(): boolean {
    return this.delegated.isExecutable();
  }

  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    return this.delegated.complete(prompt, options);
  }

  streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    return this.delegated.streamComplete(prompt, options);
  }

  schedulerMetrics() {
    return this.delegated.schedulerMetrics();
  }
}

const moduleBinding: NativeCoreBindingModule = {
  kind: "kgm-native-core-binding",
  version: 1,
  createBackend,
};

export default moduleBinding;
