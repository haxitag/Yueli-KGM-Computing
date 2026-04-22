import { streamCompletion } from "./client.js";
export class ManagedRuntimeLlmClient {
    manager;
    fallback;
    constructor(params) {
        this.manager = params.manager;
        this.fallback = params.fallback;
    }
    async complete(prompt, options) {
        if (options?.model) {
            const managed = await this.manager.completeWithManagedRuntime(options.model, prompt, options);
            if (managed) {
                return managed;
            }
        }
        return this.fallback.complete(prompt, options);
    }
    async *streamComplete(prompt, options) {
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
