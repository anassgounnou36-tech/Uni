import { createServer } from 'node:http';
import type { BotMetrics } from './metrics.js';

function sanitizeMetricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_');
}

function parseCounterKey(key: string): { name: string; labels: string } {
  const open = key.indexOf('{');
  if (open < 0 || !key.endsWith('}')) {
    return { name: sanitizeMetricName(key), labels: '' };
  }
  const name = sanitizeMetricName(key.slice(0, open));
  return { name, labels: key.slice(open) };
}

export function renderPrometheusMetrics(metrics: BotMetrics): string {
  const snapshot = metrics.snapshot();
  const gauges = metrics.scrapeGauges();
  const lines: string[] = [];

  for (const [key, value] of Object.entries(snapshot.counters)) {
    const parsed = parseCounterKey(key);
    lines.push(`${parsed.name}${parsed.labels} ${value}`);
  }

  for (const [name, quantiles] of Object.entries(snapshot.histograms)) {
    const metricName = sanitizeMetricName(name);
    lines.push(`${metricName}{quantile="0.5"} ${quantiles.p50}`);
    lines.push(`${metricName}{quantile="0.95"} ${quantiles.p95}`);
  }

  for (const [name, value] of Object.entries(gauges)) {
    lines.push(`${sanitizeMetricName(name)} ${value}`);
  }

  return `${lines.join('\n')}\n`;
}

export type PrometheusServerConfig = {
  host: string;
  port: number;
  metrics: BotMetrics;
};

export class PrometheusMetricsServer {
  private readonly server;

  constructor(private readonly config: PrometheusServerConfig) {
    this.server = createServer((request, response) => {
      if (request.url !== '/metrics') {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; version=0.0.4');
      response.end(renderPrometheusMetrics(this.config.metrics));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
