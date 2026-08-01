import { ModelRegistry } from "./registry.js";
import type { ModelRecord } from "./registry.js";
import type { ContextPack } from "../core/types.js";
import { generateId } from "../utils/id.js";

export type RoutingStrategy = 
  | { type: 'random' } 
  | { type: 'weighted'; weights?: Record<string, number> } 
  | { type: 'quality'; minQualityScore?: number }
  | { type: 'specific'; modelName: string }
  | { type: 'capability'; requiredCapabilities: string[] }
  | { type: 'purpose'; purpose: string }
  | { type: 'cost'; maxCostPerRequest?: number }
  | { type: 'latency'; maxLatencyMs?: number };

export type RouteRequest = {
  context?: ContextPack;
  strategy: RoutingStrategy;
  fallbackToDefault?: boolean;
};

export type RouteResult = {
  model: ModelRecord;
  routeReason: string;
  qualityScore?: number;
};

export class ModelRouter {
  private registry: ModelRegistry;
  
  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  /**
   * 根据策略路由到合适的模型
   */
  route(request: RouteRequest): RouteResult | null {
    const { strategy, fallbackToDefault = true } = request;

    switch (strategy.type) {
      case 'random':
        return this.routeRandom();
      
      case 'weighted':
        return this.routeWeighted(strategy.weights);
      
      case 'quality':
        return this.routeByQuality(strategy.minQualityScore ?? 0.5);
      
      case 'specific':
        return this.routeSpecific(strategy.modelName);
      
      case 'capability':
        return this.routeByCapability(strategy.requiredCapabilities);
      
      case 'purpose':
        return this.routeByPurpose(strategy.purpose);
      
      case 'cost':
        return this.routeByCost(strategy.maxCostPerRequest);
      
      case 'latency':
        return this.routeByLatency(strategy.maxLatencyMs);
      
      default:
        console.warn(`Unknown routing strategy: ${(strategy as any).type}`);
        if (fallbackToDefault) {
          // 返回第一个可用模型作为默认值
          const models = this.registry.listEnabled();
          if (models.length > 0) {
            return {
              model: models[0],
              routeReason: 'fallback_to_default',
            };
          }
        }
        return null;
    }
  }

  /**
   * 随机路由策略
   */
  private routeRandom(): RouteResult | null {
    const models = this.registry.listEnabled();
    if (models.length === 0) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * models.length);
    return {
      model: models[randomIndex],
      routeReason: 'random_selection',
    };
  }

  /**
   * 加权路由策略
   */
  private routeWeighted(weights?: Record<string, number>): RouteResult | null {
    const models = this.registry.listEnabled();
    if (models.length === 0) {
      return null;
    }

    // 如果没有提供权重，则使用模型的默认权重
    if (!weights) {
      // 使用轮询方式，基于权重分配
      let totalWeight = models.reduce((sum, model) => sum + model.weight, 0);
      if (totalWeight <= 0) {
        // 如果所有权重都是0或负数，随机选择
        return this.routeRandom();
      }

      // 使用加权随机选择
      const randomValue = Math.random() * totalWeight;
      let cumulativeWeight = 0;

      for (const model of models) {
        cumulativeWeight += model.weight;
        if (randomValue <= cumulativeWeight) {
          return {
            model,
            routeReason: 'weighted_selection',
          };
        }
      }

      // 如果由于浮点精度问题没有找到模型，返回最后一个
      return {
        model: models[models.length - 1],
        routeReason: 'weighted_selection_fallback',
      };
    }

    // 使用提供的权重
    const availableModels = models.filter(model => weights[model.config.name] !== undefined);
    if (availableModels.length === 0) {
      return this.routeRandom(); // 如果没有匹配的模型，随机选择
    }

    const totalWeight = availableModels.reduce(
      (sum, model) => sum + (weights[model.config.name] ?? 0), 0
    );

    if (totalWeight <= 0) {
      return this.routeRandom();
    }

    const randomValue = Math.random() * totalWeight;
    let cumulativeWeight = 0;

    for (const model of availableModels) {
      const weight = weights[model.config.name] ?? 0;
      cumulativeWeight += weight;
      if (randomValue <= cumulativeWeight) {
        return {
          model,
          routeReason: 'custom_weighted_selection',
        };
      }
    }

    return {
      model: availableModels[availableModels.length - 1],
      routeReason: 'custom_weighted_selection_fallback',
    };
  }

  /**
   * 基于质量评分的路由
   */
  private routeByQuality(minQualityScore: number): RouteResult | null {
    const models = this.registry.listEnabled();
    if (models.length === 0) {
      return null;
    }

    // 这里可以集成实际的质量评分系统
    // 目前我们基于模型的能力和其他指标来估算质量
    const scoredModels = models.map(model => {
      // 简单的质量评分算法 - 实际应用中可以更复杂
      let score = 0.5; // 基础分数

      // 根据上下文窗口大小调整
      if (model.capabilities.contextWindow > 32000) score += 0.2;
      else if (model.capabilities.contextWindow > 16000) score += 0.1;
      else if (model.capabilities.contextWindow < 4000) score -= 0.1;

      // 根据是否支持函数调用调整
      if (model.capabilities.supportsFunctionCalling) score += 0.1;

      // 根据价格调整（便宜的模型在某些场景下可能被认为质量较低）
      const avgPrice = (model.capabilities.pricing.inputCostPerToken + 
                       model.capabilities.pricing.outputCostPerToken) / 2;
      if (avgPrice < 0.000001) score -= 0.05; // 非常便宜的模型
      else if (avgPrice > 0.0001) score += 0.05; // 较贵的模型

      // 根据延迟调整
      if (model.capabilities.estimatedLatency < 1000) score += 0.05; // 快速响应
      else if (model.capabilities.estimatedLatency > 5000) score -= 0.05; // 慢响应

      return { model, score };
    }).filter(item => item.score >= minQualityScore);

    if (scoredModels.length === 0) {
      // 如果没有满足最低质量分数的模型，选择分数最高的
      const allScored = models.map(model => {
        let score = 0.5;
        if (model.capabilities.contextWindow > 32000) score += 0.2;
        else if (model.capabilities.contextWindow > 16000) score += 0.1;
        else if (model.capabilities.contextWindow < 4000) score -= 0.1;
        if (model.capabilities.supportsFunctionCalling) score += 0.1;
        const avgPrice = (model.capabilities.pricing.inputCostPerToken + 
                         model.capabilities.pricing.outputCostPerToken) / 2;
        if (avgPrice < 0.000001) score -= 0.05;
        else if (avgPrice > 0.0001) score += 0.05;
        if (model.capabilities.estimatedLatency < 1000) score += 0.05;
        else if (model.capabilities.estimatedLatency > 5000) score -= 0.05;
        return { model, score };
      }).sort((a, b) => b.score - a.score);

      if (allScored.length > 0) {
        return {
          model: allScored[0].model,
          routeReason: 'quality_fallback_highest_score',
          qualityScore: allScored[0].score,
        };
      }
      return null;
    }

    // 返回最高分的模型
    const best = scoredModels.reduce((prev, current) => 
      (prev.score > current.score) ? prev : current
    );

    return {
      model: best.model,
      routeReason: 'quality_based_selection',
      qualityScore: best.score,
    };
  }

  /**
   * 指定模型路由
   */
  private routeSpecific(modelName: string): RouteResult | null {
    const model = this.registry.get(modelName);
    if (!model || !model.enabled) {
      return null;
    }

    return {
      model,
      routeReason: `specific_model_request_${modelName}`,
    };
  }

  /**
   * 基于能力要求的路由
   */
  private routeByCapability(requiredCapabilities: string[]): RouteResult | null {
    // 这里我们将能力要求映射到模型能力
    // 在实际应用中，这可能需要更复杂的映射
    const models = this.registry.listEnabled();

    // 检查每个模型是否满足所有要求的能力
    for (const model of models) {
      let meetsAllRequirements = true;

      for (const capability of requiredCapabilities) {
        switch (capability.toLowerCase()) {
          case 'function_calling':
          case 'functions':
            if (!model.capabilities.supportsFunctionCalling) {
              meetsAllRequirements = false;
            }
            break;
          case 'multimodal':
          case 'vision':
            if (!model.capabilities.supportsMultimodal) {
              meetsAllRequirements = false;
            }
            break;
          case 'large_context':
            if (model.capabilities.contextWindow < 16000) {
              meetsAllRequirements = false;
            }
            break;
          case 'fast_response':
            if (model.capabilities.estimatedLatency > 2000) {
              meetsAllRequirements = false;
            }
            break;
          default:
            console.warn(`Unknown capability requirement: ${capability}`);
            break;
        }

        if (!meetsAllRequirements) {
          break; // 不满足某个要求，跳出内层循环
        }
      }

      if (meetsAllRequirements) {
        return {
          model,
          routeReason: `capability_based_selection_${requiredCapabilities.join('_')}`,
        };
      }
    }

    return null;
  }

  /**
   * 基于用途的路由
   */
  private routeByPurpose(purpose: string): RouteResult | null {
    const models = this.registry.getByPurpose(purpose as any);
    if (models.length === 0) {
      return null;
    }

    // 返回第一个匹配的模型
    return {
      model: models[0],
      routeReason: `purpose_based_selection_${purpose}`,
    };
  }

  /**
   * 基于成本的路由
   */
  private routeByCost(maxCostPerRequest?: number): RouteResult | null {
    const models = this.registry.listEnabled();
    if (models.length === 0) {
      return null;
    }

    if (maxCostPerRequest === undefined) {
      // 如果没有指定最大成本，返回最经济的模型
      const sorted = models.sort((a, b) => {
        const costA = (a.capabilities.pricing.inputCostPerToken + a.capabilities.pricing.outputCostPerToken) / 2;
        const costB = (b.capabilities.pricing.inputCostPerToken + b.capabilities.pricing.outputCostPerToken) / 2;
        return costA - costB;
      });
      return {
        model: sorted[0],
        routeReason: 'cost_optimized_selection',
      };
    }

    // 查找满足成本要求的模型
    for (const model of models) {
      const avgCost = (model.capabilities.pricing.inputCostPerToken + 
                      model.capabilities.pricing.outputCostPerToken) / 2;
      if (avgCost <= maxCostPerRequest) {
        return {
          model,
          routeReason: `cost_constrained_selection_${maxCostPerRequest}`,
        };
      }
    }

    return null;
  }

  /**
   * 基于延迟的路由
   */
  private routeByLatency(maxLatencyMs?: number): RouteResult | null {
    const models = this.registry.listEnabled();
    if (models.length === 0) {
      return null;
    }

    if (maxLatencyMs === undefined) {
      // 如果没有指定最大延迟，返回最快的模型
      const sorted = models.sort((a, b) => 
        a.capabilities.estimatedLatency - b.capabilities.estimatedLatency
      );
      return {
        model: sorted[0],
        routeReason: 'latency_optimized_selection',
      };
    }

    // 查找满足延迟要求的模型
    for (const model of models) {
      if (model.capabilities.estimatedLatency <= maxLatencyMs) {
        return {
          model,
          routeReason: `latency_constrained_selection_${maxLatencyMs}ms`,
        };
      }
    }

    return null;
  }

  /**
   * 添加A/B测试路由策略
   */
  routeForAbTest(modelA: string, modelB: string, ratio: number = 0.5): RouteResult | null {
    // ratio是选择modelA的概率
    const random = Math.random();
    const selectedModel = random < ratio ? modelA : modelB;
    
    return this.route({ 
      strategy: { type: 'specific', modelName: selectedModel },
      fallbackToDefault: true
    });
  }

  /**
   * 添加负载均衡路由策略
   */
  routeLoadBalanced(): RouteResult | null {
    return this.routeWeighted();
  }
}