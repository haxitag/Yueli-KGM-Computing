import { createNativeServingBackend, } from "../native/backend.js";
export function createBackend(params) {
    const delegated = createNativeServingBackend(params.modelPath, {
        ...params.options,
        servingBackend: "js-reference",
    });
    return new NativeCoreBindingShimBackend(delegated);
}
class NativeCoreBindingShimBackend {
    backend = "native-core";
    name = "native-core-binding-shim";
    delegated;
    constructor(delegated) {
        this.delegated = delegated;
    }
    isExecutable() {
        return this.delegated.isExecutable();
    }
    complete(prompt, options) {
        return this.delegated.complete(prompt, options);
    }
    streamComplete(prompt, options) {
        return this.delegated.streamComplete(prompt, options);
    }
    schedulerMetrics() {
        return this.delegated.schedulerMetrics();
    }
}
const moduleBinding = {
    kind: "kgm-native-core-binding",
    version: 1,
    createBackend,
};
export default moduleBinding;
