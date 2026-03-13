export type Quantiles = {
  p50: number;
  p95: number;
};

export type MetricsSnapshot = {
  counters: Record<string, number>;
  ingestToSendLatencyMs: Quantiles;
  simLatencyMs: Quantiles;
  realizedPnl: bigint;
  gasPerLandedFill: Quantiles;
};

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[index] ?? 0;
}

function makeQuantiles(values: readonly number[]): Quantiles {
  return {
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95)
  };
}

export class BotMetrics {
  private readonly counters = new Map<string, number>();
  private readonly ingestToSendLatencies: number[] = [];
  private readonly simLatencies: number[] = [];
  private readonly gasPerFill: number[] = [];
  private realizedPnl = 0n;

  increment(name: string, value: number = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  observeIngestToSendLatency(ms: number): void {
    this.ingestToSendLatencies.push(ms);
  }

  observeSimLatency(ms: number): void {
    this.simLatencies.push(ms);
  }

  recordRealizedPnl(amount: bigint): void {
    this.realizedPnl += amount;
  }

  observeGasPerLandedFill(gasUsed: number): void {
    this.gasPerFill.push(gasUsed);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      ingestToSendLatencyMs: makeQuantiles(this.ingestToSendLatencies),
      simLatencyMs: makeQuantiles(this.simLatencies),
      realizedPnl: this.realizedPnl,
      gasPerLandedFill: makeQuantiles(this.gasPerFill)
    };
  }
}
