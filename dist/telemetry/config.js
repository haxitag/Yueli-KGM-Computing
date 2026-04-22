/**
 * 遥测系统配置
 */
/**
 * 默认配置
 */
export const DEFAULT_TELEMETRY_CONFIG = {
    enabled: true,
    serviceName: 'kgm-computing',
    serviceVersion: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    samplingRate: 0.1,
    tracing: {
        enabled: true,
        autoInstrumentation: true,
        exporter: 'console',
        exporterConfig: {
            serviceName: 'kgm-computing',
        },
        captureRequestBody: false,
        captureResponseBody: false,
    },
    metrics: {
        enabled: true,
        exporter: 'console',
        exporterConfig: {
            port: 9464,
            endpoint: '/metrics',
        },
        flushIntervalMs: 5000,
        predefinedMetrics: [
            {
                name: 'kgm.request.duration',
                type: 'histogram',
                description: 'HTTP request duration in milliseconds',
                unit: 'ms',
                labelKeys: ['method', 'route', 'status_code', 'service'],
            },
            {
                name: 'kgm.request.total',
                type: 'counter',
                description: 'Total HTTP requests',
                labelKeys: ['method', 'route', 'status_code', 'service'],
            },
            {
                name: 'kgm.error.total',
                type: 'counter',
                description: 'Total errors',
                labelKeys: ['type', 'severity', 'service'],
            },
            {
                name: 'kgm.cpu.usage',
                type: 'gauge',
                description: 'CPU usage percentage',
                unit: 'percent',
                labelKeys: ['service'],
            },
            {
                name: 'kgm.memory.usage',
                type: 'gauge',
                description: 'Memory usage in bytes',
                unit: 'bytes',
                labelKeys: ['service'],
            },
            {
                name: 'kgm.active.connections',
                type: 'gauge',
                description: 'Active connections',
                labelKeys: ['service'],
            },
            {
                name: 'kgm.queue.size',
                type: 'gauge',
                description: 'Queue size',
                labelKeys: ['queue', 'service'],
            },
            {
                name: 'kgm.cache.hit_rate',
                type: 'gauge',
                description: 'Cache hit rate',
                unit: 'percent',
                labelKeys: ['cache', 'service'],
            },
        ],
    },
    logging: {
        enabled: true,
        level: 'info',
        exporter: 'console',
        exporterConfig: {},
        structured: true,
        includeStack: true,
    },
    dashboard: {
        enabled: true,
        retentionMs: 24 * 60 * 60 * 1000,
        refreshInterval: 5000,
    },
    alerts: {
        enabled: true,
        rules: [
            {
                id: 'high_response_time',
                name: 'High Response Time',
                metric: 'kgm.request.duration',
                condition: 'value > 1000',
                threshold: 1000,
                duration: 60,
                severity: 'high',
                messageTemplate: 'Service {{service}} response time is high: {{value}}ms',
                enabled: true,
            },
            {
                id: 'high_error_rate',
                name: 'High Error Rate',
                metric: 'kgm.error.total',
                condition: 'rate > 0.05',
                threshold: 0.05,
                duration: 300,
                severity: 'high',
                messageTemplate: 'Service {{service}} error rate is high: {{value}}',
                enabled: true,
            },
            {
                id: 'high_cpu_usage',
                name: 'High CPU Usage',
                metric: 'kgm.cpu.usage',
                condition: 'value > 0.8',
                threshold: 0.8,
                duration: 60,
                severity: 'medium',
                messageTemplate: 'Service {{service}} CPU usage is high: {{value}}',
                enabled: true,
            },
            {
                id: 'high_memory_usage',
                name: 'High Memory Usage',
                metric: 'kgm.memory.usage',
                condition: 'value > 1073741824', // 1GB
                threshold: 1073741824,
                duration: 60,
                severity: 'critical',
                messageTemplate: 'Service {{service}} memory usage is high: {{value}} bytes',
                enabled: true,
            },
        ],
        notificationChannels: [
            {
                type: 'console',
                config: {},
            },
        ],
        inhibitionRules: [],
    },
    performance: {
        enabled: true,
        collectionIntervalMs: 5000,
        monitorGarbageCollection: true,
        monitorEventLoop: true,
        monitorHeap: true,
        thresholds: {
            responseTime: 1000,
            errorRate: 0.05,
            cpuUsage: 0.8,
            memoryUsage: 1073741824, // 1GB
            eventLoopDelay: 200,
        },
    },
    businessMetrics: {
        enabled: true,
        definitions: [
            {
                name: 'active_users',
                type: 'gauge',
                description: 'Number of active users',
                labels: ['service', 'region'],
            },
            {
                name: 'conversion_rate',
                type: 'gauge',
                description: 'Conversion rate',
                unit: 'percent',
                labels: ['service', 'campaign'],
            },
            {
                name: 'revenue',
                type: 'counter',
                description: 'Total revenue',
                labels: ['service', 'product'],
            },
            {
                name: 'inference_requests',
                type: 'counter',
                description: 'Total inference requests',
                labels: ['model', 'service'],
            },
            {
                name: 'inference_duration',
                type: 'histogram',
                description: 'Inference duration',
                unit: 'ms',
                labels: ['model', 'service'],
            },
        ],
    },
    integrations: {
        errorHandling: true,
        retrySystem: true,
        cacheSystem: true,
        database: false,
        messageQueue: false,
    },
};
/**
 * 从环境变量加载配置
 */
export function loadTelemetryConfigFromEnv() {
    const config = { ...DEFAULT_TELEMETRY_CONFIG };
    // 从环境变量读取基本配置
    if (process.env.KGM_TELEMETRY_ENABLED) {
        config.enabled = process.env.KGM_TELEMETRY_ENABLED === 'true';
    }
    if (process.env.KGM_SERVICE_NAME) {
        config.serviceName = process.env.KGM_SERVICE_NAME;
    }
    if (process.env.KGM_SERVICE_VERSION) {
        config.serviceVersion = process.env.KGM_SERVICE_VERSION;
    }
    if (process.env.NODE_ENV) {
        config.environment = process.env.NODE_ENV;
    }
    if (process.env.KGM_TELEMETRY_SAMPLING_RATE) {
        const rate = parseFloat(process.env.KGM_TELEMETRY_SAMPLING_RATE);
        if (!isNaN(rate) && rate >= 0 && rate <= 1) {
            config.samplingRate = rate;
        }
    }
    // 从环境变量读取追踪配置
    if (process.env.KGM_TRACING_EXPORTER) {
        if (['console', 'jaeger', 'otlp'].includes(process.env.KGM_TRACING_EXPORTER)) {
            config.tracing.exporter = process.env.KGM_TRACING_EXPORTER;
        }
    }
    if (process.env.JAEGER_ENDPOINT) {
        config.tracing.exporterConfig.endpoint = process.env.JAEGER_ENDPOINT;
    }
    // 从环境变量读取指标配置
    if (process.env.KGM_METRICS_EXPORTER) {
        if (['console', 'prometheus', 'otlp'].includes(process.env.KGM_METRICS_EXPORTER)) {
            config.metrics.exporter = process.env.KGM_METRICS_EXPORTER;
        }
    }
    if (process.env.KGM_METRICS_PORT) {
        const port = parseInt(process.env.KGM_METRICS_PORT);
        if (!isNaN(port)) {
            config.metrics.exporterConfig.port = port;
        }
    }
    // 从环境变量读取日志配置
    if (process.env.KGM_LOG_LEVEL) {
        const level = process.env.KGM_LOG_LEVEL.toLowerCase();
        if (['debug', 'info', 'warn', 'error'].includes(level)) {
            config.logging.level = level;
        }
    }
    // 从环境变量读取性能配置
    if (process.env.KGM_PERF_RESPONSE_TIME_THRESHOLD) {
        const threshold = parseInt(process.env.KGM_PERF_RESPONSE_TIME_THRESHOLD);
        if (!isNaN(threshold)) {
            config.performance.thresholds.responseTime = threshold;
        }
    }
    if (process.env.KGM_PERF_ERROR_RATE_THRESHOLD) {
        const threshold = parseFloat(process.env.KGM_PERF_ERROR_RATE_THRESHOLD);
        if (!isNaN(threshold)) {
            config.performance.thresholds.errorRate = threshold;
        }
    }
    return config;
}
/**
 * 验证配置
 */
export function validateTelemetryConfig(config) {
    const errors = [];
    if (config.samplingRate < 0 || config.samplingRate > 1) {
        errors.push('samplingRate must be between 0 and 1');
    }
    if (config.serviceName.trim().length === 0) {
        errors.push('serviceName is required');
    }
    if (config.serviceVersion.trim().length === 0) {
        errors.push('serviceVersion is required');
    }
    if (config.metrics.flushIntervalMs < 1000) {
        errors.push('metrics.flushIntervalMs must be at least 1000ms');
    }
    if (config.performance.collectionIntervalMs < 1000) {
        errors.push('performance.collectionIntervalMs must be at least 1000ms');
    }
    if (config.performance.thresholds.responseTime < 0) {
        errors.push('performance.thresholds.responseTime must be >= 0');
    }
    if (config.performance.thresholds.errorRate < 0 || config.performance.thresholds.errorRate > 1) {
        errors.push('performance.thresholds.errorRate must be between 0 and 1');
    }
    if (config.performance.thresholds.cpuUsage < 0 || config.performance.thresholds.cpuUsage > 1) {
        errors.push('performance.thresholds.cpuUsage must be between 0 and 1');
    }
    if (config.performance.thresholds.memoryUsage < 0) {
        errors.push('performance.thresholds.memoryUsage must be >= 0');
    }
    return errors;
}
/**
 * 配置管理器
 */
export class TelemetryConfigManager {
    static instance;
    config;
    constructor(config) {
        this.config = config || loadTelemetryConfigFromEnv();
        const errors = validateTelemetryConfig(this.config);
        if (errors.length > 0) {
            console.warn('Telemetry configuration validation warnings:', errors);
        }
    }
    static getInstance(config) {
        if (!TelemetryConfigManager.instance) {
            TelemetryConfigManager.instance = new TelemetryConfigManager(config);
        }
        return TelemetryConfigManager.instance;
    }
    getConfig() {
        return { ...this.config };
    }
    updateConfig(updates) {
        const newConfig = { ...this.config, ...updates };
        const errors = validateTelemetryConfig(newConfig);
        if (errors.length > 0) {
            throw new Error(`Invalid telemetry configuration: ${errors.join(', ')}`);
        }
        this.config = newConfig;
    }
    isEnabled() {
        return this.config.enabled;
    }
    getServiceInfo() {
        return {
            name: this.config.serviceName,
            version: this.config.serviceVersion,
            environment: this.config.environment,
        };
    }
    shouldSample() {
        return Math.random() < this.config.samplingRate;
    }
}
