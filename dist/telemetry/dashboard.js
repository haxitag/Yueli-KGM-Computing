/**
 * 监控仪表板API
 * 提供实时监控数据的RESTful API
 */
export class MonitoringDashboard {
    config;
    telemetry;
    errorMonitor;
    retryManagers = new Map();
    metricsHistory = [];
    activeAlerts = new Map();
    alertHistory = [];
    constructor(config) {
        this.config = config;
        this.setupAutoRefresh();
    }
    setTelemetry(telemetry) {
        this.telemetry = telemetry;
    }
    setErrorMonitor(monitor) {
        this.errorMonitor = monitor;
    }
    setRetryManager(service, manager) {
        this.retryManagers.set(service, manager);
    }
    /**
     * 收集当前系统状态
     */
    collectMetrics() {
        const os = require('os');
        const now = new Date();
        // 收集系统指标
        const cpuUsage = process.cpuUsage();
        const loadAvg = os.loadavg();
        const systemMetrics = {
            cpu: {
                usage: (cpuUsage.user + cpuUsage.system) / 1000, // 毫秒
                load: loadAvg,
                cores: os.cpus().length,
            },
            memory: {
                total: os.totalmem(),
                used: os.totalmem() - os.freemem(),
                free: os.freemem(),
                usagePercentage: (1 - os.freemem() / os.totalmem()) * 100,
            },
            disk: {
                total: 0,
                used: 0,
                free: 0,
                usagePercentage: 0,
            },
            network: {
                interfaces: Object.keys(os.networkInterfaces()),
                rxBytes: 0,
                txBytes: 0,
            },
        };
        // 从遥测系统收集应用指标
        const appMetrics = {
            requests: {
                total: 0,
                perSecond: 0,
                byMethod: {},
                byRoute: {},
            },
            responses: {
                status: {},
                latency: {
                    p50: 0,
                    p90: 0,
                    p95: 0,
                    p99: 0,
                    max: 0,
                },
            },
            errors: {
                total: 0,
                byType: {},
                byService: {},
            },
        };
        // 从错误监控器收集错误统计
        if (this.errorMonitor) {
            const errorMetrics = this.errorMonitor.getMetrics();
            if (errorMetrics) {
                appMetrics.errors.total = errorMetrics.totalErrors;
                appMetrics.errors.byType = errorMetrics.errorsByCategory;
                appMetrics.errors.byService = { global: errorMetrics.totalErrors };
            }
        }
        // 业务指标（简化）
        const businessMetrics = {
            activeUsers: Math.floor(Math.random() * 100) + 50,
            conversionRate: 0.15,
            revenue: 15000,
            keyTransactions: {},
        };
        // 健康检查
        const healthStatus = this.telemetry?.getServiceHealth() || {
            status: 'healthy',
            score: 100,
            issues: [],
        };
        // 活跃告警
        const activeAlerts = [];
        const alertHistory = [];
        // 构建完整的指标对象
        const metrics = {
            timestamp: now,
            system: systemMetrics,
            application: appMetrics,
            business: businessMetrics,
            health: healthStatus,
            alerts: {
                active: activeAlerts,
                history: alertHistory,
            },
        };
        // 添加到历史记录
        this.metricsHistory.push(metrics);
        // 清理旧数据
        this.cleanupOldData();
        return metrics;
    }
    /**
     * 设置Express路由
     */
    setupRoutes(app) {
        if (!this.config.enabled)
            return;
        // 认证中间件
        const authMiddleware = this.createAuthMiddleware();
        // 仪表板主页
        app.get('/api/monitoring/dashboard', authMiddleware, (req, res) => {
            const metrics = this.collectMetrics();
            res.json(metrics);
        });
        // 指标历史
        app.get('/api/monitoring/history', authMiddleware, (req, res) => {
            const limit = parseInt(req.query.limit) || 100;
            const history = this.metricsHistory.slice(-limit);
            res.json(history);
        });
        // 性能时间序列
        app.get('/api/monitoring/series/:metric', authMiddleware, (req, res) => {
            const metric = req.params.metric;
            const period = req.query.period || '1h';
            const series = this.generateTimeSeriesData(metric, period);
            res.json({
                metric,
                period,
                data: series,
            });
        });
        // 健康检查
        app.get('/api/monitoring/health', (req, res) => {
            const health = this.telemetry?.getServiceHealth();
            res.json(health || {
                status: 'unknown',
                score: 0,
                issues: ['Monitoring not initialized'],
            });
        });
        // 服务健康详情
        app.get('/api/monitoring/health/:service', authMiddleware, (req, res) => {
            const service = req.params.service;
            const health = this.telemetry?.getServiceHealth(service);
            res.json(health || {
                status: 'unknown',
                score: 0,
                issues: [`Service ${service} metrics not available`],
            });
        });
        // 错误统计
        app.get('/api/monitoring/errors', authMiddleware, (req, res) => {
            if (!this.errorMonitor) {
                res.json({ error: 'Error monitor not available' });
                return;
            }
            const aggregations = this.errorMonitor.getAggregations();
            const metrics = this.errorMonitor.getMetrics();
            res.json({
                summary: metrics,
                aggregations,
            });
        });
        // 错误趋势
        app.get('/api/monitoring/errors/trends', authMiddleware, (req, res) => {
            if (!this.errorMonitor) {
                res.json({ error: 'Error monitor not available' });
                return;
            }
            const service = req.query.service || 'global';
            const timeRange = parseInt(req.query.timeRange) || 30 * 60 * 1000;
            const trends = this.errorMonitor.getErrorTrends(service, timeRange);
            res.json({
                service,
                timeRange,
                trends,
            });
        });
        // 重试统计
        app.get('/api/monitoring/retries/:service?', authMiddleware, (req, res) => {
            const service = req.params.service || 'inference';
            const manager = this.retryManagers.get(service);
            if (!manager) {
                res.json({
                    error: `Retry manager for service ${service} not found`,
                    availableServices: Array.from(this.retryManagers.keys()),
                });
                return;
            }
            const stats = manager.getStats();
            const circuitBreaker = manager.getCircuitBreakerMetrics();
            res.json({
                service,
                stats,
                circuitBreaker,
            });
        });
        // 告警配置
        app.get('/api/monitoring/alerts', authMiddleware, (req, res) => {
            const alerts = this.telemetry?.getAlertRules() || [];
            res.json({
                total: alerts.length,
                alerts,
            });
        });
        // 触发告警（测试用）
        app.post('/api/monitoring/alerts/:id/trigger', authMiddleware, (req, res) => {
            const alertId = req.params.id;
            this.telemetry?.triggerAlert(alertId, req.body);
            res.json({ success: true, message: `Alert ${alertId} triggered` });
        });
        // 系统信息
        app.get('/api/monitoring/system', authMiddleware, (req, res) => {
            const os = require('os');
            res.json({
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                release: os.release(),
                uptime: os.uptime(),
                nodeVersion: process.version,
                memory: process.memoryUsage(),
                cpus: os.cpus().map(cpu => ({
                    model: cpu.model,
                    speed: cpu.speed,
                    times: cpu.times,
                })),
            });
        });
        // 仪表板UI
        app.get('/monitoring', authMiddleware, (req, res) => {
            res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>KGM Monitoring Dashboard</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
            .dashboard { max-width: 1200px; margin: 0 auto; }
            .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
            .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .card h3 { margin-top: 0; color: #333; }
            .metric { display: flex; justify-content: space-between; margin: 10px 0; }
            .metric-value { font-weight: bold; }
            .health-healthy { color: #10b981; font-weight: bold; }
            .health-degraded { color: #f59e0b; font-weight: bold; }
            .health-unhealthy { color: #ef4444; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="dashboard">
            <div class="header">
              <h1>📊 KGM Monitoring Dashboard</h1>
              <p>Real-time monitoring and observability</p>
            </div>
            
            <div class="grid">
              <div class="card">
                <h3>System Health</h3>
                <div id="health-status">Loading...</div>
                <div id="health-score">-</div>
                <div id="health-issues"></div>
              </div>
              
              <div class="card">
                <h3>System Resources</h3>
                <div class="metric">
                  <span>CPU Usage:</span>
                  <span id="cpu-usage">-</span>
                </div>
                <div class="metric">
                  <span>Memory Usage:</span> 
                  <span id="memory-usage">-</span>
                </div>
                <div class="metric">
                  <span>Active Requests:</span>
                  <span id="active-requests">-</span>
                </div>
                <div class="metric">
                  <span>Error Rate:</span>
                  <span id="error-rate">-</span>
                </div>
              </div>
              
              <div class="card">
                <h3>Business Metrics</h3>
                <div class="metric">
                  <span>Active Users:</span>
                  <span id="active-users">-</span>
                </div>
                <div class="metric">
                  <span>Conversion Rate:</span>
                  <span id="conversion-rate">-</span>
                </div>
                <div class="metric">
                  <span>Revenue:</span>
                  <span id="revenue">-</span>
                </div>
              </div>
              
              <div class="card">
                <h3>Recent Errors</h3>
                <div id="error-list">Loading...</div>
              </div>
              
              <div class="card">
                <h3>Quick Actions</h3>
                <div style="margin-top: 15px;">
                  <a href="/api/monitoring/dashboard" target="_blank">Raw JSON Data</a> | 
                  <a href="/api/monitoring/errors" target="_blank">Error Details</a> | 
                  <a href="/api/monitoring/system" target="_blank">System Info</a>
                </div>
              </div>
            </div>
          </div>
          
          <script>
            async function loadMetrics() {
              try {
                const response = await fetch('/api/monitoring/dashboard');
                const data = await response.json();
                
                // Update health status
                const healthDiv = document.getElementById('health-status');
                healthDiv.innerHTML = \`Status: <span class="health-\${data.health.status}">\${data.health.status.toUpperCase()}</span>\`;
                document.getElementById('health-score').textContent = \`Score: \${data.health.score}\`;
                
                // Update issues
                const issuesDiv = document.getElementById('health-issues');
                if (data.health.issues.length > 0) {
                  issuesDiv.innerHTML = \`<strong>Issues:</strong><ul>\${data.health.issues.map(i => \`<li>\${i}</li>\`).join('')}</ul>\`;
                } else {
                  issuesDiv.innerHTML = '';
                }
                
                // Update system resources
                document.getElementById('cpu-usage').textContent = \`\${(data.system.cpu.usage).toFixed(2)} ms\`;
                document.getElementById('memory-usage').textContent = \`\${(data.system.memory.used / 1024 / 1024).toFixed(2)} MB\`;
                document.getElementById('error-rate').textContent = \`\${(data.application.errors.total * 100).toFixed(2)}%\`;
                
                // Update business metrics
                document.getElementById('active-users').textContent = data.business.activeUsers;
                document.getElementById('conversion-rate').textContent = \`\${(data.business.conversionRate * 100).toFixed(2)}%\`;
                document.getElementById('revenue').textContent = \`$\${data.business.revenue}\`;
                
              } catch (error) {
                console.error('Failed to load metrics:', error);
              }
            }
            
            async function loadErrors() {
              try {
                const response = await fetch('/api/monitoring/errors');
                const data = await response.json();
                
                const errorList = document.getElementById('error-list');
                if (data.aggregations && data.aggregations.length > 0) {
                  const html = '<ul>' + data.aggregations.slice(0, 5).map(error => \`
                    <li>
                      <strong>\${error.sample?.error || error.groupId}:</strong> 
                      \${error.count} times
                    </li>
                  \`).join('') + '</ul>';
                  errorList.innerHTML = html;
                } else {
                  errorList.innerHTML = 'No errors found';
                }
              } catch (error) {
                console.error('Failed to load errors:', error);
              }
            }
            
            // Initial load
            loadMetrics();
            loadErrors();
            
            // Refresh every 10 seconds
            setInterval(loadMetrics, 10000);
            setInterval(loadErrors, 30000);
          </script>
        </body>
        </html>
      `);
        });
        console.log('📊 监控仪表板API已注册');
    }
    createAuthMiddleware() {
        if (!this.config.auth?.enabled) {
            return (req, res, next) => next();
        }
        const username = this.config.auth.username || 'admin';
        const password = this.config.auth.password || 'admin';
        return (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                res.setHeader('WWW-Authenticate', 'Basic realm="Monitoring Dashboard"');
                return res.status(401).send('Authentication required');
            }
            const base64Credentials = authHeader.split(' ')[1];
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
            const [providedUsername, providedPassword] = credentials.split(':');
            if (providedUsername === username && providedPassword === password) {
                return next();
            }
            res.setHeader('WWW-Authenticate', 'Basic realm="Monitoring Dashboard"');
            return res.status(401).send('Invalid credentials');
        };
    }
    setupAutoRefresh() {
        // 定期收集指标
        setInterval(() => {
            this.collectMetrics();
        }, this.config.refreshInterval);
    }
    cleanupOldData() {
        const cutoff = Date.now() - this.config.retentionMs;
        this.metricsHistory = this.metricsHistory.filter(metric => metric.timestamp.getTime() > cutoff);
        // 清理旧的告警历史
        this.alertHistory = this.alertHistory.filter(alert => alert.resolvedAt?.getTime() > cutoff);
    }
    generateTimeSeriesData(metric, period) {
        // 这里应该根据实际数据生成时间序列
        // 为了演示，我们生成一些模拟数据
        const points = 60; // 60个数据点
        const data = [];
        const now = Date.now();
        let interval;
        switch (period) {
            case '1h':
                interval = 60 * 1000; // 1分钟间隔
                break;
            case '6h':
                interval = 6 * 60 * 1000; // 6分钟间隔
                break;
            case '24h':
                interval = 24 * 60 * 1000; // 24分钟间隔
                break;
            default:
                interval = 60 * 1000;
        }
        for (let i = points; i >= 0; i--) {
            const timestamp = new Date(now - i * interval);
            const value = this.generateMockMetricValue(metric, timestamp);
            data.push({
                timestamp,
                value,
                labels: { metric, period },
            });
        }
        return data;
    }
    generateMockMetricValue(metric, timestamp) {
        const hour = timestamp.getHours();
        const minute = timestamp.getMinutes();
        // 根据不同的metric生成模拟值
        switch (metric) {
            case 'request.count':
                return 100 + Math.sin(hour * 0.26) * 50 + Math.random() * 20;
            case 'response.time':
                return 200 + Math.cos(hour * 0.26) * 100 + Math.random() * 50;
            case 'error.rate':
                return 0.02 + Math.sin(hour * 0.26) * 0.01 + Math.random() * 0.005;
            case 'cpu.usage':
                return 0.3 + Math.sin(hour * 0.26) * 0.2 + Math.random() * 0.1;
            case 'memory.usage':
                return 500 + Math.cos(hour * 0.26) * 200 + Math.random() * 100;
            default:
                return Math.random() * 100;
        }
    }
}
/**
 * 默认配置
 */
export const DEFAULT_MONITORING_CONFIG = {
    enabled: true,
    retentionMs: 24 * 60 * 60 * 1000, // 24小时
    refreshInterval: 5000, // 5秒
};
