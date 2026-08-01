import { ModelRegistry } from "./registry.js";
import type { ModelRecord, ModelCapabilities } from "./registry.js";
import { generateId } from "../utils/id.js";

export type CapabilityTag = 
  | 'reasoning'           // 推理能力
  | 'generation'          // 生成能力
  | 'coding'             // 编程能力
  | 'math'               // 数学能力
  | 'multimodal'         // 多模态能力
  | 'vision'             // 视觉能力
  | 'audio'              // 音频能力
  | 'translation'        // 翻译能力
  | 'summarization'      // 摘要能力
  | 'qa'                 // 问答能力
  | 'creative'           // 创意能力
  | 'analytical'         // 分析能力
  | 'conversational'     // 对话能力
  | 'function_calling'   // 函数调用能力
  | 'long_context'       // 长上下文能力
  | 'real_time'          // 实时响应能力
  | 'cost_effective'     // 性价比高
  | 'high_accuracy'      // 高精度
  | 'fast'               // 快速响应
  | 'large_knowledge'    // 知识库广泛
  | 'domain_specific';   // 领域特定

export type CapabilityProfile = {
  /** 配置文件ID */
  id: string;
  /** 配置文件名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 需要的能力标签 */
  requiredCapabilities: CapabilityTag[];
  /** 排除的能力标签 */
  excludedCapabilities?: CapabilityTag[];
  /** 最小上下文窗口 */
  minContextWindow?: number;
  /** 是否需要函数调用支持 */
  requiresFunctionCalling?: boolean;
  /** 是否需要多模态支持 */
  requiresMultimodal?: boolean;
  /** 最大延迟要求（毫秒） */
  maxLatencyMs?: number;
  /** 最低成本要求 */
  maxCostPerMillionTokens?: number;
  /** 优先级（数字越小优先级越高） */
  priority?: number;
};

export type SelectionResult = {
  /** 选中的模型 */
  model: ModelRecord;
  /** 匹配的配置文件 */
  profile: CapabilityProfile;
  /** 匹配分数 */
  matchScore: number;
  /** 选择原因 */
  reason: string;
};

export class ModelCapabilitySelector {
  private registry: ModelRegistry;
  private profiles: Map<string, CapabilityProfile> = new Map();

  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  /**
   * 注册能力配置文件
   */
  registerProfile(profile: CapabilityProfile): void {
    this.profiles.set(profile.id, profile);
  }

  /**
   * 移除能力配置文件
   */
  removeProfile(profileId: string): boolean {
    return this.profiles.delete(profileId);
  }

  /**
   * 获取所有配置文件
   */
  getAllProfiles(): CapabilityProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * 根据ID获取配置文件
   */
  getProfile(profileId: string): CapabilityProfile | undefined {
    return this.profiles.get(profileId);
  }

  /**
   * 根据能力需求选择最佳模型
   */
  selectBestModel(profileId: string): SelectionResult | null {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      return null;
    }

    const allModels = this.registry.listEnabled();
    if (allModels.length === 0) {
      return null;
    }

    // 计算每个模型的匹配分数
    const scoredModels = allModels
      .map(model => ({ model, score: this.calculateMatchScore(model, profile) }))
      .filter(item => item.score > 0) // 只保留匹配分数大于0的模型
      .sort((a, b) => b.score - a.score); // 按分数降序排列

    if (scoredModels.length === 0) {
      return null;
    }

    const bestMatch = scoredModels[0];

    return {
      model: bestMatch.model,
      profile,
      matchScore: bestMatch.score,
      reason: this.generateSelectionReason(bestMatch.model, profile)
    };
  }

  /**
   * 根据多个配置文件选择模型（返回满足任一配置文件的最佳模型）
   */
  selectBestModelFromMultiple(profileIds: string[]): SelectionResult | null {
    const results: SelectionResult[] = [];

    for (const profileId of profileIds) {
      const result = this.selectBestModel(profileId);
      if (result) {
        results.push(result);
      }
    }

    if (results.length === 0) {
      return null;
    }

    // 返回匹配分数最高的结果
    return results.reduce((best, current) => 
      current.matchScore > best.matchScore ? current : best
    );
  }

  /**
   * 找到满足特定能力要求的所有模型
   */
  findModelsByCapabilities(capabilities: CapabilityTag[]): ModelRecord[] {
    const allModels = this.registry.listEnabled();
    
    return allModels.filter(model => {
      const modelCaps = model.capabilities;
      return capabilities.every(cap => this.modelHasCapability(modelCaps, cap));
    });
  }

  /**
   * 计算模型与配置文件的匹配分数
   */
  private calculateMatchScore(model: ModelRecord, profile: CapabilityProfile): number {
    let score = 0;
    const caps = model.capabilities;

    // 检查必需的能力
    for (const requiredCap of profile.requiredCapabilities) {
      if (this.modelHasCapability(caps, requiredCap)) {
        score += 10; // 每个匹配的必需能力加10分
      } else {
        return 0; // 有任何必需能力不满足则得0分
      }
    }

    // 检查排除的能力
    if (profile.excludedCapabilities) {
      for (const excludedCap of profile.excludedCapabilities) {
        if (this.modelHasCapability(caps, excludedCap)) {
          return 0; // 有任何排除能力满足则得0分
        }
      }
    }

    // 检查上下文窗口要求
    if (profile.minContextWindow && caps.contextWindow >= profile.minContextWindow) {
      score += 5;
    } else if (profile.minContextWindow && caps.contextWindow < profile.minContextWindow) {
      return 0; // 不满足上下文窗口要求得0分
    }

    // 检查函数调用要求
    if (profile.requiresFunctionCalling && !caps.supportsFunctionCalling) {
      return 0; // 不支持函数调用但要求支持得0分
    } else if (profile.requiresFunctionCalling) {
      score += 5;
    }

    // 检查多模态要求
    if (profile.requiresMultimodal && !caps.supportsMultimodal) {
      return 0; // 不支持多模态但要求支持得0分
    } else if (profile.requiresMultimodal) {
      score += 5;
    }

    // 检查延迟要求
    if (profile.maxLatencyMs && caps.estimatedLatency <= profile.maxLatencyMs) {
      score += 3;
    }

    // 检查成本要求
    const avgCost = (caps.pricing.inputCostPerToken + caps.pricing.outputCostPerToken) / 2 * 1_000_000; // 每百万token成本
    if (profile.maxCostPerMillionTokens && avgCost <= profile.maxCostPerMillionTokens) {
      score += 2;
    }

    // 考虑优先级
    if (profile.priority) {
      score += profile.priority * 0.1; // 优先级对分数的影响较小
    }

    return score;
  }

  /**
   * 检查模型是否具备特定能力
   */
  private modelHasCapability(caps: ModelCapabilities, capability: CapabilityTag): boolean {
    switch (capability) {
      case 'reasoning':
        return caps.purpose === 'reasoning' || caps.purpose === 'general';
      case 'generation':
        return caps.purpose === 'generation' || caps.purpose === 'general';
      case 'coding':
        return caps.purpose === 'coding' || caps.purpose === 'general';
      case 'math':
        return caps.purpose === 'math' || caps.purpose === 'general';
      case 'multimodal':
      case 'vision':
        return caps.supportsMultimodal;
      case 'audio':
        return caps.supportsMultimodal; // 假设支持多模态也支持音频
      case 'translation':
        return caps.purpose === 'general' || caps.purpose === 'generation';
      case 'summarization':
        return caps.purpose === 'general' || caps.purpose === 'generation';
      case 'qa':
        return caps.purpose === 'general' || caps.purpose === 'reasoning';
      case 'creative':
        return caps.purpose === 'generation' || caps.purpose === 'general';
      case 'analytical':
        return caps.purpose === 'reasoning' || caps.purpose === 'general';
      case 'conversational':
        return caps.purpose === 'general';
      case 'function_calling':
        return caps.supportsFunctionCalling;
      case 'long_context':
        return caps.contextWindow > 16000; // 假设超过16K为长上下文
      case 'real_time':
        return caps.estimatedLatency < 1000; // 假设小于1秒为实时
      case 'cost_effective':
        const avgCost = (caps.pricing.inputCostPerToken + caps.pricing.outputCostPerToken) / 2;
        return avgCost < 0.00001; // 假设每token低于此值为性价比高
      case 'high_accuracy':
        return caps.estimatedLatency < 5000; // 假设较低延迟可能意味着更高的准确性
      case 'fast':
        return caps.estimatedLatency < 2000; // 响应时间小于2秒
      case 'large_knowledge':
        return caps.contextWindow > 32000; // 假设更大的上下文窗口意味着知识库更广
      case 'domain_specific':
        return caps.purpose !== 'general'; // 非通用模型视为领域特定
      default:
        return false;
    }
  }

  /**
   * 生成选择原因
   */
  private generateSelectionReason(model: ModelRecord, profile: CapabilityProfile): string {
    const reasons = [`Selected model "${model.config.name}" for profile "${profile.name}"`];
    
    const matchedCaps = profile.requiredCapabilities.filter(cap => 
      this.modelHasCapability(model.capabilities, cap)
    );
    
    if (matchedCaps.length > 0) {
      reasons.push(`Matches required capabilities: ${matchedCaps.join(', ')}`);
    }
    
    if (profile.minContextWindow && model.capabilities.contextWindow >= profile.minContextWindow) {
      reasons.push(`Satisfies context window requirement (${model.capabilities.contextWindow} >= ${profile.minContextWindow})`);
    }
    
    if (profile.requiresFunctionCalling && model.capabilities.supportsFunctionCalling) {
      reasons.push('Supports function calling');
    }
    
    if (profile.requiresMultimodal && model.capabilities.supportsMultimodal) {
      reasons.push('Supports multimodal inputs');
    }
    
    return reasons.join('; ');
  }

  /**
   * 获取模型的能力标签
   */
  getModelCapabilities(modelName: string): CapabilityTag[] | null {
    const model = this.registry.get(modelName);
    if (!model) {
      return null;
    }

    const caps = model.capabilities;
    const capabilities: CapabilityTag[] = [];

    // 根据模型能力推断标签
    if (caps.purpose === 'reasoning') capabilities.push('reasoning');
    if (caps.purpose === 'generation') capabilities.push('generation');
    if (caps.purpose === 'coding') capabilities.push('coding');
    if (caps.purpose === 'math') capabilities.push('math');
    if (caps.supportsMultimodal) capabilities.push('multimodal', 'vision');
    if (caps.supportsFunctionCalling) capabilities.push('function_calling');
    if (caps.contextWindow > 16000) capabilities.push('long_context');
    if (caps.estimatedLatency < 1000) capabilities.push('real_time', 'fast');
    if ((caps.pricing.inputCostPerToken + caps.pricing.outputCostPerToken) / 2 < 0.00001) {
      capabilities.push('cost_effective');
    }
    if (caps.contextWindow > 32000) capabilities.push('large_knowledge');

    // 通用模型通常具备多种能力
    if (caps.purpose === 'general') {
      capabilities.push('translation', 'summarization', 'qa', 'creative', 'analytical', 'conversational');
    }

    return capabilities;
  }

  /**
   * 创建预设的常用配置文件
   */
  createPresetProfiles(): void {
    // 高精度推理配置文件
    this.registerProfile({
      id: 'high_precision_reasoning',
      name: 'High Precision Reasoning',
      description: '适用于需要高精度逻辑推理的任务',
      requiredCapabilities: ['reasoning', 'analytical'],
      requiresFunctionCalling: true,
      minContextWindow: 8000,
      maxLatencyMs: 10000,
      priority: 1
    });

    // 快速响应配置文件
    this.registerProfile({
      id: 'fast_response',
      name: 'Fast Response',
      description: '适用于需要快速响应的任务',
      requiredCapabilities: ['conversational', 'fast'],
      maxLatencyMs: 2000,
      priority: 2
    });

    // 代码生成配置文件
    this.registerProfile({
      id: 'code_generation',
      name: 'Code Generation',
      description: '适用于代码编写和编程任务',
      requiredCapabilities: ['coding', 'generation'],
      minContextWindow: 16000,
      requiresFunctionCalling: true,
      priority: 1
    });

    // 多模态处理配置文件
    this.registerProfile({
      id: 'multimodal_processing',
      name: 'Multimodal Processing',
      description: '适用于处理图像、文本等多种模态的任务',
      requiredCapabilities: ['multimodal', 'vision'],
      requiresMultimodal: true,
      priority: 1
    });

    // 成本优化配置文件
    this.registerProfile({
      id: 'cost_optimized',
      name: 'Cost Optimized',
      description: '适用于成本敏感的应用场景',
      requiredCapabilities: ['cost_effective'],
      maxCostPerMillionTokens: 10, // 每百万token不超过10美元
      priority: 3
    });
  }
}