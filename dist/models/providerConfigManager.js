export class ProviderConfigurationManager {
    configFilePath;
    config;
    constructor(configFilePath = './provider-config.json') {
        this.configFilePath = configFilePath;
        this.config = {
            providers: [],
            activeProviders: [],
            defaultProvider: '',
            providerRoutingRules: [],
        };
    }
    /**
     * 从配置文件加载提供商配置
     */
    async loadConfiguration() {
        try {
            const fs = await import('fs');
            if (!fs.existsSync(this.configFilePath)) {
                console.log(`Provider config file not found: ${this.configFilePath}, using defaults`);
                return;
            }
            const configData = JSON.parse(fs.readFileSync(this.configFilePath, 'utf8'));
            this.config = configData;
            console.log(`Loaded provider configuration from ${this.configFilePath}`);
        }
        catch (error) {
            console.error(`Failed to load provider configuration from ${this.configFilePath}:`, error);
            throw error;
        }
    }
    /**
     * 保存提供商配置到文件
     */
    async saveConfiguration() {
        try {
            const fs = await import('fs');
            // 写入文件
            fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2));
            console.log(`Saved provider configuration to ${this.configFilePath}`);
        }
        catch (error) {
            console.error(`Failed to save provider configuration to ${this.configFilePath}:`, error);
            throw error;
        }
    }
    /**
     * 添加或更新提供商配置
     */
    addOrUpdateProvider(providerConfig) {
        // 检查是否已存在
        const existingIndex = this.config.providers.findIndex(p => p.type === providerConfig.type && p.model === providerConfig.model);
        if (existingIndex !== -1) {
            // 更新现有配置
            this.config.providers[existingIndex] = providerConfig;
        }
        else {
            // 添加新配置
            this.config.providers.push(providerConfig);
        }
    }
    /**
     * 移除提供商配置
     */
    removeProvider(type, model) {
        const initialLength = this.config.providers.length;
        this.config.providers = this.config.providers.filter(p => !(p.type === type && p.model === model));
        return initialLength > this.config.providers.length;
    }
    /**
     * 启用提供商
     */
    enableProvider(type, model) {
        const providerKey = `${type}:${model}`;
        if (!this.config.activeProviders.includes(providerKey)) {
            this.config.activeProviders.push(providerKey);
            return true;
        }
        return false;
    }
    /**
     * 禁用提供商
     */
    disableProvider(type, model) {
        const initialLength = this.config.activeProviders.length;
        this.config.activeProviders = this.config.activeProviders.filter(p => p !== `${type}:${model}`);
        return initialLength > this.config.activeProviders.length;
    }
    /**
     * 设置默认提供商
     */
    setDefaultProvider(type, model) {
        this.config.defaultProvider = `${type}:${model}`;
    }
    /**
     * 添加提供商路由规则
     */
    addProviderRoutingRule(rule) {
        this.config.providerRoutingRules.push(rule);
        // 按优先级排序
        this.config.providerRoutingRules.sort((a, b) => b.priority - a.priority);
    }
    /** 导出完整配置（供 Admin API / Copilot 同步） */
    getConfigData() {
        return {
            providers: [...this.config.providers],
            activeProviders: [...this.config.activeProviders],
            defaultProvider: this.config.defaultProvider,
            providerRoutingRules: [...this.config.providerRoutingRules],
        };
    }
    /** 批量替换提供商（Copilot cloudProviders 同步） */
    replaceFromCopilotSync(params) {
        this.config.providers = [...params.providers];
        if (params.activeProviders?.length) {
            this.config.activeProviders = [...params.activeProviders];
        }
        else {
            this.config.activeProviders = params.providers.map((p) => `${p.type}:${p.model}`);
        }
        if (params.defaultProvider) {
            this.config.defaultProvider = params.defaultProvider;
        }
        else if (this.config.activeProviders[0]) {
            this.config.defaultProvider = this.config.activeProviders[0];
        }
    }
    /**
     * 获取所有提供商配置
     */
    getAllProviderConfigs() {
        return [...this.config.providers];
    }
    /**
     * 根据类型获取提供商配置
     */
    getProviderConfigsByType(type) {
        return this.config.providers.filter(p => p.type === type);
    }
    /**
     * 获取激活的提供商配置
     */
    getActiveProviderConfigs() {
        return this.config.providers.filter(p => this.config.activeProviders.includes(`${p.type}:${p.model}`));
    }
    /**
     * 获取默认提供商配置
     */
    getDefaultProviderConfig() {
        const defaultProvider = this.findProviderByKey(this.config.defaultProvider, true);
        if (defaultProvider) {
            return defaultProvider;
        }
        return this.getActiveProviderConfigs()[0] ?? null;
    }
    /**
     * 获取特定条件下的最佳提供商
     */
    getBestProviderForTask(taskDescription) {
        // 首先尝试根据路由规则匹配
        for (const rule of this.config.providerRoutingRules) {
            if (!matchesRuleCondition(taskDescription, rule.condition)) {
                continue;
            }
            const provider = this.findProviderByKey(rule.provider, true);
            if (provider) {
                return provider;
            }
        }
        // 如果没有匹配的规则，返回默认提供商
        return this.getDefaultProviderConfig();
    }
    /**
     * 获取提供商配置摘要
     */
    getProviderConfigSummary() {
        const activeProviders = this.getActiveProviderConfigs();
        const totalProviders = this.config.providers.length;
        const activeCount = activeProviders.length;
        const routingRulesCount = this.config.providerRoutingRules.length;
        const summary = `
Provider Configuration Summary:
==============================
Total Providers: ${totalProviders}
Active Providers: ${activeCount}
Default Provider: ${this.config.defaultProvider}
Routing Rules: ${routingRulesCount}

Active Providers:
${activeProviders.map(p => `- ${p.type}:${p.model}`).join('\n')}

Routing Rules:
${this.config.providerRoutingRules.map(r => `- ${r.name}: ${r.condition} -> ${r.provider} (priority: ${r.priority})`).join('\n')}
    `.trim();
        return summary;
    }
    /**
     * 从环境变量更新配置
     */
    updateFromEnvironment() {
        // 从环境变量加载API密钥等敏感信息
        this.config.providers.forEach(provider => {
            switch (provider.type) {
                case 'zhipu':
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.ZHIPU_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.ZHIPU_BASE_URL;
                    }
                    break;
                case 'minimax':
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.MINIMAX_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.MINIMAX_BASE_URL;
                    }
                    if (!provider.extraParams?.groupId) {
                        if (!provider.extraParams)
                            provider.extraParams = {};
                        provider.extraParams.groupId = process.env.MINIMAX_GROUP_ID;
                    }
                    break;
                case 'openrouter':
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.OPENROUTER_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.OPENROUTER_BASE_URL;
                    }
                    break;
                case 'nvidia':
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.NVIDIA_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.NVIDIA_BASE_URL;
                    }
                    break;
                case 'deepseek':
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.DEEPSEEK_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.DEEPSEEK_BASE_URL;
                    }
                    break;
                case 'ollama':
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.OLLAMA_BASE_URL;
                    }
                    break;
                case 'vllm':
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.VLLM_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.VLLM_BASE_URL;
                    }
                    break;
                case 'sglang':
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.SGLANG_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.SGLANG_BASE_URL;
                    }
                    break;
                case 'openai':
                default:
                    if (!provider.apiKey) {
                        provider.apiKey = process.env.OPENAI_API_KEY || undefined;
                    }
                    if (!provider.baseUrl) {
                        provider.baseUrl = process.env.KGM_LLM_BASE_URL;
                    }
                    break;
            }
        });
    }
    findProviderByKey(providerKey, requireActive) {
        const separatorIndex = providerKey.indexOf(":");
        if (separatorIndex === -1) {
            return null;
        }
        const type = providerKey.slice(0, separatorIndex);
        const model = providerKey.slice(separatorIndex + 1);
        if (!type || !model) {
            return null;
        }
        if (requireActive && !this.config.activeProviders.includes(providerKey)) {
            return null;
        }
        return this.config.providers.find((provider) => provider.type === type && provider.model === model) ?? null;
    }
}
function matchesRuleCondition(taskDescription, condition) {
    try {
        return new RegExp(condition, "i").test(taskDescription);
    }
    catch {
        return condition
            .split("|")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
            .some((token) => taskDescription.toLowerCase().includes(token));
    }
}
