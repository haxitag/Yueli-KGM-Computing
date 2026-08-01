import type { LlmClient } from "../llm/client.js";
import { HttpLlmClient } from "../llm/client.js";

export type ModelProvider = "openai" | "anthropic" | "google" | "custom";

export type ModelCapabilities = {
  /** 模型名称 */
  name: string;
  /** 模型提供商 */
  provider: ModelProvider;
  /** 上下文窗口大小 */
  contextWindow: number;
  /** 最大输出token数 */
  maxOutputTokens: number;
  /** 是否支持函数调用 */
  supportsFunctionCalling: boolean;
  /** 是否支持多模态 */
  supportsMultimodal: boolean;
  /** 主要用途 */
  purpose: "reasoning" | "generation" | "coding" | "math" | "multimodal" | "general";
  /** 价格信息 */
  pricing: {
    inputCostPerToken: number;
    outputCostPerToken: number;
  };
  /** 延迟估计（毫秒） */
  estimatedLatency: number;
};

export type ModelConfig = {
  /** 模型名称 */
  name: string;
  /** API基础URL */
  baseUrl: string;
  /** API密钥 */
  apiKey?: string;
  /** 模型路径 */
  path?: string;
  /** 模型模式：completions 或 chat */
  mode?: "completions" | "chat";
  /** 额外参数 */
  extraParams?: Record<string, unknown>;
};

export type ModelRecord = {
  config: ModelConfig;
  capabilities: ModelCapabilities;
  client: LlmClient;
  /** 模型是否启用 */
  enabled: boolean;
  /** 模型权重（用于负载均衡） */
  weight: number;
};

export class ModelRegistry {
  private models = new Map<string, ModelRecord>();

  /**
   * 注册模型
   */
  register(modelConfig: ModelConfig, capabilities: ModelCapabilities): void {
    const client = new HttpLlmClient({
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.name,
      path: modelConfig.path,
      apiKey: modelConfig.apiKey,
      mode: modelConfig.mode ?? "chat",
    });

    const record: ModelRecord = {
      config: modelConfig,
      capabilities,
      client,
      enabled: true,
      weight: 1, // 默认权重为1
    };

    this.models.set(modelConfig.name, record);
  }

  /**
   * 获取模型记录
   */
  get(name: string): ModelRecord | undefined {
    return this.models.get(name);
  }

  /**
   * 获取启用的模型列表
   */
  listEnabled(): ModelRecord[] {
    return Array.from(this.models.values()).filter(model => model.enabled);
  }

  /**
   * 获取特定用途的模型
   */
  getByPurpose(purpose: ModelCapabilities["purpose"]): ModelRecord[] {
    return Array.from(this.models.values())
      .filter(model => model.capabilities.purpose === purpose && model.enabled);
  }

  /**
   * 获取支持特定功能的模型
   */
  getByCapability(capability: keyof Omit<ModelCapabilities, 'name' | 'provider' | 'purpose'>): ModelRecord[] {
    return Array.from(this.models.values())
      .filter(model => {
        const caps = model.capabilities;
        switch (capability) {
          case 'supportsFunctionCalling':
            return caps.supportsFunctionCalling;
          case 'supportsMultimodal':
            return caps.supportsMultimodal;
          default:
            return true;
        }
      })
      .filter(model => model.enabled);
  }

  /**
   * 启用/禁用模型
   */
  setEnabled(name: string, enabled: boolean): boolean {
    const model = this.models.get(name);
    if (!model) {
      return false;
    }
    model.enabled = enabled;
    return true;
  }

  /**
   * 设置模型权重
   */
  setWeight(name: string, weight: number): boolean {
    const model = this.models.get(name);
    if (!model) {
      return false;
    }
    model.weight = Math.max(0, weight); // 权重不能为负
    return true;
  }

  /**
   * 根据能力查询最佳匹配模型
   */
  findBestMatch(requirements: Partial<ModelCapabilities>): ModelRecord | null {
    const candidates = Array.from(this.models.values())
      .filter(model => model.enabled);

    if (candidates.length === 0) {
      return null;
    }

    // 根据要求筛选模型
    const filtered = candidates.filter(model => {
      const caps = model.capabilities;
      return (
        (!requirements.purpose || caps.purpose === requirements.purpose) &&
        (!requirements.supportsFunctionCalling || caps.supportsFunctionCalling === requirements.supportsFunctionCalling) &&
        (!requirements.supportsMultimodal || caps.supportsMultimodal === requirements.supportsMultimodal) &&
        (!requirements.contextWindow || caps.contextWindow >= requirements.contextWindow)
      );
    });

    if (filtered.length === 0) {
      return null;
    }

    // 返回第一个匹配的模型（可以根据其他指标进行更复杂的排序）
    return filtered[0];
  }
}