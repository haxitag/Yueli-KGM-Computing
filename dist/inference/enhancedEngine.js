import { createNativeServingBackend, } from "../native/backend.js";
import { MapPrefixCache, computeStableContextHash } from "./prefixCache.js";
import { ContinuousBatchScheduler } from "./scheduler.js";
import { PagedKvCacheManager } from "./pagedKvCache.js";
/**
 * 增强型推理引擎
 * 集成前缀缓存、连续批处理、Paged KV Cache
 */
export class EnhancedNativeRuntimeEngine {
    backend;
    prefixCache;
    scheduler;
    kvCacheManager;
    enablePrefixCache;
    enableContinuousBatching;
    constructor(modelPath, options) {
        // 创建原生后端
        this.backend = createNativeServingBackend(modelPath, options);
        // 配置
        this.enablePrefixCache = options?.enablePrefixCache ?? true;
        this.enableContinuousBatching = options?.enableContinuousBatching ?? true;
        // 创建前缀缓存
        this.prefixCache = new MapPrefixCache({
            maxMemoryBytes: options?.prefixCacheMaxMemoryBytes,
        });
        // 创建KV Cache管理器
        const hiddenSize = this.backend.metadata().hiddenSize ?? 4096;
        this.kvCacheManager = new PagedKvCacheManager({
            pageSize: options?.kvPageSize ?? 16,
            maxBlocks: options?.cachedKvPageBudget ?? 256,
            hiddenSize,
        });
        // 创建连续批处理调度器
        if (this.enableContinuousBatching) {
            this.scheduler = new ContinuousBatchScheduler({
                maxBatchSize: options?.continuousBatchingMaxBatchSize ?? 8,
                maxQueueSize: options?.continuousBatchingMaxQueueSize ?? 64,
            });
            // 设置执行后端
            this.scheduler.setExecutionBackend({
                prefillBatch: async (requests) => this.prefillBatch(requests),
                decodeBatch: async (requests) => this.decodeBatch(requests),
            });
            this.scheduler.start();
        }
    }
    get modelPath() {
        return this.backend.modelPath;
    }
    isExecutable() {
        return this.backend.isExecutable();
    }
    async complete(prompt, options) {
        // 如果启用连续批处理,使用调度器
        if (this.enableContinuousBatching && this.scheduler) {
            return this.scheduler.submit(prompt, options);
        }
        // 否则使用后端直接处理
        const result = await this.backend.complete(prompt, options);
        // 尝试缓存结果
        if (this.enablePrefixCache && result.kvBlocks) {
            const contextHash = this.computeContextHash(prompt, options);
            this.prefixCache.setBlocks(contextHash, result.kvBlocks);
        }
        return result;
    }
    async *streamComplete(prompt, options) {
        // 如果启用连续批处理,使用调度器
        if (this.enableContinuousBatching && this.scheduler) {
            const result = await this.scheduler.submit(prompt, options);
            // 转换为流式事件
            yield { type: "started", model: options?.model };
            if (result.text) {
                yield { type: "token", text: result.text, index: 0 };
            }
            yield { type: "finished", result };
            return;
        }
        // 否则使用后端直接流式处理
        for await (const event of this.backend.streamComplete(prompt, options)) {
            yield event;
        }
    }
    metadata() {
        return this.backend.metadata();
    }
    manifest() {
        return this.backend.manifest();
    }
    executionBackend() {
        return this.backend.executionBackend();
    }
    servingBackend() {
        return this.backend.kind;
    }
    schedulerMetrics() {
        return this.backend.schedulerMetrics();
    }
    /**
     * 获取增强引擎的统计信息
     */
    getEnhancedStats() {
        const schedulerStats = this.scheduler?.getStats();
        const prefixCacheStats = this.prefixCache.getStats();
        const kvCacheStats = this.kvCacheManager.getStats();
        return {
            prefixCache: prefixCacheStats,
            scheduler: schedulerStats,
            kvCache: kvCacheStats,
        };
    }
    /**
     * 计算上下文哈希
     */
    computeContextHash(prompt, options) {
        // 提取稳定上下文
        const stableContext = {
            prompt: prompt.slice(0, 2048), // 只取前2048个字符
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
            stop: options?.stop,
        };
        return computeStableContextHash(stableContext);
    }
    /**
     * 批量Prefill
     */
    async prefillBatch(requests) {
        for (const request of requests) {
            // 计算上下文哈希
            const contextHash = this.computeContextHash(request.prompt, request.options);
            // 尝试从缓存获取KV块
            const cachedBlocks = this.prefixCache.getBlocks(contextHash);
            if (cachedBlocks) {
                request.kvBlocks = cachedBlocks;
                request.contextHash = contextHash;
                this.prefixCache.ref(contextHash);
                continue;
            }
            // 没有缓存,调用后端prefill
            // 这里应该调用backend的prefill方法
            // 暂时模拟
            await this.delay(10);
            // 获取生成的KV块
            // 模拟生成
            const dummyBlocks = this.createDummyKvBlocks(request.prompt);
            request.kvBlocks = dummyBlocks;
            request.contextHash = contextHash;
            // 缓存KV块
            if (this.enablePrefixCache) {
                this.prefixCache.setBlocks(contextHash, dummyBlocks);
            }
        }
    }
    /**
     * 批量Decode
     */
    async decodeBatch(requests) {
        const results = [];
        for (const request of requests) {
            // 检查停止序列
            const stop = request.options?.stop;
            const maxTokens = request.options?.maxTokens ?? 512;
            if (request.tokensProcessed >= maxTokens) {
                results.push({ id: request.id, finished: true });
                continue;
            }
            // 模拟decode
            await this.delay(1);
            // 模拟生成token
            const token = this.generateDummyToken();
            const finished = Math.random() > 0.95 || request.tokensProcessed >= maxTokens - 1;
            results.push({
                id: request.id,
                token,
                finished,
                kvBlocks: request.kvBlocks,
            });
        }
        return results;
    }
    /**
     * 创建模拟KV块
     */
    createDummyKvBlocks(prompt) {
        const hiddenSize = this.backend.metadata().hiddenSize ?? 4096;
        const pageSize = 16;
        const numBlocks = Math.ceil(prompt.length / (pageSize * 4));
        const blocks = [];
        for (let i = 0; i < numBlocks; i++) {
            blocks.push({
                id: `blk_${i}`,
                tokens: [],
                kCache: new Float32Array(pageSize * hiddenSize),
                vCache: new Float32Array(pageSize * hiddenSize),
                refCount: 1,
                hash: `hash_${i}`,
            });
        }
        return blocks;
    }
    /**
     * 生成模拟token
     */
    generateDummyToken() {
        const tokens = ["Hello", " world", "!", " The", " quick", " brown", " fox"];
        return tokens[Math.floor(Math.random() * tokens.length)];
    }
    /**
     * 延迟
     */
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * 关闭引擎
     */
    close() {
        if (this.scheduler) {
            this.scheduler.stop();
        }
        this.prefixCache.clear();
    }
}
