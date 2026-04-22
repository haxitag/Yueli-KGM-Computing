/**
 * 高级遥测和监控系统
 * 提供企业级的可观测性、监控和告警功能
 */
import { metrics, trace, context } from '@opentelemetry/api';
/**
 * 高级遥测管理器
 */
export class AdvancedTelemetryManager {
    config;
    otelManager;
    tracer = trace.getTracer('kgm-telemetry');
    meter = metrics.getMeter('kgm-telemetry');
    metricsMap = new Map();
    alerts = [];
    performanceData = new Map();
    businessData = new Map();
    flushInterval;
    constructor(config, otelManager) {
        this.config = config;
        this.otelManager = otelManager;
        this.initializeDefaultMetrics();
        this.setupAutoFlush();
    }
    /**
     * 启动监控
     */
    async start() {
        if (this.otelManager) {
            await this.otelManager.initialize();
        }
        // 启动性能收集
        this.startPerformanceCollection();
        console.log('📊 高级遥测系统已启动');
    }
    /**
     * 停止监控
     */
    async stop() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }
        if (this.otelManager) {
            // await this.otelManager.shutdown();
        }
        console.log('📊 高级遥测系统已停止');
    }
    /**
     * 记录业务交易
     */
    recordTransaction(name, attributes, startTime) {
        return this.tracer.startActiveSpan(name, {
            startTime,
            attributes: {
                'transaction.name': name,
                'service.name': this.config.serviceName,
                'service.version': this.config.serviceVersion,
                'environment': this.config.environment,
                ...attributes,
            },
        }, context.active(), (span) => {
            return context.active();
        });
    }
    /**
     * 记录自定义span
     */
    recordSpan(name, fn) {
        return this.tracer.startActiveSpan(name, async (span) => {
            try {
                const result = await fn(span);
                span.setStatus({ code: trace.SpanStatusCode.OK });
                return result;
            }
            catch (error) {
                span.setStatus({
                    code: trace.SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error)
                });
                span.recordException(error);
                throw error;
            }
            finally {
                span.end();
            }
        });
    }
    /**
     * 记录指标
     */
    recordMetric(name, value, labels, description) {
        if (!this.config.enableMetrics)
            return;
        // 记录到OpenTelemetry
        const metricDefinition = this.metricsMap.get(name) || {
            name,
            type: 'histogram',
            description: description || `Metric: ${name}`,
        };
        switch (metricDefinition.type) {
            case 'counter':
                this.meter.createCounter(name, {
                    description: metricDefinition.description,
                }).add(value, labels);
                break;
            case 'gauge':
                this.meter.createObservableGauge(name, (observableResult) => {
                    observableResult.observe(value, labels);
                }, {
                    description: metricDefinition.description,
                });
                break;
            case 'histogram':
                this.meter.createHistogram(name, {
                    description: metricDefinition.description,
                }).record(value, labels);
                break;
            case 'summary':
                // Summary在OpenTelemetry中不支持，使用Histogram代替
                this.meter.createHistogram(name, {
                    description: metricDefinition.description,
                }).record(value, labels);
                break;
        }
        // 记录到本地缓存用于告警计算
        this.cacheMetricValue(name, value, labels);
    }
    /**
     * 记录性能指标
     */
    recordPerformance(metrics, service) {
        if (!this.config.enablePerformanceMetrics)
            return;
        const serviceKey = service || 'global';
        const now = Date.now();
        const perfData = this.performanceData.get(serviceKey) || [];
        const fullMetrics = {
            responseTime: metrics.responseTime || 0,
            throughput: metrics.throughput || 0,
            errorRate: metrics.errorRate || 0,
            cpuUsage: metrics.cpuUsage || 0,
            memoryUsage: metrics.memoryUsage || 0,
            gcTime: metrics.gcTime || 0,
            eventLoopDelay: metrics.eventLoopDelay || 0,
        };
        perfData.push(fullMetrics);
        // 保留最近的数据
        const cutoff = now - this.config.metricsRetentionMs;
        const filtered = perfData.filter((data, index) => {
            // 这里应该有时间戳，为了简化使用索引
            return index > perfData.length - 1000; // 保留最近1000条
        });
        this.performanceData.set(serviceKey, filtered);
        // 检查告警规则
        this.checkPerformanceAlerts(serviceKey, fullMetrics);
    }
    /**
     * 记录业务指标
     */
    recordBusinessMetric(name, value, labels) {
        if (!this.config.enableBusinessMetrics)
            return;
        this.recordMetric(`business.${name}`, value, labels, `Business metric: ${name}`);
        // 记录到本地缓存
        const serviceKey = labels?.service || 'global';
        const businessData = this.businessData.get(serviceKey) || [];
        const businessMetric = {};
        businessMetric[name] = value;
        businessData.push(businessMetric);
        // 保留最近的数据
        if (businessData.length > 1000) {
            businessData.shift();
        }
        this.businessData.set(serviceKey, businessData);
    }
    /**
     * 获取性能报告
     */
    getPerformanceReport(service) {
        const serviceKey = service || 'global';
        const data = this.performanceData.get(serviceKey) || [];
        if (data.length === 0) {
            return {
                responseTime: 0,
                throughput: 0,
                errorRate: 0,
                cpuUsage: 0,
                memoryUsage: 0,
                gcTime: 0,
                eventLoopDelay: 0,
            };
        }
        const sum = data.reduce((acc, curr) => ({
            responseTime: acc.responseTime + curr.responseTime,
            throughput: acc.throughput + curr.throughput,
            errorRate: acc.errorRate + curr.errorRate,
            cpuUsage: acc.cpuUsage + curr.cpuUsage,
            memoryUsage: acc.memoryUsage + curr.memoryUsage,
            gcTime: acc.gcTime + curr.gcTime,
            eventLoopDelay: acc.eventLoopDelay + curr.eventLoopDelay,
        }));
        const count = data.length;
        return {
            responseTime: sum.responseTime / count,
            throughput: sum.throughput / count,
            errorRate: sum.errorRate / count,
            cpuUsage: sum.cpuUsage / count,
            memoryUsage: sum.memoryUsage / count,
            gcTime: sum.gcTime / count,
            eventLoopDelay: sum.eventLoopDelay / count,
        };
    }
    /**
     * 获取健康状态
     */
    getServiceHealth(service) {
        const performance = this.getPerformanceReport(service);
        const issues = [];
        let score = 100;
        // 检查响应时间
        if (performance.responseTime > 1000) {
            issues.push(`响应时间过高: ${performance.responseTime.toFixed(2)}ms`);
            score -= 20;
        }
        // 检查错误率
        if (performance.errorRate > 0.05) {
            issues.push(`错误率过高: ${(performance.errorRate * 100).toFixed(2)}%`);
            score -= 30;
        }
        // 检查内存使用
        if (performance.memoryUsage > 1024) { // 超过1GB
            issues.push(`内存使用过高: ${performance.memoryUsage.toFixed(2)}MB`);
            score -= 15;
        }
        // 检查CPU使用
        if (performance.cpuUsage > 0.8) {
            issues.push(`CPU使用过高: ${(performance.cpuUsage * 100).toFixed(2)}%`);
            score -= 20;
        }
        // 判断状态
        let status = 'healthy';
        if (score < 50) {
            status = 'unhealthy';
        }
        else if (score < 80) {
            status = 'degraded';
        }
        return {
            status,
            score,
            issues,
        };
    }
    /**
     * 添加告警规则
     */
    addAlertRule(rule) {
        const existingIndex = this.alerts.findIndex(r => r.id === rule.id);
        if (existingIndex >= 0) {
            this.alerts[existingIndex] = rule;
        }
        else {
            this.alerts.push(rule);
        }
    }
    /**
     * 移除告警规则
     */
    removeAlertRule(ruleId) {
        this.alerts = this.alerts.filter(rule => rule.id !== ruleId);
    }
    /**
     * 获取告警规则
     */
    getAlertRules() {
        return [...this.alerts];
    }
    /**
     * 触发告警
     */
    triggerAlert(ruleId, details) {
        const rule = this.alerts.find(r => r.id === ruleId);
        if (!rule || !rule.enabled)
            return;
        console.log(`🚨 触发告警: ${rule.name}`);
        console.log(`严重级别: ${rule.severity}`);
        console.log(`条件: ${rule.condition}`);
        console.log(`详情:`, details);
        // 这里应该发送到实际的告警渠道（邮件、Slack、Webhook等）
        // 为了演示，我们只打印到控制台
        // 可以集成到现有的错误监控系统
        if (typeof globalThis.errorMonitor?.recordError === 'function') {
            globalThis.errorMonitor.recordError(new Error(`Alert triggered: ${rule.name}`), {
                service: this.config.serviceName,
                context: {
                    alertId: rule.id,
                    severity: rule.severity,
                    condition: rule.condition,
                    details,
                },
            });
        }
    }
    initializeDefaultMetrics() {
        const defaultMetrics = [
            {
                name: 'kgm.request.duration',
                type: 'histogram',
                description: '请求持续时间',
                unit: 'ms',
                labelKeys: ['method', 'route', 'status_code'],
            },
            {
                name: 'kgm.request.count',
                type: 'counter',
                description: '请求总数',
                labelKeys: ['method', 'route', 'status_code'],
            },
            {
                name: 'kgm.error.count',
                type: 'counter',
                description: '错误总数',
                labelKeys: ['type', 'service', 'severity'],
            },
            {
                name: 'kgm.cpu.usage',
                type: 'gauge',
                description: 'CPU使用率',
                unit: 'percent',
            },
            {
                name: 'kgm.memory.usage',
                type: 'gauge',
                description: '内存使用量',
                unit: 'bytes',
            },
            {
                name: 'kgm.active.connections',
                type: 'gauge',
                description: '活跃连接数',
            },
            {
                name: 'kgm.queue.size',
                type: 'gauge',
                description: '队列大小',
            },
            {
                name: 'kgm.cache.hit_rate',
                type: 'gauge',
                description: '缓存命中率',
                unit: 'percent',
            },
        ];
        defaultMetrics.forEach(metric => {
            this.metricsMap.set(metric.name, metric);
        });
        // 添加默认告警规则
        this.alerts.push({
            id: 'response_time_high',
            name: '响应时间过高',
            metric: 'kgm.request.duration',
            condition: 'value > 1000',
            threshold: 1000,
            duration: 60,
            severity: 'high',
            messageTemplate: '服务 {{service}} 响应时间超过 {{threshold}}ms，当前: {{value}}ms',
            enabled: true,
        }, {
            id: 'error_rate_high',
            name: '错误率过高',
            metric: 'kgm.error.count',
            condition: 'rate > 0.05',
            threshold: 0.05,
            duration: 300,
            severity: 'high',
            messageTemplate: '服务 {{service}} 错误率超过 {{threshold}}，当前: {{value}}',
            enabled: true,
        }, {
            id: 'cpu_usage_high',
            name: 'CPU使用率过高',
            metric: 'kgm.cpu.usage',
            condition: 'value > 0.8',
            threshold: 0.8,
            duration: 60,
            severity: 'medium',
            messageTemplate: '服务 {{service}} CPU使用率超过 {{threshold}}，当前: {{value}}',
            enabled: true,
        }, {
            id: 'memory_usage_high',
            name: '内存使用过高',
            metric: 'kgm.memory.usage',
            condition: 'value > 1073741824', // 1GB
            threshold: 1073741824,
            duration: 60,
            severity: 'critical',
            messageTemplate: '服务 {{service}} 内存使用超过 {{threshold}} 字节，当前: {{value}} 字节',
            enabled: true,
        });
    }
    cacheMetricValue(name, value, labels) {
        // 这里可以实现更复杂的缓存逻辑，比如时间序列数据库
        // 为了简化，我们只记录到内存中用于简单的告警检查
        // 检查是否有匹配的告警规则
        for (const rule of this.alerts) {
            if (rule.enabled && rule.metric === name) {
                this.checkMetricRule(rule, value, labels);
            }
        }
    }
    checkMetricRule(rule, value, labels) {
        // 简单的条件检查（实际应该使用表达式求值器）
        const match = rule.condition.match(/value\s*([><=!]+)\s*([\d.]+)/);
        if (!match)
            return;
        const [_, operator, thresholdStr] = match;
        const threshold = parseFloat(thresholdStr);
        let triggered = false;
        switch (operator) {
            case '>':
                triggered = value > threshold;
                break;
            case '<':
                triggered = value < threshold;
                break;
            case '>=':
                triggered = value >= threshold;
                break;
            case '<=':
                triggered = value <= threshold;
                break;
            case '==':
                triggered = value === threshold;
                break;
            case '!=':
                triggered = value !== threshold;
                break;
        }
        if (triggered) {
            this.triggerAlert(rule.id, {
                value,
                threshold,
                operator,
                labels,
                timestamp: new Date().toISOString(),
            });
        }
    }
    checkPerformanceAlerts(service, metrics) {
        // 检查性能告警
        if (metrics.responseTime > 1000) {
            this.triggerAlert('response_time_high', {
                service,
                value: metrics.responseTime,
                threshold: 1000,
            });
        }
        if (metrics.errorRate > 0.05) {
            this.triggerAlert('error_rate_high', {
                service,
                value: metrics.errorRate,
                threshold: 0.05,
            });
        }
        if (metrics.cpuUsage > 0.8) {
            this.triggerAlert('cpu_usage_high', {
                service,
                value: metrics.cpuUsage,
                threshold: 0.8,
            });
        }
        if (metrics.memoryUsage > 1024) {
            this.triggerAlert('memory_usage_high', {
                service,
                value: metrics.memoryUsage,
                threshold: 1024,
            });
        }
    }
    setupAutoFlush() {
        // 每30秒刷新一次数据
        this.flushInterval = setInterval(() => {
            this.flushMetrics();
        }, 30000);
    }
    flushMetrics() {
        // 这里可以添加数据持久化逻辑，比如发送到Prometheus、InfluxDB等
        const performance = this.getPerformanceReport();
        console.debug('[Telemetry] Flushing metrics:', performance);
        // 记录性能摘要
        this.recordMetric('kgm.performance.summary', performance.responseTime, {
            service: this.config.serviceName,
            metric: 'response_time',
        });
    }
    startPerformanceCollection() {
        if (!this.config.enablePerformanceMetrics)
            return;
        // 这里可以添加系统性能指标的定期收集
        // 比如使用perf_hooks、os模块等
        const collectionInterval = setInterval(() => {
            // 收集系统性能指标
            const os = require('os');
            const cpuUsage = process.cpuUsage();
            const totalCpuUsage = (cpuUsage.user + cpuUsage.system) / 1000; // 转换为毫秒
            const performanceMetrics = {
                responseTime: 0, // 从实际请求中获取
                throughput: 0, // 从实际请求中获取
                errorRate: 0, // 从实际请求中获取
                cpuUsage: os.loadavg()[0] / os.cpus().length, // 平均负载除以CPU核心数
                memoryUsage: (os.totalmem() - os.freemem()) / 1024 / 1024, // MB
                gcTime: (process.memoryUsage().heapUsed - 1000) / 1024, // 简化计算
                eventLoopDelay: 0, // 需要实际测量
            };
            this.recordPerformance(performanceMetrics);
        }, 5000); // 每5秒收集一次
        // 存储interval以便清理
        this.performanceInterval = collectionInterval;
    }
}
/**
 * 创建默认的遥测管理器
 */
export function createDefaultTelemetryManager(serviceName = 'kgm-service', environment = process.env.NODE_ENV || 'development') {
    const config = {
        enableTracing: true,
        enableMetrics: true,
        enableLogging: true,
        samplingRate: 0.1,
        serviceName,
        serviceVersion: process.env.npm_package_version || '1.0.0',
        environment,
        enablePerformanceMetrics: true,
        enableBusinessMetrics: true,
        metricsRetentionMs: 24 * 60 * 60 * 1000, // 24小时
    };
    return new AdvancedTelemetryManager(config);
}
