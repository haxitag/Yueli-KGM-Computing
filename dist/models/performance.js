import { generateId } from "../utils/id.js";
export class ModelPerformanceMonitor {
    records = [];
    benchmarks = new Map();
    evaluationResults = [];
    autoConfig;
    lastEvaluationTime = 0;
    constructor(config) {
        this.autoConfig = {
            enabled: config?.enabled ?? true,
            evaluationIntervalMinutes: config?.evaluationIntervalMinutes ?? 60,
            minEvaluationIntervalMs: config?.minEvaluationIntervalMs ?? 300000, // 5分钟
            benchmarkIds: config?.benchmarkIds ?? [],
            taskTypes: config?.taskTypes ?? ['general', 'reasoning', 'generation'],
            sampleSize: config?.sampleSize ?? 10,
            saveDetailedLogs: config?.saveDetailedLogs ?? true,
        };
    }
    /**
     * 记录单次模型调用的性能
     */
    recordPerformance(modelName, input, output, metrics, taskType = 'general') {
        const record = {
            id: generateId(),
            modelName,
            metrics,
            taskType,
            timestamp: new Date().toISOString(),
            inputPrompt: input,
            modelOutput: output,
        };
        this.records.push(record);
        // 只保留最近1000条记录以节省内存
        if (this.records.length > 1000) {
            this.records = this.records.slice(-1000);
        }
    }
    /**
     * 注册基准测试
     */
    registerBenchmark(benchmark) {
        this.benchmarks.set(benchmark.id, benchmark);
    }
    /**
     * 获取基准测试
     */
    getBenchmark(benchmarkId) {
        return this.benchmarks.get(benchmarkId);
    }
    /**
     * 运行基准测试
     */
    async runBenchmark(modelName, benchmarkId) {
        const benchmark = this.benchmarks.get(benchmarkId);
        if (!benchmark) {
            throw new Error(`Benchmark not found: ${benchmarkId}`);
        }
        const startTime = Date.now();
        let totalMetrics = {
            responseTimeMs: 0,
            throughputTokensPerSecond: 0,
            errorRate: 0,
            cost: 0,
            accuracy: 0,
            usefulness: 0,
            creativity: 0,
            consistency: 0,
        };
        let successCount = 0;
        for (let i = 0; i < Math.min(benchmark.inputs.length, this.autoConfig.sampleSize); i++) {
            try {
                const input = benchmark.inputs[i];
                // 模拟模型调用和评估
                const startTime = Date.now();
                // 这里应该实际调用模型，为了演示目的，我们模拟一些结果
                const simulatedOutput = `Simulated output for: ${input.substring(0, 20)}...`;
                const responseTime = Math.random() * 2000 + 500; // 500-2500ms
                // 模拟计算各项指标
                const tokensPerSecond = 100 + Math.random() * 200; // 100-300 tokens/sec
                const accuracy = benchmark.expectedOutputs && i < benchmark.expectedOutputs.length
                    ? this.calculateAccuracy(simulatedOutput, benchmark.expectedOutputs[i])
                    : Math.random();
                const usefulness = 0.5 + Math.random() * 0.4; // 0.5-0.9
                const creativity = 0.3 + Math.random() * 0.5; // 0.3-0.8
                const consistency = 0.6 + Math.random() * 0.3; // 0.6-0.9
                totalMetrics.responseTimeMs += responseTime;
                totalMetrics.throughputTokensPerSecond += tokensPerSecond;
                totalMetrics.accuracy += accuracy;
                totalMetrics.usefulness += usefulness;
                totalMetrics.creativity += creativity;
                totalMetrics.consistency += consistency;
                successCount++;
                // 记录单次性能
                this.recordPerformance(modelName, input, simulatedOutput, {
                    responseTimeMs: responseTime,
                    throughputTokensPerSecond: tokensPerSecond,
                    errorRate: 0,
                    cost: 0.0001 * input.length / 1000, // 模拟成本
                    accuracy,
                    usefulness,
                    creativity,
                    consistency,
                }, benchmark.taskType);
            }
            catch (error) {
                totalMetrics.errorRate += 1;
            }
        }
        // 计算平均值
        if (successCount > 0) {
            totalMetrics.responseTimeMs /= successCount;
            totalMetrics.throughputTokensPerSecond /= successCount;
            totalMetrics.accuracy /= successCount;
            totalMetrics.usefulness /= successCount;
            totalMetrics.creativity /= successCount;
            totalMetrics.consistency /= successCount;
            totalMetrics.errorRate /= benchmark.inputs.length; // 错误率相对于总请求数
        }
        // 计算整体评分（加权平均）
        const overallScore = (totalMetrics.accuracy * 0.3 +
            totalMetrics.usefulness * 0.25 +
            totalMetrics.consistency * 0.2 +
            (1 - totalMetrics.responseTimeMs / 10000) * 0.15 + // 响应时间越短越好，最大10秒
            totalMetrics.creativity * 0.1);
        const result = {
            id: generateId(),
            modelName,
            benchmarkId,
            overallScore: Math.min(overallScore, 1), // 确保不超过1
            metrics: totalMetrics,
            timestamp: new Date().toISOString(),
        };
        this.evaluationResults.push(result);
        // 只保留最近100个评估结果
        if (this.evaluationResults.length > 100) {
            this.evaluationResults = this.evaluationResults.slice(-100);
        }
        return result;
    }
    /**
     * 计算输出准确性
     */
    calculateAccuracy(actual, expected) {
        // 简单的准确性计算，实际应用中可能需要更复杂的NLP技术
        const actualLower = actual.toLowerCase();
        const expectedLower = expected.toLowerCase();
        // 计算编辑距离作为相似度的基础
        const distance = this.levenshteinDistance(actualLower, expectedLower);
        const maxLength = Math.max(actualLower.length, expectedLower.length);
        if (maxLength === 0)
            return 1;
        return 1 - (distance / maxLength);
    }
    /**
     * 计算编辑距离
     */
    levenshteinDistance(str1, str2) {
        const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
        for (let i = 0; i <= str1.length; i++) {
            matrix[0][i] = i;
        }
        for (let j = 0; j <= str2.length; j++) {
            matrix[j][0] = j;
        }
        for (let j = 1; j <= str2.length; j++) {
            for (let i = 1; i <= str1.length; i++) {
                const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(matrix[j][i - 1] + 1, // insertion
                matrix[j - 1][i] + 1, // deletion
                matrix[j - 1][i - 1] + indicator // substitution
                );
            }
        }
        return matrix[str2.length][str1.length];
    }
    /**
     * 获取模型的历史性能统计
     */
    getModelPerformanceStats(modelName, taskType, hoursBack = 24) {
        const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
        const relevantRecords = this.records.filter(record => {
            const recordTime = new Date(record.timestamp).getTime();
            return record.modelName === modelName &&
                recordTime >= cutoffTime &&
                (!taskType || record.taskType === taskType);
        });
        if (relevantRecords.length === 0) {
            return null;
        }
        // 计算平均指标
        const stats = {
            responseTimeMs: 0,
            throughputTokensPerSecond: 0,
            errorRate: 0,
            cost: 0,
            accuracy: 0,
            usefulness: 0,
            creativity: 0,
            consistency: 0,
        };
        relevantRecords.forEach(record => {
            stats.responseTimeMs += record.metrics.responseTimeMs;
            stats.throughputTokensPerSecond += record.metrics.throughputTokensPerSecond;
            stats.errorRate += record.metrics.errorRate;
            stats.cost += record.metrics.cost;
            stats.accuracy += record.metrics.accuracy;
            stats.usefulness += record.metrics.usefulness;
            stats.creativity += record.metrics.creativity;
            stats.consistency += record.metrics.consistency;
        });
        const count = relevantRecords.length;
        stats.responseTimeMs /= count;
        stats.throughputTokensPerSecond /= count;
        stats.errorRate /= count;
        stats.cost /= count;
        stats.accuracy /= count;
        stats.usefulness /= count;
        stats.creativity /= count;
        stats.consistency /= count;
        return stats;
    }
    /**
     * 获取模型排名
     */
    getModelRankings(taskType = 'general', hoursBack = 24) {
        const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
        const relevantRecords = this.records.filter(record => {
            const recordTime = new Date(record.timestamp).getTime();
            return recordTime >= cutoffTime &&
                (!taskType || record.taskType === taskType);
        });
        if (relevantRecords.length === 0) {
            return [];
        }
        // 按模型分组
        const modelGroups = new Map();
        relevantRecords.forEach(record => {
            if (!modelGroups.has(record.modelName)) {
                modelGroups.set(record.modelName, []);
            }
            modelGroups.get(record.modelName).push(record);
        });
        // 计算每个模型的平均得分
        const rankings = Array.from(modelGroups.entries()).map(([modelName, records]) => {
            // 计算平均指标
            const avgMetrics = {
                responseTimeMs: 0,
                throughputTokensPerSecond: 0,
                errorRate: 0,
                cost: 0,
                accuracy: 0,
                usefulness: 0,
                creativity: 0,
                consistency: 0,
            };
            records.forEach(record => {
                avgMetrics.responseTimeMs += record.metrics.responseTimeMs;
                avgMetrics.throughputTokensPerSecond += record.metrics.throughputTokensPerSecond;
                avgMetrics.errorRate += record.metrics.errorRate;
                avgMetrics.cost += record.metrics.cost;
                avgMetrics.accuracy += record.metrics.accuracy;
                avgMetrics.usefulness += record.metrics.usefulness;
                avgMetrics.creativity += record.metrics.creativity;
                avgMetrics.consistency += record.metrics.consistency;
            });
            const count = records.length;
            avgMetrics.responseTimeMs /= count;
            avgMetrics.throughputTokensPerSecond /= count;
            avgMetrics.errorRate /= count;
            avgMetrics.cost /= count;
            avgMetrics.accuracy /= count;
            avgMetrics.usefulness /= count;
            avgMetrics.creativity /= count;
            avgMetrics.consistency /= count;
            // 计算综合得分
            const averageScore = (avgMetrics.accuracy * 0.3 +
                avgMetrics.usefulness * 0.25 +
                avgMetrics.consistency * 0.2 +
                (1 - avgMetrics.responseTimeMs / 10000) * 0.15 + // 响应时间越短越好
                avgMetrics.creativity * 0.1);
            return {
                modelName,
                averageScore: Math.min(averageScore, 1), // 确保不超过1
                sampleSize: count,
                metrics: avgMetrics
            };
        });
        // 按综合得分排序
        return rankings.sort((a, b) => b.averageScore - a.averageScore);
    }
    /**
     * 获取最新的评估结果
     */
    getLatestEvaluationResults(modelName, benchmarkId) {
        let results = this.evaluationResults;
        if (modelName) {
            results = results.filter(r => r.modelName === modelName);
        }
        if (benchmarkId) {
            results = results.filter(r => r.benchmarkId === benchmarkId);
        }
        // 按时间倒序排列
        return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
    /**
     * 检查是否需要进行自动评估
     */
    shouldRunAutoEvaluation() {
        if (!this.autoConfig.enabled) {
            return false;
        }
        const now = Date.now();
        return (now - this.lastEvaluationTime) >= (this.autoConfig.evaluationIntervalMinutes * 60 * 1000);
    }
    /**
     * 运行自动评估
     */
    async runAutoEvaluation() {
        if (!this.autoConfig.enabled || !this.shouldRunAutoEvaluation()) {
            return [];
        }
        const results = [];
        // 为每个注册的基准测试运行评估
        for (const benchmarkId of this.autoConfig.benchmarkIds) {
            // 这里应该获取所有可用模型并运行基准测试
            // 由于我们没有实际的模型注册表，我们使用模拟模型名
            const mockModelNames = ["gpt-4", "claude-3", "gemini-pro", "llama-3"];
            for (const modelName of mockModelNames) {
                try {
                    // 注意：在实际实现中，我们需要实际的模型调用
                    // 这里只是模拟返回结果
                    const mockResult = {
                        id: generateId(),
                        modelName,
                        benchmarkId,
                        overallScore: 0.7 + Math.random() * 0.3, // 模拟分数
                        metrics: {
                            responseTimeMs: 1000 + Math.random() * 2000,
                            throughputTokensPerSecond: 50 + Math.random() * 100,
                            errorRate: Math.random() * 0.1,
                            cost: 0.01 + Math.random() * 0.05,
                            accuracy: 0.6 + Math.random() * 0.4,
                            usefulness: 0.6 + Math.random() * 0.4,
                            creativity: 0.5 + Math.random() * 0.4,
                            consistency: 0.7 + Math.random() * 0.3,
                        },
                        timestamp: new Date().toISOString(),
                    };
                    results.push(mockResult);
                    this.evaluationResults.push(mockResult);
                }
                catch (error) {
                    console.error(`Failed to evaluate model ${modelName} on benchmark ${benchmarkId}:`, error);
                }
            }
        }
        this.lastEvaluationTime = Date.now();
        // 只保留最近的评估结果
        if (this.evaluationResults.length > 100) {
            this.evaluationResults = this.evaluationResults.slice(-100);
        }
        return results;
    }
    /**
     * 获取性能趋势
     */
    getPerformanceTrend(modelName, metric, hoursBack = 24) {
        const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
        const relevantRecords = this.records
            .filter(record => {
            const recordTime = new Date(record.timestamp).getTime();
            return record.modelName === modelName && recordTime >= cutoffTime;
        })
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        return relevantRecords.map(record => ({
            timestamp: record.timestamp,
            value: record.metrics[metric]
        }));
    }
}
