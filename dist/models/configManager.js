import { ModelCapabilitySelector } from "./selector.js";
import { ModelPerformanceMonitor } from "./performance.js";
export class ModelConfigurationManager {
    registry;
    router;
    selector;
    monitor;
    configFilePath;
    constructor(registry, router, selector, monitor, configFilePath = './model-config.json') {
        this.registry = registry;
        this.router = router;
        this.selector = selector;
        this.monitor = monitor;
        this.configFilePath = configFilePath;
    }
    /**
     * 从配置文件加载模型配置
     */
    async loadConfiguration() {
        try {
            // 尝试从文件加载配置
            const fs = await import('fs');
            if (!fs.existsSync(this.configFilePath)) {
                console.log(`Config file not found: ${this.configFilePath}, using defaults`);
                return;
            }
            const configData = JSON.parse(fs.readFileSync(this.configFilePath, 'utf8'));
            // 注册模型
            for (const modelData of configData.models) {
                this.registry.register(modelData.config, modelData.capabilities);
            }
            // 设置启用的模型
            for (const modelName of configData.enabledModels) {
                this.registry.setEnabled(modelName, true);
            }
            // 注册能力配置文件
            for (const profile of configData.capabilityProfiles) {
                this.selector.registerProfile(profile);
            }
            // 设置性能监控配置
            // 注意：由于AutoEvaluationConfig是interface，我们需要重新构建实例
            this.monitor = new ModelPerformanceMonitor(configData.performanceConfig);
            console.log(`Loaded configuration from ${this.configFilePath}`);
        }
        catch (error) {
            console.error(`Failed to load configuration from ${this.configFilePath}:`, error);
            throw error;
        }
    }
    /**
     * 保存配置到文件
     */
    async saveConfiguration() {
        try {
            const fs = await import('fs');
            // 构建配置数据
            const configData = {
                models: [],
                routingStrategies: {}, // 这里需要从路由器获取策略，但当前路由器没有提供这样的方法
                capabilityProfiles: this.selector.getAllProfiles(),
                performanceConfig: this.monitor['autoConfig'], // 使用私有属性访问
                defaultRoutingStrategy: 'random', // 默认策略
                enabledModels: this.registry.listEnabled().map(m => m.config.name),
            };
            // 获取已注册的模型
            for (const modelRecord of Array.from(this.registry.models.values())) {
                configData.models.push({
                    config: modelRecord.config,
                    capabilities: modelRecord.capabilities
                });
            }
            // 写入文件
            fs.writeFileSync(this.configFilePath, JSON.stringify(configData, null, 2));
            console.log(`Saved configuration to ${this.configFilePath}`);
        }
        catch (error) {
            console.error(`Failed to save configuration to ${this.configFilePath}:`, error);
            throw error;
        }
    }
    /**
     * 更新模型配置
     */
    updateModelConfig(modelConfig, capabilities) {
        // 检查模型是否已存在
        const existingModel = this.registry.get(modelConfig.name);
        if (existingModel) {
            // 更新现有模型
            this.registry.register(modelConfig, capabilities);
        }
        else {
            // 注册新模型
            this.registry.register(modelConfig, capabilities);
        }
    }
    /**
     * 删除模型配置
     */
    removeModelConfig(modelName) {
        // 在实际实现中，我们无法从ModelRegistry删除模型
        // 所以我们改为禁用模型
        return this.registry.setEnabled(modelName, false);
    }
    /**
     * 添加路由策略
     */
    addRoutingStrategy(name, strategy) {
        // 在实际实现中，我们无法直接添加路由策略到ModelRouter
        // 这里只是占位符，实际需要扩展ModelRouter的功能
        console.log(`Added routing strategy: ${name}`);
    }
    /**
     * 更新能力配置文件
     */
    updateCapabilityProfile(profile) {
        this.selector.registerProfile(profile);
    }
    /**
     * 删除能力配置文件
     */
    removeCapabilityProfile(profileId) {
        return this.selector.removeProfile(profileId);
    }
    /**
     * 更新性能监控配置
     */
    updatePerformanceConfig(config) {
        // 重新创建监控实例以应用新配置
        this.monitor = new ModelPerformanceMonitor({ ...this.monitor['autoConfig'], ...config });
    }
    /**
     * 启用/禁用模型
     */
    setModelEnabled(modelName, enabled) {
        return this.registry.setEnabled(modelName, enabled);
    }
    /**
     * 获取当前配置
     */
    getCurrentConfiguration() {
        const allModels = Array.from(this.registry.models.values());
        return {
            models: allModels.map(m => ({
                config: m.config,
                capabilities: m.capabilities
            })),
            routingStrategies: {}, // 无法从路由器获取策略
            capabilityProfiles: this.selector.getAllProfiles(),
            performanceConfig: this.monitor['autoConfig'],
            defaultRoutingStrategy: 'random',
            enabledModels: this.registry.listEnabled().map(m => m.config.name),
        };
    }
    /**
     * 导出配置为JSON
     */
    exportConfiguration() {
        return JSON.stringify(this.getCurrentConfiguration(), null, 2);
    }
    /**
     * 从JSON导入配置
     */
    async importConfiguration(jsonConfig) {
        const configData = JSON.parse(jsonConfig);
        // 清空现有配置
        this.registry.models.clear();
        // 重新注册所有模型
        for (const modelData of configData.models) {
            this.registry.register(modelData.config, modelData.capabilities);
        }
        // 设置启用状态
        for (const modelName of configData.enabledModels) {
            this.registry.setEnabled(modelName, true);
        }
        // 重新注册能力配置文件
        this.selector = new ModelCapabilitySelector(this.registry);
        for (const profile of configData.capabilityProfiles) {
            this.selector.registerProfile(profile);
        }
        // 更新性能监控配置
        this.updatePerformanceConfig(configData.performanceConfig);
    }
    /**
     * 从远程URL加载配置
     */
    async loadConfigurationFromUrl(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch config from ${url}: ${response.statusText}`);
            }
            const jsonConfig = await response.json();
            await this.importConfiguration(JSON.stringify(jsonConfig));
            console.log(`Loaded configuration from ${url}`);
        }
        catch (error) {
            console.error(`Failed to load configuration from ${url}:`, error);
            throw error;
        }
    }
    /**
     * 将配置同步到远程URL
     */
    async syncConfigurationToUrl(url, authToken) {
        try {
            const config = this.exportConfiguration();
            const headers = {
                'Content-Type': 'application/json'
            };
            if (authToken) {
                headers['Authorization'] = `Bearer ${authToken}`;
            }
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: config
            });
            if (!response.ok) {
                throw new Error(`Failed to sync config to ${url}: ${response.statusText}`);
            }
            console.log(`Synced configuration to ${url}`);
        }
        catch (error) {
            console.error(`Failed to sync configuration to ${url}:`, error);
            throw error;
        }
    }
    /**
     * 获取模型健康状态
     */
    getModelHealthStatus() {
        const enabledModels = this.registry.listEnabled();
        const healthStatus = [];
        for (const model of enabledModels) {
            // 获取模型的性能统计数据
            const stats = this.monitor.getModelPerformanceStats(model.config.name);
            let status = 'unknown';
            let responseTime;
            let errorRate;
            if (stats) {
                responseTime = stats.responseTimeMs;
                errorRate = stats.errorRate;
                // 基于响应时间和错误率判断健康状态
                if (stats.errorRate > 0.3) {
                    status = 'unhealthy'; // 错误率过高
                }
                else if (stats.errorRate > 0.1 || stats.responseTimeMs > 5000) {
                    status = 'degraded'; // 错误率较高或响应时间较长
                }
                else {
                    status = 'healthy'; // 正常
                }
            }
            else {
                status = 'unknown'; // 没有统计数据
            }
            healthStatus.push({
                modelName: model.config.name,
                status,
                responseTime,
                errorRate,
                lastChecked: new Date().toISOString()
            });
        }
        return healthStatus;
    }
    /**
     * 获取模型配置摘要
     */
    getModelConfigSummary() {
        const config = this.getCurrentConfiguration();
        const summary = `
Model Configuration Summary:
==========================
Total Models: ${config.models.length}
Enabled Models: ${config.enabledModels.length}
Capability Profiles: ${config.capabilityProfiles.length}
Performance Monitoring: ${config.performanceConfig.enabled ? 'Enabled' : 'Disabled'}
Evaluation Interval: ${config.performanceConfig.evaluationIntervalMinutes} minutes

Enabled Models:
${config.enabledModels.map(name => `- ${name}`).join('\n')}
    `.trim();
        return summary;
    }
}
