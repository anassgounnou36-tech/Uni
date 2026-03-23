import type { HedgeGapClass } from '../routing/hedgeGapTypes.js';
import type { RejectedCandidateClass } from '../routing/rejectedCandidateTypes.js';

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
  histograms: Record<string, Quantiles>;
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
  private readonly histograms = new Map<string, number[]>();
  private realizedPnl = 0n;

  increment(name: string, value: number = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  incrementRouteCandidate(venue: string, result: string): void {
    this.increment(`route_candidate_total{venue="${venue}",result="${result}"}`);
  }

  incrementRouteChosen(venue: string): void {
    this.increment(`route_chosen_total{venue="${venue}"}`);
  }

  incrementRouteRejected(venue: string, reason: string): void {
    this.increment(`route_rejected_total{venue="${venue}",reason="${reason}"}`);
  }

  incrementSchedulerNearMiss(): void {
    this.increment('scheduler_near_miss_total');
  }

  incrementSchedulerRequiredOutputUnsatisfiable(): void {
    this.increment('scheduler_required_output_unsatisfiable_total');
  }

  incrementSchedulerCamelotRequiredOutputUnsatisfiable(): void {
    this.increment('scheduler_camelot_required_output_unsatisfiable_total');
  }

  incrementSchedulerRequiredOutputNearMiss(): void {
    this.increment('scheduler_required_output_near_miss_total');
  }

  incrementSchedulerGapClass(gapClass: HedgeGapClass): void {
    this.increment(`scheduler_gap_class_total{gap_class="${gapClass}"}`);
  }

  incrementSchedulerRequiredOutputSatisfiable(): void {
    this.increment('scheduler_required_output_satisfiable_total');
  }

  incrementOrdersEvaluationBlocked(): void {
    this.increment('orders_evaluation_blocked_total');
  }

  incrementRouteEvalRateLimited(venue?: string, pathKind?: string): void {
    this.increment('route_eval_rate_limited_total');
    if (venue && pathKind) {
      this.increment(`route_eval_rate_limited_total{venue="${venue}",path_kind="${pathKind}"}`);
    }
  }

  incrementRouteEvalRpcFailed(venue?: string, pathKind?: string): void {
    this.increment('route_eval_rpc_failed_total');
    if (venue && pathKind) {
      this.increment(`route_eval_rpc_failed_total{venue="${venue}",path_kind="${pathKind}"}`);
    }
  }

  incrementRouteEvalQuoteReverted(venue?: string, pathKind?: string): void {
    this.increment('route_eval_quote_reverted_total');
    if (venue && pathKind) {
      this.increment(`route_eval_quote_reverted_total{venue="${venue}",path_kind="${pathKind}"}`);
    }
  }

  incrementRouteEvalCacheHit(venue?: string, pathKind?: string): void {
    this.increment('route_eval_cache_hit_total');
    if (venue && pathKind) {
      this.increment(`route_eval_cache_hit_total{venue="${venue}",path_kind="${pathKind}"}`);
    }
  }

  incrementRouteEvalNegativeCacheHit(venue?: string, pathKind?: string): void {
    this.increment('route_eval_negative_cache_hit_total');
    if (venue && pathKind) {
      this.increment(`route_eval_negative_cache_hit_total{venue="${venue}",path_kind="${pathKind}"}`);
    }
  }

  incrementRouteEvalNegativeCacheMiss(venue?: string, pathKind?: string): void {
    this.increment('route_eval_negative_cache_miss_total');
    if (venue && pathKind) {
      this.increment(`route_eval_negative_cache_miss_total{venue="${venue}",path_kind="${pathKind}"}`);
    }
  }

  incrementOrderEvalRevertedProbeBudgetExhausted(): void {
    this.increment('order_eval_reverted_probe_budget_exhausted_total');
  }

  incrementCamelotTwoHopSkipped(reason: 'CONFIG_DISABLED'): void {
    this.increment(`camelot_two_hop_skipped_total{reason="${reason}"}`);
  }

  incrementRouteEvalCacheMiss(venue?: string, pathKind?: string): void {
    this.increment('route_eval_cache_miss_total');
    if (venue && pathKind) {
      this.increment(`route_eval_cache_miss_total{venue="${venue}",path_kind="${pathKind}"}`);
    }
  }

  incrementSchedulerBestRejectedCandidateClass(candidateClass: RejectedCandidateClass): void {
    this.increment(`scheduler_best_rejected_candidate_class_total{candidate_class="${candidateClass}"}`);
  }

  incrementSchedulerPolicyBlockedNearMiss(): void {
    this.increment('scheduler_policy_blocked_near_miss_total');
  }

  incrementOrdersPrepareFailed(venue?: string, pathKind?: string, executionMode?: string): void {
    this.increment('orders_prepare_failed_total');
    if (venue && pathKind && executionMode) {
      this.increment(
        `orders_prepare_failed_total{venue="${venue}",path_kind="${pathKind}",execution_mode="${executionMode}"}`
      );
    }
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

  observeHistogram(name: string, value: number): void {
    const values = this.histograms.get(name) ?? [];
    values.push(value);
    this.histograms.set(name, values);
  }

  snapshot(): MetricsSnapshot {
    const histograms = Object.fromEntries(
      [...this.histograms.entries()].map(([name, values]) => [name, makeQuantiles(values)])
    );
    return {
      counters: Object.fromEntries(this.counters.entries()),
      ingestToSendLatencyMs: makeQuantiles(this.ingestToSendLatencies),
      simLatencyMs: makeQuantiles(this.simLatencies),
      realizedPnl: this.realizedPnl,
      gasPerLandedFill: makeQuantiles(this.gasPerFill),
      histograms
    };
  }
}
