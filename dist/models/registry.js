import { HttpLlmClient } from "../llm/client.js";
export class ModelRegistry {
    models = new Map();
    /**
     * 注册模型
     */
    register(modelConfig, capabilities) {
        const client = new HttpLlmClient({
            baseUrl: modelConfig.baseUrl,
            model: modelConfig.name,
            path: modelConfig.path,
            apiKey: modelConfig.apiKey,
            mode: modelConfig.mode ?? "chat",
        });
        const record = {
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
    get(name) {
        return this.models.get(name);
    }
    /**
     * 获取启用的模型列表
     */
    listEnabled() {
        return Array.from(this.models.values()).filter(model => model.enabled);
    }
    /**
     * 获取特定用途的模型
     */
    getByPurpose(purpose) {
        return Array.from(this.models.values())
            .filter(model => model.capabilities.purpose === purpose && model.enabled);
    }
    /**
     * 获取支持特定功能的模型
     */
    getByCapability(capability) {
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
    setEnabled(name, enabled) {
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
    setWeight(name, weight) {
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
    findBestMatch(requirements) {
        const candidates = Array.from(this.models.values())
            .filter(model => model.enabled);
        if (candidates.length === 0) {
            return null;
        }
        // 根据要求筛选模型
        const filtered = candidates.filter(model => {
            const caps = model.capabilities;
            return ((!requirements.purpose || caps.purpose === requirements.purpose) &&
                (!requirements.supportsFunctionCalling || caps.supportsFunctionCalling === requirements.supportsFunctionCalling) &&
                (!requirements.supportsMultimodal || caps.supportsMultimodal === requirements.supportsMultimodal) &&
                (!requirements.contextWindow || caps.contextWindow >= requirements.contextWindow));
        });
        if (filtered.length === 0) {
            return null;
        }
        // 返回第一个匹配的模型（可以根据其他指标进行更复杂的排序）
        return filtered[0];
    }
}
