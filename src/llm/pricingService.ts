import type { ModelPricingConfig } from "../core/configStore.js";

export interface PricingService {
  getPricing(model: string, provider?: string): Promise<ModelPricingConfig | undefined>;
  warmup(): Promise<void>;
}

export class StaticPricingService implements PricingService {
  private overrides: Record<string, ModelPricingConfig>;
  private defaultPricing: ModelPricingConfig;

  constructor(defaultPricing: ModelPricingConfig, overrides: Record<string, ModelPricingConfig>) {
    this.defaultPricing = defaultPricing;
    this.overrides = overrides;
  }

  async getPricing(model: string, provider?: string): Promise<ModelPricingConfig | undefined> {
    const keys = [
      provider ? `${provider}:${model}` : undefined,
      provider ? `${provider}:*` : undefined,
      `model:${model}`,
    ].filter((k): k is string => Boolean(k));

    for (const key of keys) {
      const found = this.overrides[key];
      if (found) {
        return found;
      }
    }
    // No match → undefined so AutoRouting.resolvePricing can apply routeKey / managed:* / default:openai:* overrides
    return undefined;
  }

  async warmup(): Promise<void> {
  }
}

export class DynamicPricingService implements PricingService {
  private staticCache: StaticPricingService;
  private cache = new Map<string, { pricing: ModelPricingConfig; timestamp: number }>();
  private cacheTtlMs: number;

  constructor(
    defaultPricing: ModelPricingConfig,
    overrides: Record<string, ModelPricingConfig>,
    cacheTtlMs: number = 300000,
  ) {
    this.staticCache = new StaticPricingService(defaultPricing, overrides);
    this.cacheTtlMs = cacheTtlMs;
  }

  async getPricing(model: string, provider?: string): Promise<ModelPricingConfig | undefined> {
    const cacheKey = provider ? `${provider}:${model}` : model;
    
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.pricing;
    }

    try {
      const dynamicPricing = await this.fetchDynamicPricing(model, provider);
      if (dynamicPricing) {
        this.cache.set(cacheKey, { pricing: dynamicPricing, timestamp: Date.now() });
        return dynamicPricing;
      }
    } catch (error) {
      console.warn(`Failed to fetch dynamic pricing for ${provider}:${model}:`, error);
    }

    const staticPricing = await this.staticCache.getPricing(model, provider);
    if (staticPricing) {
      return staticPricing;
    }
    // Fall through to AutoRouting key table when static has no override match
    return undefined;
  }

  async warmup(): Promise<void> {
    const popularModels = [
      { model: "gpt-4o-mini", provider: "openai" },
      { model: "gpt-4o", provider: "openai" },
      { model: "gpt-4", provider: "openai" },
      { model: "gpt-3.5-turbo", provider: "openai" },
      { model: "claude-3-sonnet", provider: "anthropic" },
      { model: "claude-3-opus", provider: "anthropic" },
      { model: "claude-3-haiku", provider: "anthropic" },
      { model: "glm-4", provider: "zhipu" },
      { model: "glm-4-plus", provider: "zhipu" },
      { model: "kimi-2.5", provider: "moonshot" },
      { model: "kimi-pro", provider: "moonshot" },
    ];
    await Promise.all(popularModels.map(({ model, provider }) => this.getPricing(model, provider)));
  }

  private async fetchDynamicPricing(model: string, provider?: string): Promise<ModelPricingConfig | undefined> {
    const providerName = provider?.toLowerCase() || "openai";
    
    switch (providerName) {
      case "openai":
        return this.fetchOpenAIPricing(model);
      case "anthropic":
        return this.fetchAnthropicPricing(model);
      case "zhipu":
        return this.fetchZhipuPricing(model);
      case "moonshot":
        return this.fetchMoonshotPricing(model);
      default:
        return undefined;
    }
  }

  private async fetchOpenAIPricing(model: string): Promise<ModelPricingConfig | undefined> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable not set for dynamic pricing");
    }

    const url = "https://api.openai.com/v1/models";
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const modelData = data.data?.find((m: any) => m.id.toLowerCase() === model.toLowerCase());
    
    if (!modelData) {
      return this.getOpenAIFallbackPricing(model);
    }

    return this.getOpenAIFallbackPricing(model);
  }

  private getOpenAIFallbackPricing(model: string): ModelPricingConfig | undefined {
    const prices: Record<string, { input: number; output: number }> = {
      "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
      "gpt-4o": { input: 0.005, output: 0.015 },
      "gpt-4o-2024-08-06": { input: 0.0025, output: 0.01 },
      "gpt-4-turbo": { input: 0.01, output: 0.03 },
      "gpt-4": { input: 0.03, output: 0.06 },
      "gpt-3.5-turbo": { input: 0.0015, output: 0.002 },
      "gpt-3.5-turbo-16k": { input: 0.003, output: 0.004 },
      "text-embedding-3-small": { input: 0.0001, output: 0 },
      "text-embedding-3-large": { input: 0.0006, output: 0 },
    };
    const price = prices[model.toLowerCase()];
    if (price) {
      return {
        inputPer1kTokens: price.input,
        outputPer1kTokens: price.output,
        currency: "USD",
      };
    }
    return undefined;
  }

  private async fetchAnthropicPricing(model: string): Promise<ModelPricingConfig | undefined> {
    const url = "https://api.anthropic.com/v1/models";
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    const response = await fetch(url, {
      headers: {
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
    });

    if (!response.ok) {
      return this.getAnthropicFallbackPricing(model);
    }

    const data = await response.json();
    const modelData = data.data?.find((m: any) => m.name.toLowerCase() === model.toLowerCase());
    
    if (!modelData) {
      return this.getAnthropicFallbackPricing(model);
    }

    return this.getAnthropicFallbackPricing(model);
  }

  private getAnthropicFallbackPricing(model: string): ModelPricingConfig | undefined {
    const prices: Record<string, { input: number; output: number }> = {
      "claude-3-sonnet": { input: 0.003, output: 0.015 },
      "claude-3-opus": { input: 0.015, output: 0.075 },
      "claude-3-haiku": { input: 0.00025, output: 0.00125 },
      "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
      "claude-2": { input: 0.008, output: 0.024 },
      "claude-2.1": { input: 0.008, output: 0.024 },
    };
    const price = prices[model.toLowerCase()];
    if (price) {
      return {
        inputPer1kTokens: price.input,
        outputPer1kTokens: price.output,
        currency: "USD",
      };
    }
    return undefined;
  }

  private async fetchZhipuPricing(model: string): Promise<ModelPricingConfig | undefined> {
    return this.getZhipuFallbackPricing(model);
  }

  private getZhipuFallbackPricing(model: string): ModelPricingConfig | undefined {
    const prices: Record<string, { input: number; output: number }> = {
      "glm-4": { input: 0.0005, output: 0.0005 },
      "glm-4-plus": { input: 0.001, output: 0.001 },
      "glm-4-air": { input: 0.00012, output: 0.00012 },
      "glm-3-turbo": { input: 0.00012, output: 0.00012 },
      "embedding-2": { input: 0.00005, output: 0 },
    };
    const price = prices[model.toLowerCase()];
    if (price) {
      return {
        inputPer1kTokens: price.input,
        outputPer1kTokens: price.output,
        currency: "USD",
      };
    }
    return undefined;
  }

  private async fetchMoonshotPricing(model: string): Promise<ModelPricingConfig | undefined> {
    return this.getMoonshotFallbackPricing(model);
  }

  private getMoonshotFallbackPricing(model: string): ModelPricingConfig | undefined {
    const prices: Record<string, { input: number; output: number }> = {
      "kimi-2.5": { input: 0.0005, output: 0.0005 },
      "kimi-pro": { input: 0.001, output: 0.001 },
      "kimi-max": { input: 0.002, output: 0.002 },
    };
    const price = prices[model.toLowerCase()];
    if (price) {
      return {
        inputPer1kTokens: price.input,
        outputPer1kTokens: price.output,
        currency: "USD",
      };
    }
    return undefined;
  }
}

export function createPricingService(
  defaultPricing: ModelPricingConfig,
  overrides: Record<string, ModelPricingConfig>,
): PricingService {
  const useDynamic = process.env.KGM_DYNAMIC_PRICING === "1" || process.env.KGM_DYNAMIC_PRICING === "true";
  if (useDynamic) {
    return new DynamicPricingService(defaultPricing, overrides);
  }
  return new StaticPricingService(defaultPricing, overrides);
}