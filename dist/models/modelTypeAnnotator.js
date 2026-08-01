import { listConfiguredMediaModels } from "../openai/mediaCompat.js";
const CHAT_CAPABILITIES = ["chat"];
export function annotateOpenAiModels(models) {
    return models.map((model) => {
        const existing = (model.kgm ?? {});
        let modelType = "provider-model";
        if (model.id === "auto") {
            modelType = "routing-entry";
        }
        else if (existing.modelType === "media-model" || existing.mediaKind) {
            modelType = "media-model";
        }
        else if (existing.runtime === "native") {
            modelType = "native-loaded";
        }
        else if (existing.cloud || existing.provider || isCloudOwner(model.owned_by)) {
            modelType = "cloud-model";
        }
        const capabilities = Array.isArray(existing.capabilities)
            ? existing.capabilities
            : modelType === "routing-entry"
                ? ["proxy_aggregation", "chat"]
                : modelType === "media-model"
                    ? []
                    : [...CHAT_CAPABILITIES];
        const model_type = typeof existing.model_type === "string"
            ? existing.model_type
            : modelType === "routing-entry"
                ? "proxy_aggregation"
                : modelType === "media-model"
                    ? String(existing.model_type ?? "task_specific")
                    : "chat";
        return {
            ...model,
            kgm: {
                ...existing,
                modelType,
                model_type: existing.model_type ?? model_type,
                capabilities: capabilities.length > 0 ? capabilities : existing.capabilities,
                ...(modelType === "routing-entry" ? { description: "KGM auto routing" } : {}),
                ...(existing.runtime ? { engine: existing.runtime } : {}),
            },
        };
    });
}
/** Append configured media upstream models into an OpenAI model list (before annotate). */
export function appendConfiguredMediaModels(models, configStore) {
    const created = Math.floor(Date.now() / 1000);
    const media = listConfiguredMediaModels(configStore.get());
    const extra = media.map((m) => ({
        id: m.id,
        object: "model",
        created,
        owned_by: "kgm-media",
        kgm: {
            modelType: "media-model",
            model_type: m.model_type,
            capabilities: m.capabilities,
            mediaKind: m.kind,
        },
    }));
    return [...models, ...extra];
}
export function buildEffectiveModels(params) {
    const created = Math.floor(Date.now() / 1000);
    const config = params.configStore.get();
    const data = [
        {
            id: "auto",
            object: "model",
            created,
            owned_by: "kgm",
            kgm: { modelType: "routing-entry", description: "KGM auto routing" },
        },
        {
            id: config.llm.model,
            object: "model",
            created,
            owned_by: config.llm.provider,
            kgm: { modelType: "provider-model", providerId: `${config.llm.provider}-configured`, engine: config.llm.provider },
        },
    ];
    for (const running of params.modelManager?.listRunningModels() ?? []) {
        data.push({
            id: running.modelName,
            object: "model",
            created,
            owned_by: running.runtime ?? "kgm",
            kgm: {
                modelType: running.runtime === "native" ? "native-loaded" : "provider-model",
                providerId: running.runtimeId,
                engine: running.runtime,
            },
        });
    }
    return { object: "list", data: dedupeModels(data) };
}
export function buildRawModels(params) {
    const created = Math.floor(Date.now() / 1000);
    const data = [];
    for (const engine of params.discovery?.engines ?? []) {
        for (const model of engine.models) {
            data.push({
                id: model.id,
                object: "model",
                created,
                owned_by: engine.type,
                kgm: { modelType: "provider-model", providerId: engine.id, engine: engine.type, capabilities: model.capabilities },
            });
        }
    }
    for (const model of params.modelManager?.listModels() ?? []) {
        data.push({
            id: model.modelName,
            object: "model",
            created,
            owned_by: model.runtime ?? model.sourceType ?? "kgm",
            kgm: {
                modelType: model.runtime === "native" && model.running ? "native-loaded" : "provider-model",
                providerId: model.runtimeId ?? model.artifactId,
                engine: model.runtime ?? model.sourceType,
            },
        });
    }
    return { object: "list", data: dedupeModels(data) };
}
function dedupeModels(models) {
    const seen = new Set();
    return models.filter((model) => {
        const id = String(model.id);
        if (seen.has(id))
            return false;
        seen.add(id);
        return true;
    });
}
function isCloudOwner(owner) {
    return typeof owner === "string" && ["openai", "anthropic", "google", "gemini", "moonshot", "deepseek", "qwen", "aliyun", "zhipu", "minimax", "modelscope"].includes(owner);
}
