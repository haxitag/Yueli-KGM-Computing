/**
 * OpenTelemetry集成
 * 
 * 核心功能:
 * 1. 标准化trace导出
 * 2. 跨服务分布式追踪
 * 3. Prometheus指标导出
 * 4. 日志关联
 */

import { trace, context, diag, DiagConsoleLogger } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { JaegerExporter } from "@opentelemetry/exporter-trace-jaeger";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";

/**
 * OpenTelemetry配置
 */
export interface OpenTelemetryConfig {
  // 服务信息
  serviceName?: string;
  serviceVersion?: string;
  environment?: "development" | "staging" | "production";

  // Tracer配置
  enableTracing?: boolean;
  jaegerEndpoint?: string;
  jaegerAgentHost?: string;
  jaegerAgentPort?: number;

  // Metrics配置
  enableMetrics?: boolean;
  metricsPort?: number;
  metricsEndpoint?: string;

  // 日志配置
  enableLogging?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";

  // 采样配置
  sampler?: {
    type?: "always_on" | "always_off" | "traceid_ratio" | "parentbased_always_on";
    ratio?: number;
  };
}

/**
 * OpenTelemetry管理器
 */
export class OpenTelemetryManager {
  private config: Required<Omit<OpenTelemetryConfig, "sampler">> & {
    sampler?: OpenTelemetryConfig["sampler"];
  };
  private provider?: NodeTracerProvider;
  private metricsExporter?: PrometheusExporter;
  private initialized = false;

  constructor(config?: OpenTelemetryConfig) {
    this.config = {
      serviceName: "yueli-kgm",
      serviceVersion: "1.0.0",
      environment: "development",
      enableTracing: true,
      jaegerEndpoint: "http://localhost:14268/api/traces",
      jaegerAgentHost: "localhost",
      jaegerAgentPort: 6832,
      enableMetrics: true,
      metricsPort: 9464,
      metricsEndpoint: "/metrics",
      enableLogging: true,
      logLevel: "info",
      ...config,
    };
  }

  /**
   * 初始化OpenTelemetry
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // 设置诊断日志
    diag.setLogger(new DiagConsoleLogger(), this.config.logLevel);

    // 创建资源
    const resource = Resource.default().merge(
      new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment,
      }),
    );

    // 创建Tracer Provider
    if (this.config.enableTracing) {
      this.provider = new NodeTracerProvider({
        resource,
        sampler: this.config.sampler,
      });

      // 添加Jaeger导出器
      const jaegerExporter = new JaegerExporter({
        endpoint: this.config.jaegerEndpoint,
      });

      this.provider.addSpanProcessor(new SimpleSpanProcessor(jaegerExporter));

      this.provider.register();
      trace.setGlobalTracerProvider(this.provider);
    }

    // 启动Metrics
    if (this.config.enableMetrics) {
      this.metricsExporter = new PrometheusExporter({
        port: this.config.metricsPort,
        endpoint: this.config.metricsEndpoint,
      });
    }

    // 注册自动插桩
    registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
      ],
    });

    this.initialized = true;
  }

  /**
   * 关闭OpenTelemetry
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    if (this.provider) {
      await this.provider.shutdown();
    }

    if (this.metricsExporter) {
      await this.metricsExporter.stopServer();
    }

    this.initialized = false;
  }

  /**
   * 获取Metrics URL
   */
  getMetricsURL(): string | undefined {
    if (!this.metricsExporter) {
      return undefined;
    }
    return this.metricsExporter.getUrl();
  }

  /**
   * 获取Tracer
   */
  getTracer(name: string, version?: string) {
    return trace.getTracer(name, version);
  }
}

/**
 * 创建带span的上下文
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>,
): Promise<T> {
  const tracer = trace.getTracer("yueli-kgm");

  return tracer.startActiveSpan(
    name,
    {
      attributes,
    },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: 1 }); // OK
        return result;
      } catch (error) {
        span.setStatus({
          code: 2, // ERROR
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * 创建关联的span
 */
export function createSpan(
  name: string,
  parentContext?: context.Context,
  attributes?: Record<string, unknown>,
) {
  const tracer = trace.getTracer("yueli-kgm");
  return tracer.startSpan(name, { attributes }, parentContext);
}

/**
 * 提取传播的上下文
 */
export function extractContext(carrier: Record<string, string>): context.Context {
  const propagator = trace.getTracerProvider().getTracer("yueli-kgm");
  // 这里需要使用正确的propagator
  // 简化版本,实际应该使用TraceContextPropagator
  return context.active();
}

/**
 * 注入传播的上下文
 */
export function injectContext(
  context: context.Context,
  carrier: Record<string, string>,
): void {
  const propagator = trace.getTracerProvider().getTracer("yueli-kgm");
  // 这里需要使用正确的propagator
  // 简化版本
  carrier["traceparent"] = "";
}

/**
 * 记录事件
 */
export function recordEvent(
  span: any,
  name: string,
  attributes?: Record<string, unknown>,
): void {
  span.addEvent(name, attributes, Date.now());
}

/**
 * 记录指标
 */
export function recordMetric(
  name: string,
  value: number,
  attributes?: Record<string, string>,
): void {
  // 这里需要使用Metrics API
  // 简化版本
  console.log(`[METRIC] ${name}=${value}`, attributes);
}

// 导出单例
export const telemetry = new OpenTelemetryManager();
