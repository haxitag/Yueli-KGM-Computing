import path from "node:path";
import { LlmProviderFactory } from "./providerFactory.js";
import { ProviderConfigurationManager } from "../models/providerConfigManager.js";
export class ProviderRoutedLlmClient {
    fallback;
    providerConfigPath;
    strict;
    forcedProviderType;
    manager;
    loadPromise;
    loaded = false;
    constructor(params) {
        this.fallback = params.fallback;
        this.providerConfigPath = params.providerConfigPath ?? process.env.KGM_PROVIDER_CONFIG_PATH ?? "config/model-providers.json";
        this.strict = params.strict ?? parseBool(process.env.KGM_PROVIDER_ROUTING_STRICT);
        this.forcedProviderType = params.forcedProviderType;
    }
    async complete(prompt, options) {
        if (!this.isRoutingEnabled()) {
            return this.fallback.complete(prompt, options);
        }
        await this.ensureLoaded();
        const provider = this.selectProvider(prompt, options);
        if (!provider) {
            return this.fallback.complete(prompt, options);
        }
        try {
            const client = LlmProviderFactory.createClient(provider.config);
            const result = await client.complete(prompt, {
                ...options,
                model: options?.model ?? provider.config.model,
            });
            return {
                text: result.text,
                raw: {
                    providerRouting: {
                        enabled: true,
                        reason: provider.reason,
                        provider: provider.config.type,
                        model: provider.config.model,
                        configPath: this.providerConfigPath,
                    },
                    result: result.raw,
                },
            };
        }
        catch (error) {
            if (this.strict) {
                throw error;
            }
            const fallback = await this.fallback.complete(prompt, options);
            return {
                text: fallback.text,
                raw: {
                    providerRouting: {
                        enabled: true,
                        reason: provider.reason,
                        provider: provider.config.type,
                        model: provider.config.model,
                        configPath: this.providerConfigPath,
                        fallback: "kgm_llm_config",
                        error: String(error),
                    },
                    result: fallback.raw,
                },
            };
        }
    }
    isRoutingEnabled() {
        return parseBool(process.env.KGM_PROVIDER_ROUTING_ENABLED) || Boolean(process.env.KGM_PROVIDER_CONFIG_PATH);
    }
    async ensureLoaded() {
        if (this.loaded) {
            return;
        }
        if (!this.loadPromise) {
            this.loadPromise = (async () => {
                const resolvedPath = path.resolve(this.providerConfigPath);
                this.manager = new ProviderConfigurationManager(resolvedPath);
                await this.manager.loadConfiguration();
                this.manager.updateFromEnvironment();
                this.loaded = true;
            })();
        }
        await this.loadPromise;
    }
    selectProvider(prompt, options) {
        if (!this.manager) {
            return null;
        }
        const activeProviders = this.manager.getActiveProviderConfigs();
        if (activeProviders.length === 0) {
            return null;
        }
        if (options?.model) {
            const exactModel = activeProviders.find((provider) => provider.model === options.model);
            if (exactModel) {
                return {
                    config: exactModel,
                    reason: "requested_model_match",
                };
            }
        }
        const requestedProvider = this.forcedProviderType ?? process.env.KGM_PROVIDER_FORCE_TYPE;
        if (requestedProvider) {
            const forced = activeProviders.find((provider) => provider.type === requestedProvider);
            if (forced) {
                return {
                    config: forced,
                    reason: "forced_provider_type",
                };
            }
        }
        const routingInput = extractRoutingInput(prompt);
        const selected = this.manager.getBestProviderForTask(routingInput);
        if (!selected) {
            return null;
        }
        return {
            config: selected,
            reason: routingInput === prompt ? "task_prompt_match" : "task_input_match",
        };
    }
}
function extractRoutingInput(prompt) {
    const inputMatch = prompt.match(/"input":\s*"([^"]+)"/);
    if (inputMatch?.[1]) {
        return inputMatch[1];
    }
    const latestConversationMatch = prompt.match(/"conversation":\s*\[(.*?)\]/s);
    if (!latestConversationMatch?.[1]) {
        return prompt;
    }
    const userContents = Array.from(latestConversationMatch[1].matchAll(/"role":\s*"user"[\s\S]*?"content":\s*"([^"]+)"/g));
    const latest = userContents.at(-1)?.[1];
    return latest ?? prompt;
}
function parseBool(value) {
    if (!value) {
        return false;
    }
    return value === "1" || value.toLowerCase() === "true";
}
