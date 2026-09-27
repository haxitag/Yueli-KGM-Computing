/**
 * 监控仪表板API
 * 提供实时监控数据的RESTful API
 */

import type { Request, Response } from 'express';
import type { AdvancedTelemetryManager } from './advanced.js';
import type { ErrorMonitor } from '../errors/monitoring.js';
import type { RetryManager } from '../errors/recovery.js';

export interface DashboardMetrics {
  timestamp: Date;
  
  // 系统指标
  system: {
    cpu: {
      usage: number;
      load: number[];
      cores: number;
    };
    memory: {
      total: number;
      used: number;
      free: number;
      usagePercentage: number;
    };
    disk: {
      total: number;
      used: number;
      free: number;
      usagePercentage: number;
    };
    network: {
      interfaces: string[];
      rxBytes: number;
      txBytes: number;
    };
  };
  
  // 应用指标
  application: {
    requests: {
      total: number;
      perSecond: number;
      byMethod: Record<string, number>;
      byRoute: Record<string, number>;
    };
    responses: {
      status: Record<number, number>;
      latency: {
        p50: number;
        p90: number;
        p95: number;
        p99: number;
        max: number;
      };
    };
    errors: {
      total: number;
      byType: Record<string, number>;
      byService: Record<string, number>;
    };
  };
  
  // 业务指标
  business: {
    activeUsers: number;
    conversionRate: number;
    revenue: number;
    keyTransactions: Record<string, number>;
  };
  
  // 健康状态
  health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    score: number;
    issues: string[];
  };
  
  // 告警
  alerts: {
    active: Array<{
      id: string;
      name: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      triggeredAt: Date;
      lastValue: number;
    }>;
    history: Array<{
      id: string;
      name: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      triggeredAt: Date;
      resolvedAt: Date;
      duration: number;
    }>;
  };
}

export interface TimeSeriesData {
  timestamp: Date;
  value: number;
  labels?: Record<string, string>;
}

export interface MonitoringConfig {
  /** 是否启用仪表板API */
  enabled: boolean;
  /** 密码保护 */
  auth?: {
    enabled: boolean;
    username?: string;
    password?: string;
  };
  /** 数据保留时间（毫秒） */
  retentionMs: number;
  /** 刷新间隔（毫秒） */
  refreshInterval: number;
}

export class MonitoringDashboard {
  private telemetry?: AdvancedTelemetryManager;
  private errorMonitor?: ErrorMonitor;
  private retryManagers: Map<string, RetryManager> = new Map();
  private metricsHistory: DashboardMetrics[] = [];
  private activeAlerts: Map<string, any> = new Map();
  private alertHistory: any[] = [];
  
  constructor(private config: MonitoringConfig) {
    this.setupAutoRefresh();
  }
  
  setTelemetry(telemetry: AdvancedTelemetryManager): void {
    this.telemetry = telemetry;
  }
  
  setErrorMonitor(monitor: ErrorMonitor): void {
    this.errorMonitor = monitor;
  }
  
  setRetryManager(service: string, manager: RetryManager): void {
    this.retryManagers.set(service, manager);
  }
  
  /**
   * 收集当前系统状态
   */
  collectMetrics(): DashboardMetrics {
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
    
    const businessMetrics = {
      activeUsers: 0,
      conversionRate: 0,
      revenue: 0,
      keyTransactions: {},
    };
    
    // 健康检查
    const healthStatus = this.telemetry?.getServiceHealth() || {
      status: 'healthy' as const,
      score: 100,
      issues: [],
    };
    
    // 活跃告警
    const activeAlerts: DashboardMetrics['alerts']['active'] = [];
    const alertHistory: DashboardMetrics['alerts']['history'] = [];
    
    // 构建完整的指标对象
    const metrics: DashboardMetrics = {
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
  setupRoutes(app: any): void {
    if (!this.config.enabled) return;
    
    // 认证中间件
    const authMiddleware = this.createAuthMiddleware();
    
    // 仪表板主页
    app.get('/api/monitoring/dashboard', authMiddleware, (req: Request, res: Response) => {
      const metrics = this.collectMetrics();
      res.json(metrics);
    });
    
    // 指标历史
    app.get('/api/monitoring/history', authMiddleware, (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string) || 100;
      const history = this.metricsHistory.slice(-limit);
      res.json(history);
    });
    
    // 性能时间序列
    app.get('/api/monitoring/series/:metric', authMiddleware, (req: Request, res: Response) => {
      const metric = req.params.metric;
      const period = req.query.period as string || '1h';
      
      const series = this.generateTimeSeriesData(metric, period);
      res.json({
        metric,
        period,
        data: series,
      });
    });
    
    // 健康检查
    app.get('/api/monitoring/health', (req: Request, res: Response) => {
      const health = this.telemetry?.getServiceHealth();
      res.json(health || {
        status: 'unknown',
        score: 0,
        issues: ['Monitoring not initialized'],
      });
    });
    
    // 服务健康详情
    app.get('/api/monitoring/health/:service', authMiddleware, (req: Request, res: Response) => {
      const service = req.params.service;
      const health = this.telemetry?.getServiceHealth(service);
      res.json(health || {
        status: 'unknown',
        score: 0,
        issues: [`Service ${service} metrics not available`],
      });
    });
    
    // 错误统计
    app.get('/api/monitoring/errors', authMiddleware, (req: Request, res: Response) => {
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
    app.get('/api/monitoring/errors/trends', authMiddleware, (req: Request, res: Response) => {
      if (!this.errorMonitor) {
        res.json({ error: 'Error monitor not available' });
        return;
      }
      
      const service = req.query.service as string || 'global';
      const timeRange = parseInt(req.query.timeRange as string) || 30 * 60 * 1000;
      
      const trends = this.errorMonitor.getErrorTrends(service, timeRange);
      res.json({
        service,
        timeRange,
        trends,
      });
    });
    
    // 重试统计
    app.get('/api/monitoring/retries/:service?', authMiddleware, (req: Request, res: Response) => {
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
    app.get('/api/monitoring/alerts', authMiddleware, (req: Request, res: Response) => {
      const alerts = this.telemetry?.getAlertRules() || [];
      res.json({
        total: alerts.length,
        alerts,
      });
    });
    
    // 触发告警（测试用）
    app.post('/api/monitoring/alerts/:id/trigger', authMiddleware, (req: Request, res: Response) => {
      const alertId = req.params.id;
      this.telemetry?.triggerAlert(alertId, req.body);
      res.json({ success: true, message: `Alert ${alertId} triggered` });
    });
    
    // 系统信息
    app.get('/api/monitoring/system', authMiddleware, (req: Request, res: Response) => {
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
    app.get('/monitoring', authMiddleware, (req: Request, res: Response) => {
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
            function escapeHtml(str) {
              if (!str) return '';
              return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
            }

            async function loadMetrics() {
              try {
                const response = await fetch('/api/monitoring/dashboard');
                const data = await response.json();

                // Update health status - use textContent for security
                const healthDiv = document.getElementById('health-status');
                healthDiv.textContent = `Status: ${(data.health.status || '').toUpperCase()}`;
                healthDiv.className = `health-${data.health.status || 'unknown'}`;
                document.getElementById('health-score').textContent = `Score: ${data.health.score ?? 'N/A'}`;

                // Update issues - use safe DOM manipulation
                const issuesDiv = document.getElementById('health-issues');
                if (data.health.issues && data.health.issues.length > 0) {
                  const ul = document.createElement('ul');
                  data.health.issues.forEach(issue => {
                    const li = document.createElement('li');
                    li.textContent = issue;
                    ul.appendChild(li);
                  });
                  issuesDiv.replaceChildren(ul);
                } else {
                  issuesDiv.textContent = '';
                }

                // Update system resources
                document.getElementById('cpu-usage').textContent = `${(data.system.cpu.usage ?? 0).toFixed(2)} ms`;
                document.getElementById('memory-usage').textContent = `${((data.system.memory.used ?? 0) / 1024 / 1024).toFixed(2)} MB`;
                document.getElementById('error-rate').textContent = `${((data.application.errors.total ?? 0) * 100).toFixed(2)}%`;

                // Update business metrics
                document.getElementById('active-users').textContent = data.business.activeUsers ?? 0;
                document.getElementById('conversion-rate').textContent = `${((data.business.conversionRate ?? 0) * 100).toFixed(2)}%`;
                document.getElementById('revenue').textContent = `$${data.business.revenue ?? 0}`;

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
                  const ul = document.createElement('ul');
                  data.aggregations.slice(0, 5).forEach(error => {
                    const li = document.createElement('li');
                    const strong = document.createElement('strong');
                    strong.textContent = error.sample?.error || error.groupId || 'Unknown error';
                    li.appendChild(strong);
                    li.appendChild(document.createTextNode(`: ${error.count || 0} times`));
                    ul.appendChild(li);
                  });
                  errorList.replaceChildren(ul);
                } else {
                  errorList.textContent = 'No errors found';
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
  
  private createAuthMiddleware(): any {
    if (!this.config.auth?.enabled) {
      return (req: Request, res: Response, next: any) => next();
    }
    
    const username = this.config.auth.username;
    const password = this.config.auth.password;
    
    if (!username || !password) {
      console.warn('⚠️ 监控仪表板认证已启用但未配置用户名/密码，将拒绝所有访问');
      return (req: Request, res: Response) => {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitoring Dashboard"');
        return res.status(401).send('Authentication required but credentials not configured');
      };
    }
    
    return (req: Request, res: Response, next: any) => {
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
  
  private setupAutoRefresh(): void {
    // 定期收集指标
    setInterval(() => {
      this.collectMetrics();
    }, this.config.refreshInterval);
  }
  
  private cleanupOldData(): void {
    const cutoff = Date.now() - this.config.retentionMs;
    
    this.metricsHistory = this.metricsHistory.filter(metric => 
      metric.timestamp.getTime() > cutoff
    );
    
    // 清理旧的告警历史
    this.alertHistory = this.alertHistory.filter(alert =>
      alert.resolvedAt?.getTime() > cutoff
    );
  }
  
  private generateTimeSeriesData(
    metric: string,
    period: string
  ): TimeSeriesData[] {
    const now = Date.now();
    
    let interval: number;
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

    const cutoff = now - interval * 60;
    return this.metricsHistory
      .filter(item => item.timestamp.getTime() >= cutoff)
      .map(item => ({
        timestamp: item.timestamp,
        value: this.readMetricValue(metric, item),
        labels: { metric, period },
      }))
      .filter(item => Number.isFinite(item.value));
  }

  private readMetricValue(metric: string, item: DashboardMetrics): number {
    switch (metric) {
      case 'request.count':
        return item.application.requests.total;
      case 'response.time':
        return item.application.responses.latency.p95;
      case 'error.rate':
        return item.application.errors.total;
      case 'cpu.usage':
        return item.system.cpu.usage;
      case 'memory.usage':
        return item.system.memory.used;
      default:
        return Number.NaN;
    }
  }
}

/**
 * 默认配置
 */
export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  enabled: true,
  retentionMs: 24 * 60 * 60 * 1000, // 24小时
  refreshInterval: 5000, // 5秒
};
