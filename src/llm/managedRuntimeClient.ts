import { streamCompletion } from "./client.js";
import type { CompletionOptions, CompletionResult, CompletionStreamEvent, LlmClient } from "./client.js";
import type { ManagedModelManager } from "../models/modelManager.js";

export class ManagedRuntimeLlmClient implements LlmClient {
  private manager: ManagedModelManager;
  private fallback: LlmClient;

  constructor(params: { manager: ManagedModelManager; fallback: LlmClient }) {
    this.manager = params.manager;
    this.fallback = params.fallback;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    if (options?.model) {
      const managed = await this.manager.completeWithManagedRuntime(options.model, prompt, options);
      if (managed) {
        return managed;
      }
    }
    return this.fallback.complete(prompt, options);
  }

  async *streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    if (options?.model) {
      const managed = this.manager.streamWithManagedRuntime(options.model, prompt, options);
      if (managed) {
        yield* managed;
        return;
      }
    }
    yield* streamCompletion(this.fallback, prompt, options);
  }
}
