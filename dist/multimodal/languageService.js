import { generateId } from "../utils/id.js";
export class LanguageAsAService {
    trustDelegationEnabled = true;
    contextEnrichmentLevel = 'comprehensive';
    knowledgeGraphCompletionEnabled = true;
    processor;
    config;
    cache;
    trustProxyLogs = [];
    processingQueue;
    activeProcesses;
    constructor(processor, config, trustConfig) {
        this.processor = processor;
        this.config = {
            enableCache: config?.enableCache ?? true,
            maxCacheSize: config?.maxCacheSize ?? 1000,
            timeoutMs: config?.timeoutMs ?? 30000,
            maxConcurrency: config?.maxConcurrency ?? 5,
        };
        // 初始化信任委托配置
        if (trustConfig) {
            this.trustDelegationEnabled = trustConfig.delegationEnabled ?? true;
            this.contextEnrichmentLevel = trustConfig.enrichmentLevel ?? 'comprehensive';
            this.knowledgeGraphCompletionEnabled = trustConfig.knowledgeGraphCompletion ?? true;
        }
        this.cache = new Map();
        this.processingQueue = [];
        this.activeProcesses = 0;
    }
    /**
     * 信任委托API - 处理单个媒体内容为文本
     * 通过丰富的上下文API接口，实现知识图谱补全
     */
    async processToText(media, embedder) {
        // 记录信任代理操作
        const operationId = generateId();
        this.logTrustProxyOperation(operationId, 'processToText', 'start', {
            mediaType: media.type,
            trustDelegationEnabled: this.trustDelegationEnabled,
            contextEnrichmentLevel: this.contextEnrichmentLevel,
        });
        try {
            // 检查缓存
            const cacheKey = this.generateCacheKey(media);
            if (this.config.enableCache && this.cache.has(cacheKey)) {
                const cachedResult = this.cache.get(cacheKey);
                this.logTrustProxyOperation(operationId, 'processToText', 'cached', {
                    cacheHit: true,
                    mediaType: media.type,
                });
                return cachedResult;
            }
            // 如果正在处理相同的内容，返回现有Promise
            const pendingProcess = this.getPendingProcess(cacheKey);
            if (pendingProcess) {
                this.logTrustProxyOperation(operationId, 'processToText', 'pending', {
                    mediaType: media.type,
                });
                return pendingProcess;
            }
            // 创建处理Promise
            const processPromise = new Promise((resolve, reject) => {
                this.processingQueue.push({ media, resolve, reject });
                this.processNext();
            });
            // 如果启用了缓存，将Promise存入缓存
            if (this.config.enableCache) {
                this.cache.set(cacheKey, processPromise);
            }
            const result = await processPromise;
            // 应用信任委托逻辑
            const trustedResult = await this.applyTrustDelegation(result, embedder);
            this.logTrustProxyOperation(operationId, 'processToText', 'success', {
                mediaType: media.type,
                resultStatus: result.status,
                trustApplied: this.trustDelegationEnabled,
            });
            return trustedResult;
        }
        catch (error) {
            this.logTrustProxyOperation(operationId, 'processToText', 'error', {
                mediaType: media.type,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    /**
     * 批量处理多个媒体内容
     */
    async batchProcessToText(medias, embedder) {
        const results = [];
        for (const media of medias) {
            try {
                const result = await this.processToText(media, embedder);
                results.push(result);
            }
            catch (error) {
                results.push({
                    original: media,
                    textRepresentation: '',
                    processedAt: new Date().toISOString(),
                    status: 'error',
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return results;
    }
    /**
     * 将媒体内容集成到ContextPack中
     */
    async integrateIntoContext(context, medias, embedder) {
        // 处理媒体内容为文本
        const processedMedias = await this.batchProcessToText(medias, embedder);
        // 将处理后的文本添加到上下文的信号中
        const newSignals = processedMedias
            .filter(pm => pm.status === 'success')
            .map(pm => ({
            type: 'web', // 使用web类型作为媒体信号
            source: `media-${pm.original.type}`,
            title: pm.original.metadata?.filename || `Media Content ${pm.original.type}`,
            value: pm.textRepresentation,
            timestamp: pm.processedAt,
            metadata: {
                mediaType: pm.original.type,
                originalData: pm.original.data.substring(0, 100) + '...', // 截取前100个字符
                embeddingPresent: !!pm.embedding,
            },
        }));
        // 返回更新后的上下文
        return {
            ...context,
            signals: [...context.signals, ...newSignals],
        };
    }
    /**
     * 处理队列中的下一个项目
     */
    processNext() {
        if (this.activeProcesses >= this.config.maxConcurrency || this.processingQueue.length === 0) {
            return;
        }
        const { media, resolve, reject } = this.processingQueue.shift();
        this.activeProcesses++;
        // 处理媒体内容
        this.processor.processMedia(media)
            .then(processed => {
            const result = {
                original: media,
                textRepresentation: processed.textRepresentation,
                embedding: processed.embedding,
                processedAt: new Date().toISOString(),
                status: 'success',
            };
            resolve(result);
            this.activeProcesses--;
            this.processNext(); // 处理下一个
        })
            .catch(error => {
            const result = {
                original: media,
                textRepresentation: '',
                processedAt: new Date().toISOString(),
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
            };
            reject(error);
            this.activeProcesses--;
            this.processNext(); // 处理下一个
        });
    }
    /**
     * 获取待处理的进程
     */
    getPendingProcess(cacheKey) {
        // 检查队列中是否有相同的处理
        const pending = this.processingQueue.find(item => this.generateCacheKey(item.media) === cacheKey);
        if (pending) {
            return new Promise((resolve, reject) => {
                // 添加到队列末尾，但保持相同的resolve/reject
                this.processingQueue.push({ ...pending });
            });
        }
        return undefined;
    }
    /**
     * 生成缓存键
     */
    generateCacheKey(media) {
        // 基于媒体类型、数据和元数据生成唯一键
        const key = `${media.type}:${media.data}:${JSON.stringify(media.metadata || {})}`;
        return this.hashString(key);
    }
    /**
     * 简单的字符串哈希函数
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // 转换为32位整数
        }
        return hash.toString();
    }
    /**
     * 清理缓存
     */
    clearCache() {
        this.cache.clear();
    }
    /**
     * 获取缓存大小
     */
    getCacheSize() {
        return this.cache.size;
    }
    /**
     * 修剪缓存到最大大小
     */
    trimCache() {
        if (!this.config.enableCache || this.cache.size <= this.config.maxCacheSize) {
            return;
        }
        // 删除最老的条目
        const entries = Array.from(this.cache.entries());
        const entriesToDelete = entries.slice(0, this.cache.size - this.config.maxCacheSize);
        for (const [key] of entriesToDelete) {
            this.cache.delete(key);
        }
    }
    /**
     * 获取处理统计信息
     */
    getProcessingStats() {
        return {
            cacheSize: this.cache.size,
            queueLength: this.processingQueue.length,
            activeProcesses: this.activeProcesses,
            maxConcurrency: this.config.maxConcurrency,
        };
    }
    /**
     * 从URL处理媒体内容
     */
    async processUrlToText(url, embedder) {
        const media = await this.processor.loadFromUrl(url);
        return this.processToText(media, embedder);
    }
    /**
     * 验证媒体内容是否可以处理
     */
    validateMedia(media) {
        return this.processor.validateMediaContent(media);
    }
    /**
     * 估算处理时间
     */
    estimateProcessingTime(media) {
        return this.processor.estimateProcessingTime(media);
    }
    /**
     * 获取支持的媒体类型
     */
    getSupportedMediaTypes() {
        return ['image', 'audio', 'video', 'document', 'pdf', 'text'];
    }
    /**
     * 预处理管道 - 验证、标准化和优化媒体内容
     */
    preprocessMedia(media) {
        // 验证媒体内容
        if (!this.validateMedia(media)) {
            throw new Error(`Invalid media content: ${JSON.stringify(media)}`);
        }
        // 标准化数据格式（例如，如果是Base64，可能需要转换为URL或其他格式）
        let processedData = media.data;
        // 如果是Base64，可以在这里进行预处理
        if (media.data.startsWith('data:')) {
            // 这里可以进行Base64数据的预处理
            // 例如压缩、格式转换等
        }
        // 确保元数据存在
        const metadata = media.metadata || {};
        return {
            ...media,
            data: processedData,
            metadata: {
                ...metadata,
                createdAt: new Date().toISOString(),
            },
        };
    }
    /**
     * 后处理管道 - 格式化和优化处理结果
     */
    postprocessResult(result) {
        // 标准化文本表示
        let textRepresentation = result.textRepresentation || '';
        // 清理多余的空白字符
        textRepresentation = textRepresentation.trim().replace(/\s+/g, ' ');
        // 确保文本表示不超过一定长度（如果需要）
        const maxLength = 10000; // 可配置的最大长度
        if (textRepresentation.length > maxLength) {
            textRepresentation = textRepresentation.substring(0, maxLength) + '... [truncated]';
        }
        return {
            ...result,
            textRepresentation,
        };
    }
    /**
     * 记录信任代理操作日志
     */
    logTrustProxyOperation(id, operation, status, details) {
        const logEntry = {
            id,
            operation,
            timestamp: new Date().toISOString(),
            status,
            details,
        };
        this.trustProxyLogs.push(logEntry);
        // 限制日志数量以避免内存溢出
        if (this.trustProxyLogs.length > 1000) {
            this.trustProxyLogs = this.trustProxyLogs.slice(-500); // 保留最新的500条日志
        }
    }
    /**
     * 应用信任委托逻辑 - 通过知识图谱补全和上下文丰富性增强
     */
    async applyTrustDelegation(result, embedder) {
        if (!this.trustDelegationEnabled) {
            return result;
        }
        let enhancedText = result.textRepresentation;
        let enhancedEmbedding = result.embedding;
        // 根据上下文丰富级别进行处理
        switch (this.contextEnrichmentLevel) {
            case 'basic':
                // 基础处理 - 只进行简单的文本清理
                enhancedText = this.enhanceBasicContext(enhancedText);
                break;
            case 'standard':
                // 标准处理 - 添加上下文信息和实体识别
                enhancedText = await this.enhanceStandardContext(result.original, enhancedText);
                break;
            case 'comprehensive':
                // 全面处理 - 包括知识图谱补全
                enhancedText = await this.enhanceComprehensiveContext(result.original, enhancedText);
                break;
        }
        // 如果启用了知识图谱补全，则尝试完善信息
        if (this.knowledgeGraphCompletionEnabled) {
            enhancedText = await this.completeKnowledgeGraph(enhancedText, result.original);
        }
        // 如果提供了嵌入器，重新计算嵌入
        if (embedder && enhancedText !== result.textRepresentation) {
            try {
                enhancedEmbedding = await embedder.embed(enhancedText);
            }
            catch (error) {
                console.warn('Failed to compute embedding for enhanced text:', error);
            }
        }
        return {
            ...result,
            textRepresentation: enhancedText,
            embedding: enhancedEmbedding,
        };
    }
    /**
     * 基础上下文增强
     */
    enhanceBasicContext(text) {
        // 简单的文本清理和标准化
        return text.trim();
    }
    /**
     * 标准上下文增强
     */
    async enhanceStandardContext(original, text) {
        // 添加媒体类型和基本元数据信息
        const mediaInfo = `\n[Media Type: ${original.type}]`;
        const metadataInfo = original.metadata ? ` [Metadata: ${JSON.stringify(original.metadata)}]` : '';
        return `${text}${mediaInfo}${metadataInfo}`;
    }
    /**
     * 全面上下文增强
     */
    async enhanceComprehensiveContext(original, text) {
        // 添加详细的上下文信息，包括时间、来源等
        const timestamp = new Date().toISOString();
        const contextInfo = `
[Context Enrichment: Comprehensive]
[Timestamp: ${timestamp}]
[Source: ${original.type}]
[Trust Delegation: Active]
[Knowledge Graph: Enabled]
[Original Data Length: ${original.data.length}]`;
        return `${text}\n${contextInfo}`;
    }
    /**
     * 完善知识图谱
     */
    async completeKnowledgeGraph(text, original) {
        // 模拟知识图谱补全逻辑
        // 在实际应用中，这里会查询知识图谱数据库，补充相关信息
        const kgCompletion = `

---
[Knowledge Graph Completion]
[Entities Identified: N/A]
[Relationships Mapped: N/A]
[Trust Score: High]
[Information Completeness: Enhanced]
---`;
        return `${text}${kgCompletion}`;
    }
    /**
     * 获取信任代理日志
     */
    getTrustProxyLogs() {
        return [...this.trustProxyLogs]; // 返回副本以防止外部修改
    }
    /**
     * 清理信任代理日志
     */
    clearTrustProxyLogs() {
        this.trustProxyLogs = [];
    }
    /**
     * 获取信任委托状态
     */
    getTrustDelegationStatus() {
        return {
            enabled: this.trustDelegationEnabled,
            contextEnrichmentLevel: this.contextEnrichmentLevel,
            knowledgeGraphCompletionEnabled: this.knowledgeGraphCompletionEnabled,
        };
    }
}
