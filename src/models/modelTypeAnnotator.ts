import type { ConfigStore } from "../core/configStore.js";
import type { ManagedModelManager } from "./modelManager.js";
import type { DiscoveryResult } from "../runtime/discoveryService.js";

export type KgmModelType = "routing-entry" | "provider-model" | "native-loaded" | "cloud-model";

export function annotateOpenAiModels(models: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return models.map((model) => {
    const existing = (model.kgm ?? {}) as Record<string, unknown>;
    let modelType: KgmModelType = "provider-model";
    if (model.id === "auto") {
      modelType = "routing-entry";
    } else if (existing.runtime === "native") {
      modelType = "native-loaded";
    } else if (existing.cloud || existing.provider || isCloudOwner(model.owned_by)) {
      modelType = "cloud-model";
    }
    return {
      ...model,
      kgm: {
        ...existing,
        modelType,
        ...(modelType === "routing-entry" ? { description: "KGM auto routing" } : {}),
        ...(existing.runtime ? { engine: existing.runtime } : {}),
      },
    };
  });
}

export function buildEffectiveModels(params: {
  configStore: ConfigStore;
  modelManager?: ManagedModelManager;
  discovery?: DiscoveryResult;
}): { object: "list"; data: Array<Record<string, unknown>> } {
  const created = Math.floor(Date.now() / 1000);
  const config = params.configStore.get();
  const data: Array<Record<string, unknown>> = [
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

export function buildRawModels(params: {
  configStore: ConfigStore;
  modelManager?: ManagedModelManager;
  discovery?: DiscoveryResult;
}): { object: "list"; data: Array<Record<string, unknown>> } {
  const created = Math.floor(Date.now() / 1000);
  const data: Array<Record<string, unknown>> = [];
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

function dedupeModels(models: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return models.filter((model) => {
    const id = String(model.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isCloudOwner(owner: unknown): boolean {
  return typeof owner === "string" && ["openai", "anthropic", "google", "gemini", "moonshot", "deepseek", "qwen", "aliyun", "zhipu", "minimax", "modelscope"].includes(owner);
}
