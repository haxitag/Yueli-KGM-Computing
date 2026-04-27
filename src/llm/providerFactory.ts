import { 
  ZhipuLlmClient, 
  MinimaxLlmClient, 
  OpenRouterLlmClient, 
  NvidiaLlmClient, 
  DeepSeekLlmClient, 
  OllamaLlmClient, 
  VllmLlmClient, 
  SlangLlmClient,
  XiaomiLlmClient,
  GeminiLlmClient,
  AnthropicLlmClient,
  AliyunLlmClient,
  ModelScopeLlmClient,
  MoonshotLlmClient,
} from "./third-party.js";
import { HttpLlmClient } from "./client.js";
import type { LlmClient } from "./client.js";
import { ApiKeyRouter, globalApiKeyRouter } from "../utils/apiKeyRouter.js";

export type ProviderType = 
  | 'openai'
  | 'zhipu' 
  | 'minimax'
  | 'openrouter'
  | 'nvidia'
  | 'deepseek'
  | 'xiaomi'
  | 'gemini'
  | 'anthropic'
  | 'aliyun'
  | 'modelscope'
  | 'moonshot'
  | 'ollama'
  | 'vllm'
  | 'slang'
  | 'custom';

export type ProviderConfig = {
  type: ProviderType;
  baseUrl?: string;
  model: string;
  apiKey?: string;
  apiKeys?: string[];  
  keyStrategy?: 'round-robin' | 'least-used' | 'random' | 'priority';
  timeoutMs?: number;
  extraParams?: Record<string, unknown>;
};

export class LlmProviderFactory {
  /**
   * 选择 API Key（支持多 Key 路由）
   */
  private static selectApiKey(
    config: ProviderConfig,
    provider: string
  ): string | null {
    if (config.apiKeys && config.apiKeys.length > 0) {
      globalApiKeyRouter.registerProvider(
        provider,
        config.apiKeys,
        config.keyStrategy || 'round-robin'
      );
      return globalApiKeyRouter.getNextKey(provider);
    }
    return config.apiKey || null;
  }

  static createClient(config: ProviderConfig): LlmClient {
    // 默认URL配置
    const defaultUrls = {
      zhipu: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      minimax: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
      openrouter: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      nvidia: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      xiaomi: process.env.XIAOMI_BASE_URL || 'https://api.xiaomi.ai/v1',
      ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/api',
      vllm: process.env.VLLM_BASE_URL || 'http://localhost:8000/v1',
      slang: process.env.SLANG_BASE_URL || 'http://localhost:7860/v1',
      openai: process.env.KGM_LLM_BASE_URL || 'https://api.openai.com/v1',
    };

    switch (config.type) {
      case 'zhipu':
        if (!config.apiKey && !config.apiKeys) {
          throw new Error('Zhipu API key is required');
        }
        const zhipuApiKey = this.selectApiKey(config, 'zhipu');
        if (!zhipuApiKey) {
          throw new Error('Zhipu API key is required');
        }
        return new ZhipuLlmClient({
          baseUrl: config.baseUrl || defaultUrls.zhipu,
          model: config.model,
          apiKey: zhipuApiKey,
        });

      case 'minimax': {
        const minimaxApiKey = this.selectApiKey(config, 'minimax');
        if (!minimaxApiKey || !config.extraParams?.groupId) {
          throw new Error('Minimax API key and group ID are required');
        }
        return new MinimaxLlmClient({
          baseUrl: config.baseUrl || defaultUrls.minimax,
          model: config.model,
          apiKey: minimaxApiKey,
          groupId: config.extraParams.groupId as string,
        });
      }

      case 'openrouter': {
        const openRouterApiKey = this.selectApiKey(config, 'openrouter');
        if (!openRouterApiKey) {
          throw new Error('OpenRouter API key is required');
        }
        return new OpenRouterLlmClient({
          baseUrl: config.baseUrl || defaultUrls.openrouter,
          model: config.model,
          apiKey: openRouterApiKey,
        });
      }

      case 'nvidia': {
        const nvidiaApiKey = this.selectApiKey(config, 'nvidia');
        if (!nvidiaApiKey) {
          throw new Error('NVIDIA API key is required');
        }
        return new NvidiaLlmClient({
          baseUrl: config.baseUrl || defaultUrls.nvidia,
          model: config.model,
          apiKey: nvidiaApiKey,
        });
      }

      case 'deepseek': {
        const deepSeekApiKey = this.selectApiKey(config, 'deepseek');
        if (!deepSeekApiKey) {
          throw new Error('DeepSeek API key is required');
        }
        return new DeepSeekLlmClient({
          baseUrl: config.baseUrl || defaultUrls.deepseek,
          model: config.model,
          apiKey: deepSeekApiKey,
        });
      }

      case 'xiaomi':
        if (!config.apiKey) {
          throw new Error('Xiaomi API key is required');
        }
        return new XiaomiLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
        });

      case 'gemini':
        if (!config.apiKey) {
          throw new Error('Gemini API key is required');
        }
        return new GeminiLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
          useOpenAIFormat: config.extraParams?.useOpenAIFormat as boolean,
        });

      case 'anthropic': {
        const apiKey = this.selectApiKey(config, 'anthropic');
        if (!apiKey) {
          throw new Error('Anthropic API key is required');
        }
        return new AnthropicLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: apiKey,
          timeoutMs: config.timeoutMs,
        });
      }

      case 'aliyun': {
        const apiKey = this.selectApiKey(config, 'aliyun');
        if (!apiKey) {
          throw new Error('Aliyun API key is required');
        }
        return new AliyunLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: apiKey,
          timeoutMs: config.timeoutMs,
        });
      }

      case 'modelscope': {
        const apiKey = this.selectApiKey(config, 'modelscope');
        if (!apiKey) {
          throw new Error('ModelScope API key is required');
        }
        return new ModelScopeLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: apiKey,
          timeoutMs: config.timeoutMs,
        });
      }

      case 'moonshot': {
        const apiKey = this.selectApiKey(config, 'moonshot');
        if (!apiKey) {
          throw new Error('Moonshot API key is required');
        }
        return new MoonshotLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: apiKey,
          timeoutMs: config.timeoutMs,
        });
      }

      case 'ollama':
        return new OllamaLlmClient({
          baseUrl: config.baseUrl || defaultUrls.ollama,
          model: config.model,
        });

      case 'vllm':
        return new VllmLlmClient({
          baseUrl: config.baseUrl || defaultUrls.vllm,
          model: config.model,
          apiKey: config.apiKey,
        });

      case 'slang':
        return new SlangLlmClient({
          baseUrl: config.baseUrl || defaultUrls.slang,
          model: config.model,
          apiKey: config.apiKey,
        });

      case 'openai':
      case 'custom':
      default:
        // 使用默认的HttpLlmClient
        return new HttpLlmClient({
          baseUrl: config.baseUrl || defaultUrls.openai,
          model: config.model,
          apiKey: config.apiKey,
          path: config.extraParams?.path as string || '/chat/completions',
          mode: (config.extraParams?.mode as 'chat' | 'completions') || 'chat',
        });
    }
  }

  /**
   * 从环境变量创建配置
   */
  static createConfigFromEnv(provider: ProviderType): ProviderConfig | null {
    switch (provider) {
      case 'zhipu':
        const zhipuApiKey = process.env.ZHIPU_API_KEY;
        if (!zhipuApiKey) return null;
        return {
          type: 'zhipu',
          baseUrl: process.env.ZHIPU_BASE_URL,
          model: process.env.ZHIPU_DEFAULT_MODEL || 'glm-4',
          apiKey: zhipuApiKey,
        };

      case 'minimax':
        const minimaxApiKey = process.env.MINIMAX_API_KEY;
        const minimaxGroupId = process.env.MINIMAX_GROUP_ID;
        if (!minimaxApiKey || !minimaxGroupId) return null;
        return {
          type: 'minimax',
          baseUrl: process.env.MINIMAX_BASE_URL,
          model: process.env.MINIMAX_DEFAULT_MODEL || 'abab6.5-chat',
          apiKey: minimaxApiKey,
          extraParams: { groupId: minimaxGroupId },
        };

      case 'openrouter':
        const openRouterApiKey = process.env.OPENROUTER_API_KEY;
        if (!openRouterApiKey) return null;
        return {
          type: 'openrouter',
          baseUrl: process.env.OPENROUTER_BASE_URL,
          model: process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4-turbo',
          apiKey: openRouterApiKey,
        };

      case 'nvidia':
        const nvidiaApiKey = process.env.NVIDIA_API_KEY;
        const nvidiaBaseUrl = process.env.NVIDIA_BASE_URL;
        if (!nvidiaApiKey || !nvidiaBaseUrl) return null;
        return {
          type: 'nvidia',
          baseUrl: nvidiaBaseUrl,
          model: process.env.NVIDIA_DEFAULT_MODEL || 'meta/llama3-70b-instruct',
          apiKey: nvidiaApiKey,
        };

      case 'deepseek':
        const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        if (!deepSeekApiKey) return null;
        return {
          type: 'deepseek',
          baseUrl: process.env.DEEPSEEK_BASE_URL,
          model: process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat',
          apiKey: deepSeekApiKey,
        };

      case 'xiaomi':
        const xiaomiApiKey = process.env.XIAOMI_API_KEY;
        if (!xiaomiApiKey) return null;
        return {
          type: 'xiaomi',
          baseUrl: process.env.XIAOMI_BASE_URL,
          model: process.env.XIAOMI_DEFAULT_MODEL || 'mimo-2.5',
          apiKey: xiaomiApiKey,
        };

      case 'gemini':
        const geminiApiKey = process.env.GEMINI_API_KEY;
        if (!geminiApiKey) return null;
        return {
          type: 'gemini',
          baseUrl: process.env.GEMINI_BASE_URL,
          model: process.env.GEMINI_DEFAULT_MODEL || 'gemini-3.0',
          apiKey: geminiApiKey,
          extraParams: {
            useOpenAIFormat: process.env.GEMINI_USE_OPENAI_FORMAT === 'true',
          },
        };

      case 'anthropic':
        const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
        if (!anthropicApiKey) return null;
        return {
          type: 'anthropic',
          baseUrl: process.env.ANTHROPIC_BASE_URL,
          model: process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4.6',
          apiKey: anthropicApiKey,
        };

      case 'aliyun':
        const aliyunApiKey = process.env.ALIYUN_API_KEY;
        if (!aliyunApiKey) return null;
        return {
          type: 'aliyun',
          baseUrl: process.env.ALIYUN_BASE_URL,
          model: process.env.ALIYUN_DEFAULT_MODEL || 'qwen-max',
          apiKey: aliyunApiKey,
        };

      case 'modelscope':
        const modelscopeApiKey = process.env.MODELSCOPE_API_KEY;
        if (!modelscopeApiKey) return null;
        return {
          type: 'modelscope',
          baseUrl: process.env.MODELSCOPE_BASE_URL,
          model: process.env.MODELSCOPE_DEFAULT_MODEL || 'deepseek-r1',
          apiKey: modelscopeApiKey,
        };

      case 'ollama':
        const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
        if (!ollamaBaseUrl) return null;
        return {
          type: 'ollama',
          baseUrl: ollamaBaseUrl,
          model: process.env.OLLAMA_DEFAULT_MODEL || 'llama3',
        };

      case 'vllm':
        const vllmBaseUrl = process.env.VLLM_BASE_URL;
        if (!vllmBaseUrl) return null;
        return {
          type: 'vllm',
          baseUrl: vllmBaseUrl,
          model: process.env.VLLM_DEFAULT_MODEL || 'meta-llama/Llama-2-7b-hf',
          apiKey: process.env.VLLM_API_KEY,
        };

      case 'slang': {
        const slangBaseUrl = process.env.SLANG_BASE_URL;
        if (!slangBaseUrl) return null;
        return {
          type: 'slang',
          baseUrl: slangBaseUrl,
          model: process.env.SLANG_DEFAULT_MODEL || 'default',
        };
      }

      default:
        return null;
    }
  }

  /**
   * 获取支持的 providers 列表
   */
  static getSupportedProviders(): ProviderType[] {
    return [
      'zhipu',
      'minimax',
      'openrouter',
      'nvidia',
      'deepseek',
      'xiaomi',
      'gemini',
      'anthropic',
      'aliyun',
      'modelscope',
      'moonshot',
      'ollama',
      'vllm',
      'slang',
      'custom'
    ];
  }

  /**
   * 验证配置是否完整
   */
  static validateConfig(config: ProviderConfig): boolean {
    switch (config.type) {
      case 'zhipu':
        return !!config.apiKey;
      case 'minimax':
        return !!config.apiKey && !!config.extraParams?.groupId;
      case 'openrouter':
      case 'nvidia':
      case 'deepseek':
      case 'xiaomi':
      case 'gemini':
      case 'anthropic':
      case 'aliyun':
      case 'modelscope':
        return !!config.apiKey;
      case 'ollama':
      case 'vllm':
      case 'slang':
        return !!config.baseUrl;
      default:
        return !!config.model;
    }
  }
}