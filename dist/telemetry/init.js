/**
 * 监控系统初始化器
 * 集成错误处理、遥测和监控仪表板
 */
import { createDefaultErrorMonitor } from '../errors/monitoring.js';
import { GlobalErrorHandler } from '../errors/integration.js';
import { RetryManagerFactory } from '../errors/recovery.js';
import { createDefaultTelemetryManager } from './advanced.js';
import { MonitoringDashboard, DEFAULT_MONITORING_CONFIG } from './dashboard.js';
import { TelemetryConfigManager } from './config.js';
/**
 * 初始化监控系统
 */
export async function initializeMonitoring(options = {}) {
    const configManager = TelemetryConfigManager.getInstance();
    // 如果禁用监控，返回空实现
    if (!configManager.isEnabled()) {
        console.log('📊 监控系统已禁用');
        return createDisabledMonitoringSystem();
    }
    const serviceName = options.serviceName || configManager.getServiceInfo().name;
    const serviceVersion = options.serviceVersion || configManager.getServiceInfo().version;
    const environment = options.environment || configManager.getServiceInfo().environment;
    console.log(`🚀 启动监控系统 - ${serviceName} v${serviceVersion} (${environment})`);
    // 初始化错误监控器
    const errorMonitor = createDefaultErrorMonitor();
    // 初始化全局错误处理器
    const errorHandler = GlobalErrorHandler.getInstance();
    errorHandler.setErrorMonitor(errorMonitor);
    // 初始化重试管理器
    const inferenceRetryManager = RetryManagerFactory.createStandardRetryManager('inference');
    const networkRetryManager = RetryManagerFactory.createStandardRetryManager('network');
    // 初始化遥测管理器
    const telemetry = createDefaultTelemetryManager(serviceName, environment);
    // 初始化监控仪表板
    const dashboard = new MonitoringDashboard(DEFAULT_MONITORING_CONFIG);
    // 设置集成
    errorMonitor.setTelemetry(telemetry);
    dashboard.setTelemetry(telemetry);
    dashboard.setErrorMonitor(errorMonitor);
    dashboard.setRetryManager('inference', inferenceRetryManager);
    dashboard.setRetryManager('network', networkRetryManager);
    // 启动遥测系统
    if (options.enableTelemetry !== false) {
        await telemetry.start();
    }
    // 立即收集一次指标
    dashboard.collectMetrics();
    const system = {
        errorMonitor,
        errorHandler,
        telemetry,
        dashboard,
        async start() {
            if (options.enableTelemetry !== false) {
                await telemetry.start();
            }
            // 定期收集指标
            setInterval(() => {
                dashboard.collectMetrics();
            }, 5000);
            console.log('✅ 监控系统已就绪');
        },
        async stop() {
            if (telemetry) {
                await telemetry.stop();
            }
            console.log('🛑 监控系统已停止');
        },
        setupExpress(app) {
            if (options.enableDashboard !== false) {
                dashboard.setupRoutes(app);
            }
            // 添加全局错误处理中间件
            app.use((error, req, res, next) => {
                errorHandler.recordError(error, {
                    service: serviceName,
                    context: {
                        url: req.url,
                        method: req.method,
                        ip: req.ip,
                    },
                });
                // 这里可以添加自定义的错误响应格式
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        error: {
                            message: 'Internal server error',
                            code: 'INTERNAL_ERROR',
                            requestId: req.headers['x-request-id'] || undefined,
                        },
                    });
                }
            });
            // 添加请求监控中间件
            app.use((req, res, next) => {
                const startTime = Date.now();
                // 记录请求开始
                telemetry?.recordMetric('kgm.request.total', 1, {
                    method: req.method,
                    route: req.path,
                    service: serviceName,
                });
                // 拦截响应结束事件
                const originalEnd = res.end;
                res.end = function (...args) {
                    const duration = Date.now() - startTime;
                    const statusCode = res.statusCode;
                    // 记录请求持续时间
                    telemetry?.recordMetric('kgm.request.duration', duration, {
                        method: req.method,
                        route: req.path,
                        status_code: String(statusCode),
                        service: serviceName,
                    });
                    // 记录错误（如果状态码是5xx）
                    if (statusCode >= 500 && statusCode < 600) {
                        telemetry?.recordMetric('kgm.error.total', 1, {
                            type: 'http',
                            service: serviceName,
                            status_code: String(statusCode),
                        });
                    }
                    // 记录性能指标
                    telemetry?.recordPerformance({
                        responseTime: duration,
                    }, serviceName);
                    // 调用原始end方法
                    return originalEnd.apply(this, args);
                };
                next();
            });
        },
        getHealthInfo() {
            const health = telemetry?.getServiceHealth();
            const metrics = dashboard.collectMetrics();
            return {
                service: serviceName,
                version: serviceVersion,
                environment,
                status: health?.status || 'unknown',
                score: health?.score || 0,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                metrics: {
                    system: metrics.system,
                    application: metrics.application,
                },
            };
        },
    };
    return system;
}
/**
 * 创建禁用状态的监控系统
 */
function createDisabledMonitoringSystem() {
    const emptyObject = {};
    return {
        errorMonitor: emptyObject,
        errorHandler: GlobalErrorHandler.getInstance(),
        telemetry: {
            start: async () => { },
            stop: async () => { },
            recordTransaction: () => ({}),
            recordSpan: async (name, fn) => fn({}),
            recordMetric: () => { },
            recordPerformance: () => { },
            getServiceHealth: () => ({ status: 'unknown', score: 0, issues: [] }),
            triggerAlert: () => { },
            getAlertRules: () => [],
            addAlertRule: () => { },
            removeAlertRule: () => { },
        },
        dashboard: {
            setupRoutes: () => { },
            collectMetrics: () => ({}),
        },
        async start() {
            console.log('📊 监控系统已禁用（空实现）');
        },
        async stop() { },
        setupExpress() { },
        getHealthInfo() {
            return {
                status: 'disabled',
                message: 'Monitoring system is disabled',
                timestamp: new Date().toISOString(),
            };
        },
    };
}
/**
 * 快速初始化函数（简化版）
 */
export async function initMonitoring(options) {
    try {
        const system = await initializeMonitoring(options);
        await system.start();
        // 将系统实例挂载到全局对象（方便调试）
        if (typeof globalThis !== 'undefined') {
            globalThis.kgmMonitoring = system;
        }
        return system;
    }
    catch (error) {
        console.error('Failed to initialize monitoring system:', error);
        // 返回禁用状态的系统
        return createDisabledMonitoringSystem();
    }
}
/**
 * 创建监控中间件工厂
 */
export function createMonitoringMiddleware(serviceName) {
    return async (req, res, next) => {
        try {
            // 确保监控系统已初始化
            if (!globalThis.kgmMonitoring) {
                await initMonitoring({ serviceName });
            }
            const system = globalThis.kgmMonitoring;
            // 记录请求开始时间
            req._monitoringStartTime = Date.now();
            req._monitoringSystem = system;
            next();
        }
        catch (error) {
            console.error('Monitoring middleware error:', error);
            next();
        }
    };
}
/**
 * 导出常用工具函数
 */
export const Monitoring = {
    /**
     * 记录错误
     */
    recordError(error, context) {
        const system = globalThis.kgmMonitoring;
        if (system?.errorMonitor) {
            system.errorMonitor.recordError(error, context);
        }
    },
    /**
     * 记录业务指标
     */
    recordBusinessMetric(name, value, labels) {
        const system = globalThis.kgmMonitoring;
        if (system?.telemetry) {
            system.telemetry.recordBusinessMetric?.(name, value, labels);
        }
    },
    /**
     * 记录性能指标
     */
    recordPerformance(metrics, service) {
        const system = globalThis.kgmMonitoring;
        if (system?.telemetry) {
            system.telemetry.recordPerformance(metrics, service);
        }
    },
    /**
     * 获取健康状态
     */
    getHealth() {
        const system = globalThis.kgmMonitoring;
        return system?.getHealthInfo?.() || {
            status: 'unknown',
            message: 'Monitoring system not initialized',
        };
    },
    /**
     * 检查系统健康
     */
    async healthCheck() {
        try {
            const system = globalThis.kgmMonitoring;
            if (!system) {
                return {
                    status: 'degraded',
                    details: {
                        monitoring: 'Monitoring system not initialized',
                    },
                };
            }
            const health = system.getHealthInfo();
            if (health.status === 'healthy') {
                return {
                    status: 'ok',
                    details: health,
                };
            }
            else if (health.status === 'degraded') {
                return {
                    status: 'degraded',
                    details: health,
                };
            }
            else {
                return {
                    status: 'failed',
                    details: health,
                };
            }
        }
        catch (error) {
            return {
                status: 'failed',
                details: {
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: new Date().toISOString(),
                },
            };
        }
    },
};
