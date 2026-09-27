import { 
  MinimaxLlmClient, 
  OllamaLlmClient, 
  GeminiLlmClient,
  AnthropicLlmClient,
} from "./third-party.js";
import { HttpLlmClient, inferLlmAuthStyle } from "./client.js";
import type { LlmClient } from "./client.js";
import { ApiKeyRouter, globalApiKeyRouter } from "../utils/apiKeyRouter.js";

/** Official Xiaomi MiMo OpenAPI (pay-as-you-go). Token Plan uses token-plan-cn.xiaomimimo.com. */
export const MIMO_OPENAI_BASE_URL = "https://api.xiaomimimo.com/v1";
export const MIMO_ANTHROPIC_BASE_URL = "https://api.xiaomimimo.com/anthropic";
export const MIMO_TOKEN_PLAN_OPENAI_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
export const MIMO_DEFAULT_CHAT_MODEL = "mimo-v2.5-pro";

/** OpenAI-compat gateway preferred for tools/stream (Phase H). */
export function wantsOpenAiCompatProvider(
  config: { baseUrl?: string; extraParams?: Record<string, unknown> },
  kind: "anthropic" | "gemini" | "ollama",
): boolean {
  if (config.extraParams?.useOpenAIFormat === true || config.extraParams?.openaiCompat === true) {
    return true;
  }
  if (kind === "anthropic") {
    return Boolean(process.env.ANTHROPIC_OPENAI_COMPAT_BASE_URL?.trim());
  }
  if (kind === "gemini") {
    return Boolean(process.env.GEMINI_OPENAI_BASE_URL?.trim());
  }
  if (kind === "ollama") {
    return Boolean(process.env.OLLAMA_OPENAI_BASE?.trim() || config.extraParams?.openaiBase);
  }
  return false;
}

/** Whether AutoRouting may safely forward tools to this provider type/config. */
export function providerSupportsTools(
  type: string,
  config?: { baseUrl?: string; extraParams?: Record<string, unknown>; model?: string },
): boolean {
  switch (type) {
    case "anthropic":
      return wantsOpenAiCompatProvider(config ?? {}, "anthropic");
    case "gemini":
      return wantsOpenAiCompatProvider(config ?? {}, "gemini") || config?.extraParams?.useOpenAIFormat === true;
    case "ollama":
      return wantsOpenAiCompatProvider(config ?? {}, "ollama");
    case "minimax":
      return (
        config?.extraParams?.useOpenAIFormat === true ||
        Boolean(config?.model && /^minimax-/i.test(config.model))
      );
    default:
      return true;
  }
}

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
  | 'aliyun_bailian'
  | 'baidu_qianfan'
  | 'volcengine_ark'
  | 'aws_bedrock'
  | 'azure_openai'
  | 'groq'
  | 'together'
  | 'fireworks'
  | 'perplexity'
  | 'mistral'
  | 'huggingface'
  | 'koboldcpp'
  | 'text_generation_webui'
  /** LM Studio 本地 OpenAI 兼容服务，默认 http://127.0.0.1:1234/v1 */
  | 'lmstudio'
  /** Apple MLX / vMLX 等本机 OpenAI 兼容 HTTP 端点，默认见 env */
  | 'vmlx'
  /** antirez/ds4 (ds4-server)，默认 http://127.0.0.1:8090/v1 */
  | 'ds4'
  /** llama.cpp llama-server，默认 http://127.0.0.1:8080/v1 */
  | 'llama_cpp'
  | 'modelscope'
  | 'moonshot'
  | 'ollama'
  | 'vllm'
  | 'sglang'
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

  /**
   * OpenAI `/v1/chat/completions` 兼容上游（阅粒 yueli-deck LLMservice 思路：长尾云走统一 HTTP 形）。
   * 强签名（Bedrock SigV4、Azure AD 等）需在网关或专用 adapter 中消化后再指向此处。
   */
  private static createOpenAiCompatHttp(
    config: ProviderConfig,
    spec: { routerKey: string; defaultBaseUrl: string; requireApiKey?: boolean }
  ): LlmClient {
    const requireKey = spec.requireApiKey !== false;
    const apiKey = this.selectApiKey(config, spec.routerKey) ?? config.apiKey ?? null;
    if (requireKey && !apiKey) {
      throw new Error(`${spec.routerKey}: API key is required (configure apiKey / apiKeys or env)`);
    }
    return new HttpLlmClient({
      baseUrl: config.baseUrl || spec.defaultBaseUrl,
      model: config.model,
      apiKey: apiKey || undefined,
      path: (config.extraParams?.path as string) || '/chat/completions',
      mode: (config.extraParams?.mode as 'chat' | 'completions') || 'chat',
      timeoutMs: config.timeoutMs,
      authStyle: inferLlmAuthStyle(
        config.baseUrl || spec.defaultBaseUrl,
        config.extraParams?.authStyle,
      ),
    });
  }

  static createClient(config: ProviderConfig): LlmClient {
    // 默认URL配置
    const defaultUrls = {
      zhipu: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      minimax: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
      openrouter: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      nvidia: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      xiaomi:
        process.env.MIMO_BASE_URL ||
        process.env.XIAOMI_BASE_URL ||
        MIMO_OPENAI_BASE_URL,
      ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/api',
      vllm: process.env.VLLM_BASE_URL || 'http://localhost:8000/v1',
      sglang: process.env.SGLANG_BASE_URL || 'http://localhost:7860/v1',
      openai: process.env.KGM_LLM_BASE_URL || 'https://api.openai.com/v1',
    };

    switch (config.type) {
      case 'zhipu':
        if (!config.apiKey && !config.apiKeys) {
          throw new Error('Zhipu API key is required');
        }
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'zhipu',
          defaultBaseUrl: defaultUrls.zhipu,
        });

      case 'minimax': {
        const minimaxApiKey = this.selectApiKey(config, 'minimax');
        const useOpenAi =
          config.extraParams?.useOpenAIFormat === true ||
          /^minimax-/i.test(config.model);
        if (useOpenAi) {
          if (!minimaxApiKey) {
            throw new Error('Minimax API key is required');
          }
          return this.createOpenAiCompatHttp(config, {
            routerKey: 'minimax',
            defaultBaseUrl: config.baseUrl || 'https://api.minimaxi.com/v1',
          });
        }
        if (!minimaxApiKey || !config.extraParams?.groupId) {
          throw new Error('Minimax API key and group ID are required (or set extraParams.useOpenAIFormat for OpenAI-compat models)');
        }
        return new MinimaxLlmClient({
          baseUrl: config.baseUrl || defaultUrls.minimax,
          model: config.model,
          apiKey: minimaxApiKey,
          groupId: config.extraParams.groupId as string,
        });
      }

      case 'openrouter': {
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'openrouter',
          defaultBaseUrl: defaultUrls.openrouter,
        });
      }

      case 'nvidia': {
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'nvidia',
          defaultBaseUrl: defaultUrls.nvidia,
        });
      }

      case 'deepseek': {
        const deepSeekApiKey = this.selectApiKey(config, 'deepseek');
        if (!deepSeekApiKey) {
          throw new Error('DeepSeek API key is required');
        }
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'deepseek',
          defaultBaseUrl: defaultUrls.deepseek,
        });
      }

      case 'xiaomi':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'xiaomi',
          defaultBaseUrl: defaultUrls.xiaomi,
        });

      case 'gemini': {
        if (!config.apiKey) {
          throw new Error('Gemini API key is required');
        }
        if (wantsOpenAiCompatProvider(config, 'gemini')) {
          return this.createOpenAiCompatHttp(config, {
            routerKey: 'gemini',
            defaultBaseUrl:
              config.baseUrl ||
              process.env.GEMINI_OPENAI_BASE_URL ||
              'https://generativelanguage.googleapis.com/v1beta/openai',
          });
        }
        return new GeminiLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
          useOpenAIFormat: config.extraParams?.useOpenAIFormat as boolean,
        });
      }

      case 'anthropic': {
        const apiKey = this.selectApiKey(config, 'anthropic');
        if (!apiKey) {
          throw new Error('Anthropic API key is required');
        }
        if (wantsOpenAiCompatProvider(config, 'anthropic')) {
          return this.createOpenAiCompatHttp(config, {
            routerKey: 'anthropic',
            defaultBaseUrl:
              config.baseUrl ||
              process.env.ANTHROPIC_OPENAI_COMPAT_BASE_URL ||
              process.env.ANTHROPIC_BASE_URL ||
              'https://api.anthropic.com/v1',
          });
        }
        return new AnthropicLlmClient({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: apiKey,
          timeoutMs: config.timeoutMs,
        });
      }

      case 'aliyun': {
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'aliyun',
          defaultBaseUrl:
            config.baseUrl ||
            process.env.ALIYUN_BASE_URL ||
            'https://dashscope.aliyuncs.com/compatible-mode/v1',
        });
      }

      case 'modelscope': {
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'modelscope',
          defaultBaseUrl:
            config.baseUrl ||
            process.env.MODELSCOPE_BASE_URL ||
            'https://api-inference.modelscope.cn/v1',
        });
      }

      case 'moonshot': {
        const apiKey = this.selectApiKey(config, 'moonshot');
        if (!apiKey) {
          throw new Error('Moonshot API key is required');
        }
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'moonshot',
          defaultBaseUrl: config.baseUrl || 'https://api.moonshot.cn/v1',
        });
      }

      case 'ollama': {
        const openaiBase =
          (typeof config.extraParams?.openaiBase === 'string' && config.extraParams.openaiBase.trim()) ||
          process.env.OLLAMA_OPENAI_BASE?.trim() ||
          undefined;
        if (openaiBase || config.extraParams?.useOpenAIFormat === true) {
          return this.createOpenAiCompatHttp(
            { ...config, baseUrl: openaiBase || config.baseUrl || 'http://127.0.0.1:11434/v1' },
            {
              routerKey: 'ollama',
              defaultBaseUrl: openaiBase || 'http://127.0.0.1:11434/v1',
              requireApiKey: false,
            },
          );
        }
        return new OllamaLlmClient({
          baseUrl: config.baseUrl || defaultUrls.ollama,
          model: config.model,
        });
      }

      case 'vllm':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'vllm',
          defaultBaseUrl: defaultUrls.vllm,
          requireApiKey: false,
        });

      case 'sglang':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'sglang',
          defaultBaseUrl: defaultUrls.sglang,
          requireApiKey: false,
        });

      /** 阿里百炼 OpenAI 兼容模式 */
      case 'aliyun_bailian':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'aliyun_bailian',
          defaultBaseUrl: process.env.ALIYUN_BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        });

      /** 百度千帆 OpenAI 兼容 */
      case 'baidu_qianfan':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'baidu_qianfan',
          defaultBaseUrl: process.env.BAIDU_QIANFAN_BASE_URL || 'https://qianfan.baidubce.com/v2',
        });

      /** 火山方舟 OpenAI 兼容 */
      case 'volcengine_ark':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'volcengine_ark',
          defaultBaseUrl: process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
        });

      /** 经 OpenAI 兼容网关访问 Bedrock；原生 SigV4 另做 adapter */
      case 'aws_bedrock': {
        const base =
          config.baseUrl ||
          process.env.BEDROCK_OPENAI_COMPAT_BASE_URL ||
          process.env.AWS_BEDROCK_OPENAI_BASE_URL;
        if (!base) {
          throw new Error(
            'aws_bedrock: set `baseUrl` or env `BEDROCK_OPENAI_COMPAT_BASE_URL` / `AWS_BEDROCK_OPENAI_BASE_URL` to an OpenAI-compatible HTTP proxy in front of Bedrock.'
          );
        }
        return this.createOpenAiCompatHttp(
          { ...config, baseUrl: base },
          { routerKey: 'aws_bedrock', defaultBaseUrl: base }
        );
      }

      /** Azure OpenAI：请把 `baseUrl` 设为 deployment 根路径（含 resource），或设置 `AZURE_OPENAI_BASE_URL` */
      case 'azure_openai': {
        const base =
          config.baseUrl ||
          process.env.AZURE_OPENAI_BASE_URL ||
          process.env.AZURE_OPENAI_ENDPOINT;
        if (!base) {
          throw new Error(
            'azure_openai: set `baseUrl` or `AZURE_OPENAI_BASE_URL` to your Azure OpenAI OpenAI-compatible host (per deployment docs).'
          );
        }
        return this.createOpenAiCompatHttp(
          { ...config, baseUrl: base },
          { routerKey: 'azure_openai', defaultBaseUrl: base }
        );
      }

      case 'groq':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'groq',
          defaultBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
        });

      case 'together':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'together',
          // Together 官方 OpenAI 兼容层已统一为 api.together.ai（旧 xyz 域名仍可由 env 覆盖）
          defaultBaseUrl: process.env.TOGETHER_BASE_URL || 'https://api.together.ai/v1',
        });

      case 'fireworks':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'fireworks',
          defaultBaseUrl: process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1',
        });

      case 'perplexity':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'perplexity',
          defaultBaseUrl: process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai',
        });

      case 'mistral':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'mistral',
          defaultBaseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
        });

      /** Hugging Face：请使用提供 OpenAI 兼容 Chat 的 Router/自建代理 URL */
      case 'huggingface': {
        const base =
          config.baseUrl ||
          process.env.HF_OPENAI_COMPAT_BASE_URL ||
          process.env.HUGGINGFACE_OPENAI_BASE_URL;
        if (!base) {
          throw new Error(
            'huggingface: set `baseUrl` or `HF_OPENAI_COMPAT_BASE_URL` to an OpenAI-compatible inference endpoint.'
          );
        }
        return this.createOpenAiCompatHttp(
          { ...config, baseUrl: base },
          { routerKey: 'huggingface', defaultBaseUrl: base }
        );
      }

      /** KoboldCpp OpenAI 兼容模式默认端口 */
      case 'koboldcpp':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'koboldcpp',
          defaultBaseUrl: process.env.KOBOLDCPP_OPENAI_BASE_URL || 'http://127.0.0.1:5001/v1',
          requireApiKey: false,
        });

      /** oobabooga Text Generation WebUI OpenAI 扩展 */
      case 'text_generation_webui':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'text_generation_webui',
          defaultBaseUrl: process.env.TEXTGEN_WEBUI_OPENAI_BASE_URL || 'http://127.0.0.1:5000/v1',
          requireApiKey: false,
        });

      /** LM Studio 本地 Server（OpenAI 兼容） */
      case 'lmstudio':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'lmstudio',
          defaultBaseUrl: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
          requireApiKey: false,
        });

      /** MLX / vMLX 等本机 OpenAI 兼容 HTTP 服务（端口以实际为准） */
      case 'vmlx':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'vmlx',
          defaultBaseUrl: process.env.VMLX_BASE_URL || 'http://127.0.0.1:8080/v1',
          requireApiKey: false,
        });

      /** antirez/ds4 ds4-server（DeepSeek V4 / GLM 专用） */
      case 'ds4':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'ds4',
          defaultBaseUrl:
            process.env.DS4_BASE_URL ||
            process.env.KGM_DS4_BASE_URL ||
            `http://127.0.0.1:${process.env.KGM_DS4_PORT || '8090'}/v1`,
          requireApiKey: false,
        });

      /** llama.cpp llama-server OpenAI 兼容 */
      case 'llama_cpp':
        return this.createOpenAiCompatHttp(config, {
          routerKey: 'llama_cpp',
          defaultBaseUrl:
            process.env.LLAMA_CPP_BASE_URL ||
            process.env.KGM_LLAMA_CPP_BASE_URL ||
            'http://127.0.0.1:8080/v1',
          requireApiKey: false,
        });

      case 'openai':
      case 'custom':
        return new HttpLlmClient({
          baseUrl: config.baseUrl || defaultUrls.openai,
          model: config.model,
          apiKey: config.apiKey,
          path: (config.extraParams?.path as string) || '/chat/completions',
          mode: (config.extraParams?.mode as 'chat' | 'completions') || 'chat',
          timeoutMs: config.timeoutMs,
          authStyle: inferLlmAuthStyle(
            config.baseUrl || defaultUrls.openai,
            config.extraParams?.authStyle,
          ),
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

      case 'xiaomi': {
        const xiaomiApiKey =
          process.env.MIMO_API_KEY ||
          process.env.XIAOMI_API_KEY ||
          process.env.MIMO_TOKEN_PLAN_API_KEY;
        if (!xiaomiApiKey) return null;
        const useTokenPlan =
          process.env.MIMO_USE_TOKEN_PLAN === "1" ||
          process.env.MIMO_USE_TOKEN_PLAN === "true";
        return {
          type: 'xiaomi',
          baseUrl:
            process.env.MIMO_BASE_URL ||
            process.env.XIAOMI_BASE_URL ||
            (useTokenPlan ? MIMO_TOKEN_PLAN_OPENAI_BASE_URL : MIMO_OPENAI_BASE_URL),
          model:
            process.env.MIMO_DEFAULT_MODEL ||
            process.env.XIAOMI_DEFAULT_MODEL ||
            MIMO_DEFAULT_CHAT_MODEL,
          apiKey: xiaomiApiKey,
          extraParams: {
            authStyle: "both",
            path: "/chat/completions",
            mode: "chat",
          },
        };
      }

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

      case 'sglang': {
        const sglangBaseUrl = process.env.SGLANG_BASE_URL;
        if (!sglangBaseUrl) return null;
        return {
          type: 'sglang',
          baseUrl: sglangBaseUrl,
          model: process.env.SGLANG_DEFAULT_MODEL || 'default',
          apiKey: process.env.SGLANG_API_KEY,
        };
      }

      case 'moonshot': {
        const moonKey = process.env.MOONSHOT_API_KEY;
        if (!moonKey) return null;
        return {
          type: 'moonshot',
          baseUrl: process.env.MOONSHOT_BASE_URL,
          model: process.env.MOONSHOT_DEFAULT_MODEL || 'moonshot-v1-8k',
          apiKey: moonKey,
        };
      }

      case 'aliyun_bailian': {
        const k = process.env.ALIYUN_BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY;
        if (!k) return null;
        return {
          type: 'aliyun_bailian',
          baseUrl: process.env.ALIYUN_BAILIAN_BASE_URL,
          model: process.env.ALIYUN_BAILIAN_DEFAULT_MODEL || 'qwen-plus',
          apiKey: k,
        };
      }

      case 'baidu_qianfan': {
        const k = process.env.BAIDU_QIANFAN_API_KEY;
        if (!k) return null;
        return {
          type: 'baidu_qianfan',
          baseUrl: process.env.BAIDU_QIANFAN_BASE_URL,
          model: process.env.BAIDU_QIANFAN_DEFAULT_MODEL || 'ernie-4.0-8k',
          apiKey: k,
        };
      }

      case 'volcengine_ark': {
        const k = process.env.VOLCENGINE_ARK_API_KEY;
        if (!k) return null;
        return {
          type: 'volcengine_ark',
          baseUrl: process.env.VOLCENGINE_ARK_BASE_URL,
          model: process.env.VOLCENGINE_ARK_DEFAULT_MODEL || 'ep-20240501000000-example',
          apiKey: k,
        };
      }

      case 'groq': {
        const k = process.env.GROQ_API_KEY;
        if (!k) return null;
        return {
          type: 'groq',
          baseUrl: process.env.GROQ_BASE_URL,
          model: process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile',
          apiKey: k,
        };
      }

      case 'together': {
        const k = process.env.TOGETHER_API_KEY;
        if (!k) return null;
        return {
          type: 'together',
          baseUrl: process.env.TOGETHER_BASE_URL,
          model: process.env.TOGETHER_DEFAULT_MODEL || 'meta-llama/Llama-3-70b-chat-hf',
          apiKey: k,
        };
      }

      case 'fireworks': {
        const k = process.env.FIREWORKS_API_KEY;
        if (!k) return null;
        return {
          type: 'fireworks',
          baseUrl: process.env.FIREWORKS_BASE_URL,
          model: process.env.FIREWORKS_DEFAULT_MODEL || 'accounts/fireworks/models/llama-v3p1-70b-instruct',
          apiKey: k,
        };
      }

      case 'perplexity': {
        const k = process.env.PERPLEXITY_API_KEY;
        if (!k) return null;
        return {
          type: 'perplexity',
          baseUrl: process.env.PERPLEXITY_BASE_URL,
          model: process.env.PERPLEXITY_DEFAULT_MODEL || 'sonar',
          apiKey: k,
        };
      }

      case 'mistral': {
        const k = process.env.MISTRAL_API_KEY;
        if (!k) return null;
        return {
          type: 'mistral',
          baseUrl: process.env.MISTRAL_BASE_URL,
          model: process.env.MISTRAL_DEFAULT_MODEL || 'mistral-large-latest',
          apiKey: k,
        };
      }

      case 'huggingface': {
        const base = process.env.HF_OPENAI_COMPAT_BASE_URL || process.env.HUGGINGFACE_OPENAI_BASE_URL;
        const k = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY;
        if (!base || !k) return null;
        return {
          type: 'huggingface',
          baseUrl: base,
          model: process.env.HF_DEFAULT_MODEL || 'meta-llama/Meta-Llama-3-8B-Instruct',
          apiKey: k,
        };
      }

      case 'koboldcpp': {
        const base = process.env.KOBOLDCPP_OPENAI_BASE_URL || 'http://127.0.0.1:5001/v1';
        return {
          type: 'koboldcpp',
          baseUrl: base,
          model: process.env.KOBOLDCPP_DEFAULT_MODEL || 'kobold',
        };
      }

      case 'text_generation_webui': {
        const base = process.env.TEXTGEN_WEBUI_OPENAI_BASE_URL || 'http://127.0.0.1:5000/v1';
        return {
          type: 'text_generation_webui',
          baseUrl: base,
          model: process.env.TEXTGEN_WEBUI_DEFAULT_MODEL || 'gpt-3.5-turbo',
          apiKey: process.env.TEXTGEN_WEBUI_API_KEY,
        };
      }

      case 'lmstudio': {
        const base = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
        return {
          type: 'lmstudio',
          baseUrl: base,
          model: process.env.LMSTUDIO_DEFAULT_MODEL || 'local-model',
          apiKey: process.env.LMSTUDIO_API_KEY,
        };
      }

      case 'vmlx': {
        const base = process.env.VMLX_BASE_URL || 'http://127.0.0.1:8080/v1';
        return {
          type: 'vmlx',
          baseUrl: base,
          model: process.env.VMLX_DEFAULT_MODEL || 'mlx-local',
          apiKey: process.env.VMLX_API_KEY,
        };
      }

      case 'ds4': {
        const port = process.env.KGM_DS4_PORT || '8090';
        const base =
          process.env.DS4_BASE_URL ||
          process.env.KGM_DS4_BASE_URL ||
          `http://127.0.0.1:${port}/v1`;
        return {
          type: 'ds4',
          baseUrl: base,
          model: process.env.DS4_DEFAULT_MODEL || process.env.KGM_DS4_DEFAULT_MODEL || 'ds4-local',
          apiKey: process.env.DS4_API_KEY,
        };
      }

      case 'llama_cpp': {
        const base =
          process.env.LLAMA_CPP_BASE_URL ||
          process.env.KGM_LLAMA_CPP_BASE_URL ||
          'http://127.0.0.1:8080/v1';
        return {
          type: 'llama_cpp',
          baseUrl: base,
          model: process.env.LLAMA_CPP_DEFAULT_MODEL || 'local-model',
          apiKey: process.env.LLAMA_CPP_API_KEY,
        };
      }

      case 'aws_bedrock': {
        const base =
          process.env.BEDROCK_OPENAI_COMPAT_BASE_URL || process.env.AWS_BEDROCK_OPENAI_BASE_URL;
        if (!base) return null;
        return {
          type: 'aws_bedrock',
          baseUrl: base,
          model: process.env.AWS_BEDROCK_DEFAULT_MODEL || 'anthropic.claude-3-sonnet-20240229-v1:0',
          apiKey: process.env.AWS_BEDROCK_OPENAI_API_KEY,
        };
      }

      case 'azure_openai': {
        const base = process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_ENDPOINT;
        const k = process.env.AZURE_OPENAI_API_KEY;
        if (!base || !k) return null;
        return {
          type: 'azure_openai',
          baseUrl: base,
          model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
          apiKey: k,
        };
      }

      case 'openai': {
        const k = process.env.OPENAI_API_KEY || process.env.KGM_LLM_API_KEY;
        if (!k) return null;
        return {
          type: 'openai',
          baseUrl: process.env.OPENAI_BASE_URL || process.env.KGM_LLM_BASE_URL,
          model: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o-mini',
          apiKey: k,
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
      'openai',
      'zhipu',
      'minimax',
      'openrouter',
      'nvidia',
      'deepseek',
      'xiaomi',
      'gemini',
      'anthropic',
      'aliyun',
      'aliyun_bailian',
      'baidu_qianfan',
      'volcengine_ark',
      'aws_bedrock',
      'azure_openai',
      'groq',
      'together',
      'fireworks',
      'perplexity',
      'mistral',
      'huggingface',
      'koboldcpp',
      'text_generation_webui',
      'lmstudio',
      'vmlx',
      'ds4',
      'llama_cpp',
      'modelscope',
      'moonshot',
      'ollama',
      'vllm',
      'sglang',
      'custom',
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
        return (
          !!config.apiKey &&
          (!!config.extraParams?.groupId || config.extraParams?.useOpenAIFormat === true || /^minimax-/i.test(config.model))
        );
      case 'openrouter':
      case 'nvidia':
      case 'deepseek':
      case 'xiaomi':
      case 'gemini':
      case 'anthropic':
      case 'aliyun':
      case 'modelscope':
      case 'moonshot':
      case 'aliyun_bailian':
      case 'baidu_qianfan':
      case 'volcengine_ark':
      case 'groq':
      case 'together':
      case 'fireworks':
      case 'perplexity':
      case 'mistral':
        return !!config.apiKey;
      case 'aws_bedrock':
        return !!config.baseUrl && !!config.model;
      case 'azure_openai':
      case 'huggingface':
        return !!config.baseUrl && !!config.model && !!config.apiKey;
      case 'koboldcpp':
      case 'text_generation_webui':
      case 'lmstudio':
      case 'vmlx':
      case 'ds4':
      case 'llama_cpp':
        return !!config.model;
      case 'ollama':
      case 'vllm':
      case 'sglang':
        return !!config.baseUrl;
      case 'openai':
      case 'custom':
        return !!config.model;
      default:
        return !!config.model;
    }
  }
}