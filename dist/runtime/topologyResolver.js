import { inferModelCapabilities } from "./discoveryService.js";
export function resolveRuntimeTopology(params) {
    const config = params.configStore.get();
    const configuredProvider = providerFromConfig(config.llm.provider, config.llm.baseUrl, config.llm.model);
    const discovered = params.discovery?.engines ?? [];
    const providers = mergeProviders([configuredProvider, ...discovered]);
    const running = params.modelManager?.listRunningModels() ?? [];
    for (const model of running) {
        providers.push({
            id: model.runtimeId ?? model.id,
            type: model.runtime === "ollama" ? "ollama" : model.runtime === "llama.cpp" ? "llama.cpp" : "openai-compat",
            baseUrl: model.baseUrl ?? "",
            healthy: true,
            models: [{ id: model.modelName, capabilities: inferModelCapabilities(model.modelName) }],
        });
    }
    const selectedProvider = providers.find((provider) => provider.models.some((model) => model.id === config.llm.model)) ?? providers[0];
    const selectedRouteKey = selectedProvider ? routeKey(selectedProvider.type, config.llm.model) : "";
    const routes = providers.flatMap((provider) => provider.models
        .filter((model) => model.capabilities.includes("chat") || model.capabilities.includes("reasoning"))
        .map((model) => ({
        key: routeKey(provider.type, model.id),
        providerId: provider.id,
        model: model.id,
        weight: model.id === config.llm.model ? 1 : 0.5,
        healthy: provider.healthy,
    })));
    const nativeModels = running.filter((item) => item.runtime === "native").map((item) => item.modelName);
    return {
        paths: {
            llmProvider: {
                enabled: Boolean(config.llm.provider && config.llm.baseUrl && config.llm.model),
                healthy: Boolean(config.llm.provider !== "openai" || config.llm.apiKey),
                selectedRouteKey,
            },
            modelRouting: {
                enabled: config.autoRouting.enabled,
                candidateCount: routes.length,
            },
            native: {
                enabled: nativeModels.length > 0,
                loadedModels: nativeModels,
            },
        },
        providers: dedupeProviders(providers),
        routes,
    };
}
function providerFromConfig(provider, baseUrl, model) {
    const type = provider === "ollama" ? "ollama" : "openai-compat";
    return {
        id: `${provider || "configured"}-configured`,
        type,
        baseUrl,
        healthy: Boolean(provider !== "openai" || process.env.KGM_LLM_API_KEY),
        models: [{ id: model, capabilities: inferModelCapabilities(model) }],
    };
}
function mergeProviders(providers) {
    const byId = new Map();
    for (const provider of providers) {
        const existing = byId.get(provider.id);
        if (!existing) {
            byId.set(provider.id, provider);
            continue;
        }
        const models = new Map(existing.models.map((model) => [model.id, model]));
        for (const model of provider.models) {
            models.set(model.id, model);
        }
        existing.models = Array.from(models.values());
        existing.healthy = existing.healthy || provider.healthy;
    }
    return Array.from(byId.values());
}
function dedupeProviders(providers) {
    return mergeProviders(providers).filter((provider) => provider.baseUrl || provider.models.length > 0);
}
function routeKey(provider, model) {
    return `default:${provider}:${model}`;
}
