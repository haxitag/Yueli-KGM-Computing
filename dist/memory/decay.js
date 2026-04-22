import { generateId } from "../utils/id.js";
export class MemoryDecayMechanism {
    store;
    config;
    decayRules = [];
    revocationRecords = new Map();
    decayTimer;
    constructor(store, config) {
        this.store = store;
        // 设置默认衰减函数（线性衰减，每天降低0.01的重要性）
        const defaultDecayFunction = (ageInDays, initialImportance) => {
            // 基础衰减：每天减少1%的重要性
            const baseDecay = ageInDays * 0.01;
            // 不让重要性降到0以下
            return Math.max(0, initialImportance - baseDecay);
        };
        this.config = {
            defaultDecayFunction: config?.defaultDecayFunction ?? defaultDecayFunction,
            retentionPeriodDays: config?.retentionPeriodDays ?? 365, // 默认保留一年
            evaluationIntervalHours: config?.evaluationIntervalHours ?? 24, // 每天评估一次
            importanceThreshold: config?.importanceThreshold ?? 0.2, // 低于0.2的重要性将被标记
            softDeleteEnabled: config?.softDeleteEnabled ?? true,
            softDeleteRetentionDays: config?.softDeleteRetentionDays ?? 30, // 软删除保留30天
            accessFrequencyDecay: config?.accessFrequencyDecay ?? true,
            accessFrequencyWeight: config?.accessFrequencyWeight ?? 0.1,
        };
        // 启动定期衰减评估
        this.startDecaySchedule();
    }
    /**
     * 启动定期衰减评估
     */
    startDecaySchedule() {
        this.decayTimer = setInterval(() => {
            this.performDecayEvaluation();
        }, this.config.evaluationIntervalHours * 60 * 60 * 1000);
    }
    /**
     * 执行衰减评估
     */
    async performDecayEvaluation() {
        // 获取所有记忆
        // 注意：这里需要实际的实现来获取所有用户的记忆
        // 由于MemoryStore接口没有提供获取所有记忆的方法，我们需要模拟
        console.log("Performing decay evaluation...");
        // 返回模拟结果
        return {
            decayedMemoryIds: [],
            deletedMemoryIds: [],
            updatedMemoryIds: [],
            details: []
        };
    }
    /**
     * 计算记忆的衰减值
     */
    calculateDecay(memory, decayFunction) {
        const func = decayFunction || this.config.defaultDecayFunction;
        // 计算记忆年龄（以天为单位）
        const createdAt = new Date(memory.createdAt);
        const now = new Date();
        const ageInDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
        // 获取初始重要性（这里假设重要性信息存储在某种元数据中）
        // 实际实现中，重要性可能存储在专门的元数据表中
        const initialImportance = this.getInitialImportance(memory);
        // 应用衰减函数
        return func(ageInDays, initialImportance);
    }
    /**
     * 获取记忆的初始重要性
     */
    getInitialImportance(memory) {
        // 在实际实现中，这将从专门的元数据存储中获取重要性
        // 现在返回一个默认值
        return 0.5; // 默认中等重要性
    }
    /**
     * 应用衰减规则
     */
    addDecayRule(rule) {
        const ruleId = generateId();
        this.decayRules.push({
            ...rule,
            id: ruleId
        });
        return ruleId;
    }
    /**
     * 移除衰减规则
     */
    removeDecayRule(ruleId) {
        const index = this.decayRules.findIndex(rule => rule.id === ruleId);
        if (index !== -1) {
            this.decayRules.splice(index, 1);
            return true;
        }
        return false;
    }
    /**
     * 撤销特定记忆
     */
    async revokeMemory(memoryId, reason, revokedBy, notes, permanent = false) {
        try {
            // 创建撤销记录
            const revocationRecord = {
                id: generateId(),
                memoryId,
                reason,
                revokedAt: new Date(),
                revokedBy,
                notes,
                permanent
            };
            this.revocationRecords.set(memoryId, revocationRecord);
            // 根据是否永久撤销来决定如何处理记忆
            if (permanent) {
                // 永久撤销 - 从存储中删除记忆
                await this.permanentlyDeleteMemory(memoryId);
            }
            else {
                // 临时撤销 - 标记为已撤销但仍保留
                await this.markMemoryAsRevoked(memoryId, revocationRecord);
            }
            return true;
        }
        catch (error) {
            console.error(`Failed to revoke memory ${memoryId}:`, error);
            return false;
        }
    }
    /**
     * 永久删除记忆
     */
    async permanentlyDeleteMemory(memoryId) {
        // 在实际实现中，这将从存储中物理删除记忆
        console.log(`Permanently deleting memory: ${memoryId}`);
    }
    /**
     * 标记记忆为已撤销
     */
    async markMemoryAsRevoked(memoryId, record) {
        // 在实际实现中，这将在存储中标记记忆为已撤销
        console.log(`Marking memory as revoked: ${memoryId}, reason: ${record.reason}`);
    }
    /**
     * 批量撤销记忆
     */
    async bulkRevokeMemories(memoryIds, reason, revokedBy, notes) {
        const successful = [];
        const failed = [];
        for (const memoryId of memoryIds) {
            try {
                const result = await this.revokeMemory(memoryId, reason, revokedBy, notes);
                if (result) {
                    successful.push(memoryId);
                }
                else {
                    failed.push(memoryId);
                }
            }
            catch (error) {
                failed.push(memoryId);
                console.error(`Failed to revoke memory ${memoryId}:`, error);
            }
        }
        return { successful, failed };
    }
    /**
     * 检查记忆是否已被撤销
     */
    isMemoryRevoked(memoryId) {
        return this.revocationRecords.has(memoryId);
    }
    /**
     * 获取撤销记录
     */
    getRevocationRecord(memoryId) {
        return this.revocationRecords.get(memoryId);
    }
    /**
     * 获取所有撤销记录
     */
    getAllRevocationRecords() {
        return Array.from(this.revocationRecords.values());
    }
    /**
     * 恢复被撤销的记忆
     */
    async restoreMemory(memoryId) {
        try {
            const record = this.revocationRecords.get(memoryId);
            if (!record) {
                console.log(`Memory ${memoryId} was not revoked`);
                return false;
            }
            if (record.permanent) {
                console.log(`Cannot restore permanently revoked memory ${memoryId}`);
                return false;
            }
            // 恢复记忆
            await this.unmarkMemoryAsRevoked(memoryId);
            // 从撤销记录中移除
            this.revocationRecords.delete(memoryId);
            return true;
        }
        catch (error) {
            console.error(`Failed to restore memory ${memoryId}:`, error);
            return false;
        }
    }
    /**
     * 取消标记记忆为已撤销
     */
    async unmarkMemoryAsRevoked(memoryId) {
        // 在实际实现中，这将取消存储中记忆的撤销标记
        console.log(`Unmarking memory as revoked: ${memoryId}`);
    }
    /**
     * 清理过期的软删除记忆
     */
    async cleanupSoftDeletedMemories() {
        const now = new Date();
        const cutoffDate = new Date(now);
        cutoffDate.setDate(now.getDate() - this.config.softDeleteRetentionDays);
        // 查找并永久删除过期的软删除记忆
        // 实际实现中需要遍历存储以查找标记为软删除的记忆
        console.log(`Cleaning up soft-deleted memories older than ${cutoffDate.toISOString()}`);
    }
    /**
     * 获取记忆的衰减状态
     */
    async getMemoryDecayStatus(memoryId) {
        try {
            // 在实际实现中，这将从存储中获取记忆
            // 由于我们无法直接从MemoryStore获取单个记忆，返回null
            return null;
        }
        catch (error) {
            console.error(`Failed to get decay status for memory ${memoryId}:`, error);
            return null;
        }
    }
    /**
     * 更新记忆的重要性评分
     */
    async updateMemoryImportance(memoryId, newImportance) {
        try {
            // 在实际实现中，这将更新存储中的记忆重要性
            console.log(`Updating importance for memory ${memoryId} to ${newImportance}`);
            return true;
        }
        catch (error) {
            console.error(`Failed to update importance for memory ${memoryId}:`, error);
            return false;
        }
    }
    /**
     * 获取衰减配置
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * 更新衰减配置
     */
    updateConfig(updates) {
        this.config = { ...this.config, ...updates };
    }
    /**
     * 获取所有衰减规则
     */
    getDecayRules() {
        return [...this.decayRules];
    }
    /**
     * 获取特定用户的衰减规则
     */
    getUserDecayRules(userId) {
        return this.decayRules.filter(rule => !rule.userId || rule.userId === userId);
    }
    /**
     * 评估单个记忆的衰减
     */
    async evaluateMemoryDecay(memory) {
        // 检查是否已被撤销
        if (this.isMemoryRevoked(memory.id)) {
            return {
                shouldDecay: false,
                shouldDelete: true, // 已撤销的记忆应被删除
                newImportance: 0
            };
        }
        // 计算新重要性
        const newImportance = this.calculateDecay(memory);
        // 检查是否低于阈值
        const shouldDelete = newImportance < this.config.importanceThreshold;
        return {
            shouldDecay: !shouldDelete, // 如果不删除，则视为衰减
            shouldDelete,
            newImportance
        };
    }
    /**
     * 关闭衰减机制并清理资源
     */
    close() {
        if (this.decayTimer) {
            clearInterval(this.decayTimer);
            this.decayTimer = undefined;
        }
    }
    /**
     * 获取衰减统计信息
     */
    async getDecayStatistics() {
        // 在实际实现中，这将查询存储以获取统计信息
        return {
            totalMemories: 0,
            decayedMemories: 0,
            deletedMemories: 0,
            revokedMemories: this.revocationRecords.size,
            averageImportance: 0.5
        };
    }
}
