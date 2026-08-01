import { logger } from './logger.js';

interface MetricData {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

interface HistogramData {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

interface PerformanceBaseline {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

class PerformanceMonitor {
  private metrics: Map<string, MetricData[]> = new Map();
  private histograms: Map<string, HistogramData[]> = new Map();
  private baselines: Map<string, PerformanceBaseline> = new Map();

  recordMetric(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    const data: MetricData = {
      name,
      value,
      timestamp: Date.now(),
      tags,
    };

    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }

    const metricList = this.metrics.get(key)!;
    metricList.push(data);

    // Keep only last 1000 data points
    if (metricList.length > 1000) {
      metricList.shift();
    }
  }

  recordHistogram(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    const data: HistogramData = {
      name,
      value,
      timestamp: Date.now(),
      tags,
    };

    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }

    const histogramList = this.histograms.get(key)!;
    histogramList.push(data);

    // Keep only last 10000 data points
    if (histogramList.length > 10000) {
      histogramList.shift();
    }
  }

  setBaseline(name: string, baseline: PerformanceBaseline): void {
    this.baselines.set(name, baseline);
    logger.info({ name, baseline }, 'Performance baseline set');
  }

  getBaseline(name: string): PerformanceBaseline | undefined {
    return this.baselines.get(name);
  }

  checkAgainstBaseline(name: string, value: number, tags?: Record<string, string>): {
    passed: boolean;
    baseline?: PerformanceBaseline;
    percentile?: string;
  } {
    const key = this.buildKey(name, tags);
    const baseline = this.baselines.get(key);

    if (!baseline) {
      return { passed: true };
    }

    if (value > baseline.p99) {
      return { passed: false, baseline, percentile: 'p99' };
    }
    if (value > baseline.p95) {
      return { passed: false, baseline, percentile: 'p95' };
    }
    if (value > baseline.p90) {
      return { passed: false, baseline, percentile: 'p90' };
    }

    return { passed: true, baseline };
  }

  getPercentiles(name: string, tags?: Record<string, string>): PerformanceBaseline | null {
    const key = this.buildKey(name, tags);
    const histogram = this.histograms.get(key);

    if (!histogram || histogram.length === 0) {
      return null;
    }

    const values = histogram.map(h => h.value).sort((a, b) => a - b);

    const p50 = values[Math.floor(values.length * 0.5)];
    const p90 = values[Math.floor(values.length * 0.9)];
    const p95 = values[Math.floor(values.length * 0.95)];
    const p99 = values[Math.floor(values.length * 0.99)];
    const max = values[values.length - 1];

    return { p50, p90, p95, p99, max };
  }

  getMetricSummary(name: string, tags?: Record<string, string>): {
    count: number;
    min: number;
    max: number;
    avg: number;
    sum: number;
  } | null {
    const key = this.buildKey(name, tags);
    const metricList = this.metrics.get(key);

    if (!metricList || metricList.length === 0) {
      return null;
    }

    const values = metricList.map(m => m.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = sum / values.length;

    return {
      count: values.length,
      min,
      max,
      avg,
      sum,
    };
  }

  getAllMetrics(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    this.metrics.forEach((data, key) => {
      const summary = this.getMetricSummary(key);
      if (summary) {
        result[key] = summary;
      }
    });

    this.histograms.forEach((data, key) => {
      const percentiles = this.getPercentiles(key);
      if (percentiles) {
        result[`${key}_percentiles`] = percentiles;
      }
    });

    return result;
  }

  reset(): void {
    this.metrics.clear();
    this.histograms.clear();
    logger.info('Performance monitor reset');
  }

  private buildKey(name: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) {
      return name;
    }
    const tagString = Object.entries(tags)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}:${tagString}`;
  }
}

export const performanceMonitor = new PerformanceMonitor();

// Default baselines for common operations
export function setDefaultBaselines(): void {
  performanceMonitor.setBaseline('http_request_latency_ms', {
    p50: 100,
    p90: 500,
    p95: 1000,
    p99: 2000,
    max: 5000,
  });

  performanceMonitor.setBaseline('llm_completion_latency_ms', {
    p50: 1000,
    p90: 3000,
    p95: 5000,
    p99: 10000,
    max: 30000,
  });

  performanceMonitor.setBaseline('database_query_latency_ms', {
    p50: 10,
    p90: 50,
    p95: 100,
    p99: 200,
    max: 500,
  });

  performanceMonitor.setBaseline('memory_retrieval_latency_ms', {
    p50: 50,
    p90: 200,
    p95: 500,
    p99: 1000,
    max: 2000,
  });
}

export function measurePerformance<T>(
  name: string,
  fn: () => Promise<T>,
  tags?: Record<string, string>
): Promise<T> {
  const start = Date.now();
  return fn().finally(() => {
    const duration = Date.now() - start;
    performanceMonitor.recordHistogram(name, duration, tags);

    const check = performanceMonitor.checkAgainstBaseline(name, duration, tags);
    if (!check.passed) {
      logger.warn({
        metric: name,
        duration,
        baseline: check.baseline,
        percentile: check.percentile,
        tags,
      }, 'Performance baseline exceeded');
    }
  });
}
