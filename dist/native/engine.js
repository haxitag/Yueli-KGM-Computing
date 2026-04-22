import { createNativeServingBackend, } from "./backend.js";
export class NativeRuntimeEngine {
    backend;
    constructor(modelPath, options) {
        this.backend = createNativeServingBackend(modelPath, options);
    }
    get modelPath() {
        return this.backend.modelPath;
    }
    isExecutable() {
        return this.backend.isExecutable();
    }
    complete(prompt, options) {
        return this.backend.complete(prompt, options);
    }
    streamComplete(prompt, options) {
        return this.backend.streamComplete(prompt, options);
    }
    metadata() {
        return this.backend.metadata();
    }
    manifest() {
        return this.backend.manifest();
    }
    executionBackend() {
        return this.backend.executionBackend();
    }
    servingBackend() {
        return this.backend.kind;
    }
    schedulerMetrics() {
        return this.backend.schedulerMetrics();
    }
}
