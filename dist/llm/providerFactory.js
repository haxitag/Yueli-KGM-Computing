import { ZhipuLlmClient, MinimaxLlmClient, OpenRouterLlmClient, NvidiaLlmClient, DeepSeekLlmClient, OllamaLlmClient, VllmLlmClient, SlangLlmClient } from "./third-party.js";
import { HttpLlmClient } from "./client.js";
export class LlmProviderFactory {
    static createClient(config) {
        // 默认URL配置
        const defaultUrls = {
            zhipu: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
            minimax: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
            openrouter: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
            nvidia: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
            deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
            ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/api',
            vllm: process.env.VLLM_BASE_URL || 'http://localhost:8000/v1',
            slang: process.env.SLANG_BASE_URL || 'http://localhost:7860/v1',
            openai: process.env.KGM_LLM_BASE_URL || 'https://api.openai.com/v1',
        };
        switch (config.type) {
            case 'zhipu':
                if (!config.apiKey) {
                    throw new Error('Zhipu API key is required');
                }
                return new ZhipuLlmClient({
                    baseUrl: config.baseUrl || defaultUrls.zhipu,
                    model: config.model,
                    apiKey: config.apiKey,
                });
            case 'minimax':
                if (!config.apiKey || !config.extraParams?.groupId) {
                    throw new Error('Minimax API key and groupId are required');
                }
                return new MinimaxLlmClient({
                    baseUrl: config.baseUrl || defaultUrls.minimax,
                    model: config.model,
                    apiKey: config.apiKey,
                    groupId: config.extraParams.groupId,
                });
            case 'openrouter':
                if (!config.apiKey) {
                    throw new Error('OpenRouter API key is required');
                }
                return new OpenRouterLlmClient({
                    baseUrl: config.baseUrl || defaultUrls.openrouter,
                    model: config.model,
                    apiKey: config.apiKey,
                });
            case 'nvidia':
                if (!config.apiKey) {
                    throw new Error('NVIDIA API key is required');
                }
                return new NvidiaLlmClient({
                    baseUrl: config.baseUrl || defaultUrls.nvidia,
                    model: config.model,
                    apiKey: config.apiKey,
                });
            case 'deepseek':
                if (!config.apiKey) {
                    throw new Error('DeepSeek API key is required');
                }
                return new DeepSeekLlmClient({
                    baseUrl: config.baseUrl || defaultUrls.deepseek,
                    model: config.model,
                    apiKey: config.apiKey,
                });
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
                    path: config.extraParams?.path || '/chat/completions',
                    mode: config.extraParams?.mode || 'chat',
                });
        }
    }
    /**
     * 从环境变量创建配置
     */
    static createConfigFromEnv(provider) {
        switch (provider) {
            case 'zhipu':
                const zhipuApiKey = process.env.ZHIPU_API_KEY;
                if (!zhipuApiKey)
                    return null;
                return {
                    type: 'zhipu',
                    baseUrl: process.env.ZHIPU_BASE_URL,
                    model: process.env.ZHIPU_DEFAULT_MODEL || 'glm-4',
                    apiKey: zhipuApiKey,
                };
            case 'minimax':
                const minimaxApiKey = process.env.MINIMAX_API_KEY;
                const minimaxGroupId = process.env.MINIMAX_GROUP_ID;
                if (!minimaxApiKey || !minimaxGroupId)
                    return null;
                return {
                    type: 'minimax',
                    baseUrl: process.env.MINIMAX_BASE_URL,
                    model: process.env.MINIMAX_DEFAULT_MODEL || 'abab6.5-chat',
                    apiKey: minimaxApiKey,
                    extraParams: { groupId: minimaxGroupId },
                };
            case 'openrouter':
                const openRouterApiKey = process.env.OPENROUTER_API_KEY;
                if (!openRouterApiKey)
                    return null;
                return {
                    type: 'openrouter',
                    baseUrl: process.env.OPENROUTER_BASE_URL,
                    model: process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4-turbo',
                    apiKey: openRouterApiKey,
                };
            case 'nvidia':
                const nvidiaApiKey = process.env.NVIDIA_API_KEY;
                const nvidiaBaseUrl = process.env.NVIDIA_BASE_URL;
                if (!nvidiaApiKey || !nvidiaBaseUrl)
                    return null;
                return {
                    type: 'nvidia',
                    baseUrl: nvidiaBaseUrl,
                    model: process.env.NVIDIA_DEFAULT_MODEL || 'meta/llama3-70b-instruct',
                    apiKey: nvidiaApiKey,
                };
            case 'deepseek':
                const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
                if (!deepSeekApiKey)
                    return null;
                return {
                    type: 'deepseek',
                    baseUrl: process.env.DEEPSEEK_BASE_URL,
                    model: process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat',
                    apiKey: deepSeekApiKey,
                };
            case 'ollama':
                const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
                if (!ollamaBaseUrl)
                    return null;
                return {
                    type: 'ollama',
                    baseUrl: ollamaBaseUrl,
                    model: process.env.OLLAMA_DEFAULT_MODEL || 'llama3',
                };
            case 'vllm':
                const vllmBaseUrl = process.env.VLLM_BASE_URL;
                if (!vllmBaseUrl)
                    return null;
                return {
                    type: 'vllm',
                    baseUrl: vllmBaseUrl,
                    model: process.env.VLLM_DEFAULT_MODEL || 'meta-llama/Llama-2-7b-hf',
                    apiKey: process.env.VLLM_API_KEY,
                };
            case 'slang':
                const slangBaseUrl = process.env.SLANG_BASE_URL;
                if (!slangBaseUrl)
                    return null;
                return {
                    type: 'slang',
                    baseUrl: slangBaseUrl,
                    model: process.env.SLANG_DEFAULT_MODEL || 'default-model',
                    apiKey: process.env.SLANG_API_KEY,
                };
            default:
                return null;
        }
    }
    /**
     * 获取支持的提供商列表
     */
    static getSupportedProviders() {
        return [
            'openai',
            'zhipu',
            'minimax',
            'openrouter',
            'nvidia',
            'deepseek',
            'ollama',
            'vllm',
            'slang',
            'custom'
        ];
    }
    /**
     * 验证配置是否完整
     */
    static validateConfig(config) {
        switch (config.type) {
            case 'zhipu':
                return !!config.apiKey;
            case 'minimax':
                return !!config.apiKey && !!config.extraParams?.groupId;
            case 'openrouter':
            case 'nvidia':
            case 'deepseek':
                return !!config.apiKey && !!config.baseUrl;
            case 'ollama':
            case 'vllm':
            case 'slang':
                return !!config.baseUrl;
            default:
                return !!config.model;
        }
    }
}
