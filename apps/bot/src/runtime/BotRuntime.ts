import { findFirstProfitableBlock, type BlockEvaluation } from '../scheduler/firstProfitableBlock.js';
import { runHotLaneStep, type HotLaneEntry } from '../scheduler/hotLane.js';
import type { OrdersPoller } from '../intake/poller.js';
import type { HybridIngressCoordinator } from '../ingress/hybridIngress.js';
import type { WebhookIngressServer } from '../ingress/webhookServer.js';
import type { DecisionJournal } from '../journal/types.js';
import type { BotMetrics } from '../telemetry/metrics.js';
import type { PrometheusMetricsServer } from '../telemetry/prometheus.js';
import type { RuntimeConfig } from './config.js';
import { decideExecutionMode } from './livePolicy.js';
import { InflightTracker } from './inflightTracker.js';
import type { OrderStore } from '../store/types.js';
import type { ResolveEnv } from '@uni/protocol';
import type { RouteBook } from '../routing/routeBook.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { ForkSimService } from '../sim/forkSimService.js';
import type { SequencerClient } from '../send/sequencerClient.js';
import { NonceManager } from '../send/nonceManager.js';
import type { ExecutionPlan } from '../execution/types.js';
import type { PreparedExecution } from '../execution/preparedExecution.js';
import { buildExecutionOutcomeAttribution, buildRouteDecisionAttribution } from '../attribution/routeDecisionAttribution.js';
import { JsonConsoleLogger, type StructuredLogger } from '../telemetry/logging.js';
import type { FeeTierAttemptSummary, VenueRouteAttemptSummary } from '../routing/attemptTypes.js';
import type { ConstraintBreakdown, ConstraintRejectReason } from '../routing/constraintTypes.js';
import type { ExactOutputViability, ExactOutputViabilityStatus } from '../routing/exactOutputTypes.js';
import type { HedgeGapClass, HedgeGapSummary } from '../routing/hedgeGapTypes.js';
import type { RoutePathKind } from '../routing/pathTypes.js';
import type { HedgeExecutionMode } from '../routing/executionModeTypes.js';
import {
  deriveRejectedCandidateClass,
  ensureRejectedCandidateClass,
  type RejectedCandidateClass
} from '../routing/rejectedCandidateTypes.js';
import type { ResolveEnvProvider } from './resolveEnvProvider.js';
import { RouteEvalReadCache } from '../routing/rpc/readCache.js';
import type { OrderState } from '../domain/orderState.js';

export type SchedulerContext = {
  routeBook: RouteBook;
  resolveEnvProvider?: ResolveEnvProvider;
  resolveEnv?: Omit<ResolveEnv, 'blockNumberish'>;
};

export type HotLaneContext = SchedulerContext & {
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  conditionalEnvelope: ConditionalEnvelope;
  executor: `0x${string}`;
  simService: ForkSimService;
  sequencerClient: SequencerClient;
  nonceManager: NonceManager;
  executionPreparer: (input: { executionPlan: ExecutionPlan }) => Promise<PreparedExecution>;
};

type ScheduledOrder = HotLaneEntry;
type BlockedRetryState = {
  nextEligibleTick: number;
  reason: 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED';
  errorMessage?: string;
  candidateCount: number;
  blockedCount: number;
  revertedProbeCount: number;
  revertedProbeBudgetExhausted: boolean;
};
type StalePlanRetryState = {
  attempts: number;
  nextEligibleTick: number;
};
const STALE_PLAN_MAX_RETRIES = 2;

export type BotRuntimeDeps = {
  config: RuntimeConfig;
  poller: OrdersPoller;
  ingress: HybridIngressCoordinator;
  store: OrderStore;
  journal: DecisionJournal;
  metrics: BotMetrics;
  webhookServer?: WebhookIngressServer;
  metricsServer?: PrometheusMetricsServer;
  inflightTracker: InflightTracker;
  requireTradingDeps?: boolean;
  schedulerContext?: SchedulerContext;
  hotLaneContext?: HotLaneContext;
  logger?: StructuredLogger;
};

export class BotRuntime {
  private pollTimer: NodeJS.Timeout | undefined;
  private schedulerTimer: NodeJS.Timeout | undefined;
  private hotLaneTimer: NodeJS.Timeout | undefined;
  private readonly hotQueue: ScheduledOrder[] = [];
  private readonly logger: StructuredLogger;
  private readonly blockedRetryByOrder = new Map<`0x${string}`, BlockedRetryState>();
  private readonly stalePlanRetryByOrder = new Map<`0x${string}`, StalePlanRetryState>();
  private maintenanceTickCounter = 0;
  private schedulerTickCounter = 0;
  private static readonly HOT_QUEUE_MAX_ENTRIES = 10_000;
  private static readonly MAINTENANCE_SWEEP_EVERY_TICKS = 20;
  private static readonly TERMINAL_ORDER_STATES = new Set<OrderState>([
    'PREPARE_FAILED',
    'DROPPED',
    'UNSUPPORTED',
    'LANDED',
    'LOST',
    'EXPIRED',
    'CANCELED',
    'REVERTED'
  ]);

  constructor(private readonly deps: BotRuntimeDeps) {
    this.logger = deps.logger ?? new JsonConsoleLogger();
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private withDerivedCandidateClass(summary: VenueRouteAttemptSummary): VenueRouteAttemptSummary {
    if (summary.status === 'ROUTEABLE' || summary.candidateClass) {
      return summary;
    }
    return {
      ...summary,
      candidateClass: deriveRejectedCandidateClass(summary)
    };
  }

  private withDerivedRejectedCandidateClass(summary: VenueRouteAttemptSummary): VenueRouteAttemptSummary {
    if (summary.status === 'ROUTEABLE') {
      return summary;
    }
    return ensureRejectedCandidateClass(summary);
  }

  private getPolicyInflightCount(): number {
    return this.deps.inflightTracker.getInflightCount();
  }

  private isTerminalOrderState(state: OrderState): boolean {
    return BotRuntime.TERMINAL_ORDER_STATES.has(state);
  }

  private removeQueuedEntries(orderHash: `0x${string}`): void {
    for (let i = this.hotQueue.length - 1; i >= 0; i -= 1) {
      if (this.hotQueue[i]?.orderHash === orderHash) {
        this.hotQueue.splice(i, 1);
      }
    }
  }

  private removeOrderTracking(orderHash: `0x${string}`): void {
    this.removeQueuedEntries(orderHash);
    this.blockedRetryByOrder.delete(orderHash);
    this.stalePlanRetryByOrder.delete(orderHash);
    this.deps.inflightTracker.markResolved(orderHash);
  }

  private observeRuntimeGaugeSnapshot(): void {
    this.deps.metrics.setGauge('hot_queue_size', this.hotQueue.length);
    this.deps.metrics.setGauge('tracked_orders_size', this.blockedRetryByOrder.size);
    const mem = process.memoryUsage();
    this.deps.metrics.setGauge('process_resident_memory_bytes', mem.rss);
    this.deps.metrics.setGauge('process_heap_used_bytes', mem.heapUsed);
  }

  private async runMaintenanceSweep(): Promise<void> {
    for (const [orderHash] of this.blockedRetryByOrder) {
      const record = await this.deps.store.get(orderHash).catch(() => undefined);
      if (!record || this.isTerminalOrderState(record.state)) {
        this.blockedRetryByOrder.delete(orderHash);
      }
    }
    for (let i = this.hotQueue.length - 1; i >= 0; i -= 1) {
      const orderHash = this.hotQueue[i]?.orderHash;
      if (!orderHash) continue;
      const record = await this.deps.store.get(orderHash).catch(() => undefined);
      if (!record || this.isTerminalOrderState(record.state)) {
        this.hotQueue.splice(i, 1);
      }
    }
    this.observeRuntimeGaugeSnapshot();
  }

  private logTerminalOrderSkipped(orderHash: `0x${string}`, state: OrderState, attemptedAction: string): void {
    this.logger.log('warn', 'terminal_order_skipped', {
      orderHash,
      state,
      attemptedAction
    });
  }

  private toJournalFeeTierAttempt(summary: FeeTierAttemptSummary): {
    feeTier: number;
    secondFeeTier?: number;
    executionMode?: HedgeExecutionMode;
    pathKind?: RoutePathKind;
    hopCount?: 1 | 2;
    bridgeToken?: string;
    pathDescriptor?: string;
    poolExists: boolean;
    quoteSucceeded: boolean;
    quotedAmountOut?: string;
    minAmountOut?: string;
    grossEdgeOut?: string;
    netEdgeOut?: string;
    status: string;
    reason: string;
    constraintReason?: ConstraintRejectReason;
    candidateClass?: RejectedCandidateClass;
    constraintBreakdown?: {
      requiredOutput: string;
      quotedAmountOut: string;
      slippageBufferOut: string;
      gasCostOut: string;
      riskBufferOut: string;
      profitFloorOut: string;
      slippageFloorOut: string;
      profitabilityFloorOut: string;
      minAmountOut: string;
      requiredOutputShortfallOut: string;
      minAmountOutShortfallOut: string;
      bindingFloor: 'SLIPPAGE_FLOOR' | 'PROFITABILITY_FLOOR';
      nearMiss: boolean;
      nearMissBps: string;
    };
    exactOutputViability?: {
      status: ExactOutputViabilityStatus;
      targetOutput: string;
      requiredInputForTargetOutput: string;
      availableInput: string;
      inputDeficit?: string;
      inputSlack?: string;
      checkedFeeTier?: number;
      pathKind?: RoutePathKind;
      hopCount?: 1 | 2;
      bridgeToken?: string;
      pathDescriptor?: string;
      reason: string;
    };
    hedgeGap?: {
      pathKind?: RoutePathKind;
      hopCount?: 1 | 2;
      bridgeToken?: string;
      pathDescriptor?: string;
      requiredOutput: string;
      quotedAmountOut: string;
      outputCoverageBps: string;
      requiredOutputShortfallOut: string;
      minAmountOutShortfallOut?: string;
      inputDeficit?: string;
      inputSlack?: string;
      gapClass: HedgeGapClass;
      nearMiss: boolean;
      nearMissBps: string;
    };
  } {
    const withCandidateClass = this.withDerivedCandidateClass({
      venue: 'UNISWAP_V3',
      status: summary.status,
      reason: summary.reason,
      quotedAmountOut: summary.quotedAmountOut,
      constraintReason: summary.constraintReason,
      constraintBreakdown: summary.constraintBreakdown,
      exactOutputViability: summary.exactOutputViability,
      hedgeGap: summary.hedgeGap,
      candidateClass: summary.candidateClass
    });
    return {
      feeTier: summary.feeTier,
      secondFeeTier: summary.secondFeeTier,
      executionMode: summary.executionMode,
      pathKind: summary.pathKind,
      hopCount: summary.hopCount,
      bridgeToken: summary.bridgeToken,
      pathDescriptor: summary.pathDescriptor,
      poolExists: summary.poolExists,
      quoteSucceeded: summary.quoteSucceeded,
      quotedAmountOut: summary.quotedAmountOut?.toString(),
      minAmountOut: summary.minAmountOut?.toString(),
      grossEdgeOut: summary.grossEdgeOut?.toString(),
      netEdgeOut: summary.netEdgeOut?.toString(),
      status: summary.status,
      reason: summary.reason,
      constraintReason: summary.constraintReason,
      candidateClass: withCandidateClass.candidateClass,
      constraintBreakdown: summary.constraintBreakdown ? this.toJournalConstraintBreakdown(summary.constraintBreakdown) : undefined,
      exactOutputViability: summary.exactOutputViability ? this.toJournalExactOutputViability(summary.exactOutputViability) : undefined,
      hedgeGap: summary.hedgeGap ? this.toJournalHedgeGap(summary.hedgeGap) : undefined
    };
  }

  private toJournalExactOutputViability(viability: ExactOutputViability): {
    status: ExactOutputViabilityStatus;
    targetOutput: string;
    requiredInputForTargetOutput: string;
    availableInput: string;
    inputDeficit?: string;
    inputSlack?: string;
    checkedFeeTier?: number;
    pathKind?: RoutePathKind;
    hopCount?: 1 | 2;
    bridgeToken?: string;
    pathDescriptor?: string;
    reason: string;
  } {
    return {
      status: viability.status,
      targetOutput: viability.targetOutput.toString(),
      requiredInputForTargetOutput: viability.requiredInputForTargetOutput.toString(),
      availableInput: viability.availableInput.toString(),
      inputDeficit: viability.inputDeficit?.toString(),
      inputSlack: viability.inputSlack?.toString(),
      checkedFeeTier: viability.checkedFeeTier,
      pathKind: viability.pathKind,
      hopCount: viability.hopCount,
      bridgeToken: viability.bridgeToken,
      pathDescriptor: viability.pathDescriptor,
      reason: viability.reason
    };
  }

  private toJournalHedgeGap(summary: HedgeGapSummary): {
    pathKind?: RoutePathKind;
    hopCount?: 1 | 2;
    bridgeToken?: string;
    pathDescriptor?: string;
    requiredOutput: string;
    quotedAmountOut: string;
    outputCoverageBps: string;
    requiredOutputShortfallOut: string;
    minAmountOutShortfallOut?: string;
    inputDeficit?: string;
    inputSlack?: string;
    gapClass: HedgeGapClass;
    nearMiss: boolean;
    nearMissBps: string;
  } {
    return {
      pathKind: summary.pathKind,
      hopCount: summary.hopCount,
      bridgeToken: summary.bridgeToken,
      pathDescriptor: summary.pathDescriptor,
      requiredOutput: summary.requiredOutput.toString(),
      quotedAmountOut: summary.quotedAmountOut.toString(),
      outputCoverageBps: summary.outputCoverageBps.toString(),
      requiredOutputShortfallOut: summary.requiredOutputShortfallOut.toString(),
      minAmountOutShortfallOut: summary.minAmountOutShortfallOut?.toString(),
      inputDeficit: summary.inputDeficit?.toString(),
      inputSlack: summary.inputSlack?.toString(),
      gapClass: summary.gapClass,
      nearMiss: summary.nearMiss,
      nearMissBps: summary.nearMissBps.toString()
    };
  }

  private toJournalConstraintBreakdown(breakdown: ConstraintBreakdown): {
    requiredOutput: string;
    quotedAmountOut: string;
    slippageBufferOut: string;
    gasCostOut: string;
    riskBufferOut: string;
    profitFloorOut: string;
    slippageFloorOut: string;
    profitabilityFloorOut: string;
    minAmountOut: string;
    requiredOutputShortfallOut: string;
    minAmountOutShortfallOut: string;
    bindingFloor: 'SLIPPAGE_FLOOR' | 'PROFITABILITY_FLOOR';
    nearMiss: boolean;
    nearMissBps: string;
  } {
    return {
      requiredOutput: breakdown.requiredOutput.toString(),
      quotedAmountOut: breakdown.quotedAmountOut.toString(),
      slippageBufferOut: breakdown.slippageBufferOut.toString(),
      gasCostOut: breakdown.gasCostOut.toString(),
      riskBufferOut: breakdown.riskBufferOut.toString(),
      profitFloorOut: breakdown.profitFloorOut.toString(),
      slippageFloorOut: breakdown.slippageFloorOut.toString(),
      profitabilityFloorOut: breakdown.profitabilityFloorOut.toString(),
      minAmountOut: breakdown.minAmountOut.toString(),
      requiredOutputShortfallOut: breakdown.requiredOutputShortfallOut.toString(),
      minAmountOutShortfallOut: breakdown.minAmountOutShortfallOut.toString(),
      bindingFloor: breakdown.bindingFloor,
      nearMiss: breakdown.nearMiss,
      nearMissBps: breakdown.nearMissBps.toString()
    };
  }

  private toJournalVenueAttempt(summary: VenueRouteAttemptSummary): {
    venue: string;
    executionMode?: HedgeExecutionMode;
    pathKind?: RoutePathKind;
    hopCount?: 1 | 2;
    bridgeToken?: string;
    pathDescriptor?: string;
    status: string;
    reason: string;
    errorCategory?: 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED';
    errorMessage?: string;
    quotedAmountOut?: string;
    minAmountOut?: string;
    grossEdgeOut?: string;
    netEdgeOut?: string;
    selectedFeeTier?: number;
    quoteCount?: number;
    candidateClass?: RejectedCandidateClass;
    constraintReason?: ConstraintRejectReason;
    constraintBreakdown?: {
      requiredOutput: string;
      quotedAmountOut: string;
      slippageBufferOut: string;
      gasCostOut: string;
      riskBufferOut: string;
      profitFloorOut: string;
      slippageFloorOut: string;
      profitabilityFloorOut: string;
      minAmountOut: string;
      requiredOutputShortfallOut: string;
      minAmountOutShortfallOut: string;
      bindingFloor: 'SLIPPAGE_FLOOR' | 'PROFITABILITY_FLOOR';
      nearMiss: boolean;
      nearMissBps: string;
    };
    exactOutputViability?: {
      status: ExactOutputViabilityStatus;
      targetOutput: string;
      requiredInputForTargetOutput: string;
      availableInput: string;
      inputDeficit?: string;
      inputSlack?: string;
      checkedFeeTier?: number;
      reason: string;
    };
    hedgeGap?: {
      requiredOutput: string;
      quotedAmountOut: string;
      outputCoverageBps: string;
      requiredOutputShortfallOut: string;
      minAmountOutShortfallOut?: string;
      inputDeficit?: string;
      inputSlack?: string;
      gapClass: HedgeGapClass;
      nearMiss: boolean;
      nearMissBps: string;
    };
    feeTierAttempts?: Array<{
      feeTier: number;
      poolExists: boolean;
      quoteSucceeded: boolean;
      quotedAmountOut?: string;
      minAmountOut?: string;
      grossEdgeOut?: string;
      netEdgeOut?: string;
      status: string;
      reason: string;
      constraintReason?: ConstraintRejectReason;
      candidateClass?: RejectedCandidateClass;
      constraintBreakdown?: {
        requiredOutput: string;
        quotedAmountOut: string;
        slippageBufferOut: string;
        gasCostOut: string;
        riskBufferOut: string;
        profitFloorOut: string;
        slippageFloorOut: string;
        profitabilityFloorOut: string;
        minAmountOut: string;
        requiredOutputShortfallOut: string;
        minAmountOutShortfallOut: string;
        bindingFloor: 'SLIPPAGE_FLOOR' | 'PROFITABILITY_FLOOR';
        nearMiss: boolean;
        nearMissBps: string;
      };
      exactOutputViability?: {
        status: ExactOutputViabilityStatus;
        targetOutput: string;
        requiredInputForTargetOutput: string;
        availableInput: string;
        inputDeficit?: string;
        inputSlack?: string;
        checkedFeeTier?: number;
        pathKind?: RoutePathKind;
        hopCount?: 1 | 2;
        bridgeToken?: string;
        pathDescriptor?: string;
        reason: string;
      };
      hedgeGap?: {
        pathKind?: RoutePathKind;
        hopCount?: 1 | 2;
        bridgeToken?: string;
        pathDescriptor?: string;
        requiredOutput: string;
        quotedAmountOut: string;
        outputCoverageBps: string;
        requiredOutputShortfallOut: string;
        minAmountOutShortfallOut?: string;
        inputDeficit?: string;
        inputSlack?: string;
        gapClass: HedgeGapClass;
        nearMiss: boolean;
        nearMissBps: string;
      };
    }>;
  } {
    const withCandidateClass = this.withDerivedRejectedCandidateClass(summary);
    return {
      venue: summary.venue,
      executionMode: summary.executionMode,
      pathKind: summary.pathKind,
      hopCount: summary.hopCount,
      bridgeToken: summary.bridgeToken,
      pathDescriptor: summary.pathDescriptor,
      status: summary.status,
      reason: summary.reason,
      errorCategory: summary.errorCategory,
      errorMessage: summary.errorMessage,
      quotedAmountOut: summary.quotedAmountOut?.toString(),
      minAmountOut: summary.minAmountOut?.toString(),
      grossEdgeOut: summary.grossEdgeOut?.toString(),
      netEdgeOut: summary.netEdgeOut?.toString(),
      selectedFeeTier: summary.selectedFeeTier,
      quoteCount: summary.quoteCount,
      candidateClass: withCandidateClass.candidateClass,
      constraintReason: summary.constraintReason,
      constraintBreakdown: summary.constraintBreakdown ? this.toJournalConstraintBreakdown(summary.constraintBreakdown) : undefined,
      exactOutputViability: summary.exactOutputViability ? this.toJournalExactOutputViability(summary.exactOutputViability) : undefined,
      hedgeGap: summary.hedgeGap ? this.toJournalHedgeGap(summary.hedgeGap) : undefined,
      feeTierAttempts: summary.feeTierAttempts?.map((attempt) => this.toJournalFeeTierAttempt(attempt))
    };
  }

  private toCompactDroppedEvaluation(evaluation: BlockEvaluation): {
    block: string;
    selectionOk: boolean;
    selectionReason?: string;
    chosenRouteVenue?: string;
    requiredOutput: string;
    quotedAmountOut: string;
    minAmountOut: string;
    gasCostOut: string;
    riskBufferOut: string;
    profitFloorOut: string;
    netEdgeOut: string;
    venueAttempts: Array<{
      venue: string;
      pathKind?: RoutePathKind;
      hopCount?: 1 | 2;
      bridgeToken?: string;
      pathDescriptor?: string;
      status: string;
      reason: string;
      quotedAmountOut?: string;
      minAmountOut?: string;
      grossEdgeOut?: string;
      netEdgeOut?: string;
      selectedFeeTier?: number;
      quoteCount?: number;
      feeTierAttempts?: Array<{
        feeTier: number;
        poolExists: boolean;
        quoteSucceeded: boolean;
        quotedAmountOut?: string;
        minAmountOut?: string;
        grossEdgeOut?: string;
        netEdgeOut?: string;
        status: string;
        reason: string;
      }>;
    }>;
    bestRejectedSummary?: {
      venue: string;
      status: string;
      reason: string;
      quotedAmountOut?: string;
      minAmountOut?: string;
      grossEdgeOut?: string;
      netEdgeOut?: string;
      selectedFeeTier?: number;
      quoteCount?: number;
      candidateClass: RejectedCandidateClass;
      feeTierAttempts?: Array<{
        feeTier: number;
        poolExists: boolean;
        quoteSucceeded: boolean;
        quotedAmountOut?: string;
        minAmountOut?: string;
        grossEdgeOut?: string;
        netEdgeOut?: string;
        status: string;
        reason: string;
      }>;
    };
  } {
    return {
      block: evaluation.block.toString(),
      selectionOk: evaluation.selectionOk,
      selectionReason: evaluation.selectionReason,
      chosenRouteVenue: evaluation.chosenRouteVenue,
      requiredOutput: evaluation.requiredOutput.toString(),
      quotedAmountOut: evaluation.quotedAmountOut.toString(),
      minAmountOut: evaluation.minAmountOut.toString(),
      gasCostOut: evaluation.gasCostOut.toString(),
      riskBufferOut: evaluation.riskBufferOut.toString(),
      profitFloorOut: evaluation.profitFloorOut.toString(),
      netEdgeOut: evaluation.netEdgeOut.toString(),
      venueAttempts: evaluation.venueAttempts.map((summary) => this.toJournalVenueAttempt(summary)),
      bestRejectedSummary: evaluation.bestRejectedSummary
        ? (() => {
            const withCandidateClass = this.withDerivedCandidateClass(evaluation.bestRejectedSummary);
            return {
              ...this.toJournalVenueAttempt(evaluation.bestRejectedSummary),
              candidateClass: withCandidateClass.candidateClass ?? 'UNKNOWN'
            };
          })()
        : undefined
    };
  }

  private assertTradingDependencies(): void {
    if (!this.deps.schedulerContext || !this.deps.hotLaneContext) {
      throw new Error('runtime trading dependencies are required (schedulerContext/hotLaneContext)');
    }
    if (!this.deps.schedulerContext.resolveEnvProvider && !this.deps.schedulerContext.resolveEnv) {
      throw new Error('runtime trading dependency resolve environment is required (resolveEnvProvider or resolveEnv)');
    }
    if (!this.deps.hotLaneContext.executionPreparer) {
      throw new Error('runtime trading dependency executionPreparer is required');
    }
    if (!this.deps.hotLaneContext.simService || !this.deps.hotLaneContext.sequencerClient || !this.deps.hotLaneContext.nonceManager) {
      throw new Error('runtime trading dependencies simService/sequencerClient/nonceManager are required');
    }
  }

  async start(): Promise<void> {
    if (this.pollTimer || this.schedulerTimer || this.hotLaneTimer) {
      return;
    }
    if (this.deps.requireTradingDeps ?? false) {
      this.assertTradingDependencies();
    }

    if (this.deps.webhookServer) {
      await this.deps.webhookServer.start();
      this.logger.log('info', 'webhook_server_started', {
        host: this.deps.config.webhookHost,
        port: this.deps.config.webhookPort,
        path: this.deps.config.webhookPath
      });
    }
    if (this.deps.metricsServer) {
      await this.deps.metricsServer.start();
      this.logger.log('info', 'metrics_server_started', {
        host: this.deps.config.metricsHost,
        port: this.deps.config.metricsPort
      });
    }
    if (this.deps.schedulerContext?.resolveEnvProvider) {
      const snapshot = await this.deps.schedulerContext.resolveEnvProvider.getCurrent();
      this.logger.log('info', 'resolve_env_snapshot', {
        chainId: snapshot.chainId.toString(),
        blockNumber: snapshot.blockNumber.toString(),
        blockNumberish: snapshot.blockNumberish.toString(),
        timestamp: snapshot.timestamp.toString(),
        baseFeePerGas: snapshot.baseFeePerGas.toString()
      });
    }

    this.pollTimer = setInterval(
      () =>
        void this.pollTick().catch((error) => {
          this.logger.log('error', 'poll_tick_failed', { error: this.toErrorMessage(error) });
        }),
      this.deps.config.pollCadenceMs
    );
    this.schedulerTimer = setInterval(
      () =>
        void this.schedulerTick().catch((error) => {
          this.logger.log('error', 'scheduler_tick_failed', { error: this.toErrorMessage(error) });
        }),
      this.deps.config.schedulerCadenceMs
    );
    this.hotLaneTimer = setInterval(
      () =>
        void this.hotLaneTick().catch((error) => {
          this.logger.log('error', 'hot_lane_tick_failed', { error: this.toErrorMessage(error) });
        }),
      this.deps.config.hotLaneCadenceMs
    );

    this.logger.log('info', 'runtime_started');
    void this.pollTick().catch((error) => {
      this.logger.log('error', 'poll_tick_failed', { error: this.toErrorMessage(error) });
    });
    void this.schedulerTick().catch((error) => {
      this.logger.log('error', 'scheduler_tick_failed', { error: this.toErrorMessage(error) });
    });
    void this.hotLaneTick().catch((error) => {
      this.logger.log('error', 'hot_lane_tick_failed', { error: this.toErrorMessage(error) });
    });
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
    if (this.hotLaneTimer) {
      clearInterval(this.hotLaneTimer);
      this.hotLaneTimer = undefined;
    }

    if (this.deps.webhookServer) {
      await this.deps.webhookServer.stop();
    }
    if (this.deps.metricsServer) {
      await this.deps.metricsServer.stop();
    }
  }

  isRunning(): boolean {
    return Boolean(this.pollTimer && this.schedulerTimer && this.hotLaneTimer);
  }

  private async pollTick(): Promise<void> {
    this.deps.metrics.increment('bot_runtime_ticks_total');
    this.logger.log('info', 'poll_tick_started');
    try {
      const result = await this.deps.poller.pollOnce();
      for (const payload of result.payloads) {
        await this.deps.ingress.ingest({
          source: 'POLL',
          receivedAtMs: Date.now(),
          payload,
          orderHashHint:
            typeof payload.orderHash === 'string' && payload.orderHash.startsWith('0x')
              ? (payload.orderHash as `0x${string}`)
              : undefined
        });
      }
      this.logger.log('info', 'poll_tick_completed', { fetched: result.fetched });
    } catch (error) {
      this.logger.log('error', 'poll_tick_failed', { error: this.toErrorMessage(error) });
    }
  }

  private async schedulerTick(): Promise<void> {
    this.deps.metrics.increment('bot_runtime_ticks_total');
    this.observeRuntimeGaugeSnapshot();
    const scheduler = this.deps.schedulerContext;
    if (!scheduler) {
      return;
    }
    this.schedulerTickCounter += 1;
    this.maintenanceTickCounter += 1;
    if (this.maintenanceTickCounter % BotRuntime.MAINTENANCE_SWEEP_EVERY_TICKS === 0) {
      await this.runMaintenanceSweep();
    }

    for (const orderHash of this.deps.ingress.dequeueForScheduling()) {
      const blockedRetry = this.blockedRetryByOrder.get(orderHash);
      if (blockedRetry && blockedRetry.nextEligibleTick > this.schedulerTickCounter) {
        this.deps.ingress.requeueForScheduling(orderHash);
        continue;
      }
      const staleRetry = this.stalePlanRetryByOrder.get(orderHash);
      if (staleRetry && staleRetry.nextEligibleTick > this.schedulerTickCounter) {
        this.deps.ingress.requeueForScheduling(orderHash);
        continue;
      }
      this.blockedRetryByOrder.delete(orderHash);
      const record = await this.deps.store.get(orderHash);
      if (!record?.normalizedOrder) {
        continue;
      }
      if (this.isTerminalOrderState(record.state)) {
        this.logTerminalOrderSkipped(orderHash, record.state, 'scheduler_processing');
        this.removeOrderTracking(orderHash);
        continue;
      }
      if (record.state !== 'SUPPORTED') {
        continue;
      }
      const resolveSnapshot = scheduler.resolveEnvProvider
        ? await scheduler.resolveEnvProvider.getCurrent().catch(() => undefined)
        : undefined;
      const scheduleResult = await findFirstProfitableBlock({
        order: record.normalizedOrder.decodedOrder.order,
        resolveEnvProvider: scheduler.resolveEnvProvider,
        baseEnv: scheduler.resolveEnv,
        routeBook: scheduler.routeBook,
        candidateBlockOffsets: this.deps.config.candidateBlockOffsets,
        maxCandidateBlocksPerOrder: this.deps.config.maxCandidateBlocksPerOrder,
        routeEvalCacheMaxEntries: this.deps.config.routeEvalCacheMaxEntries,
        routeEvalNegativeCacheMaxEntries: this.deps.config.routeEvalNegativeCacheMaxEntries,
        onRouteEvalCacheStats: (stats) => {
          this.deps.metrics.setGauge('route_eval_cache_entries', stats.entries);
          this.deps.metrics.setGauge('route_eval_negative_cache_entries', stats.negativeEntries);
          this.deps.metrics.setGauge('route_eval_cache_snapshots', stats.snapshots);
        },
        threshold: this.deps.config.thresholdOut,
        competeWindowBlocks: this.deps.config.competeWindowBlocks
      });
      if (!scheduleResult.ok && scheduleResult.reason === 'INCONCLUSIVE') {
        const blockedAttempts = scheduleResult.evaluations.flatMap((evaluation) =>
          evaluation.venueAttempts.filter(
            (attempt) =>
              attempt.status === 'RATE_LIMITED'
              || attempt.status === 'RPC_UNAVAILABLE'
              || attempt.status === 'RPC_FAILED'
              || attempt.status === 'QUOTE_REVERTED'
          )
        );
        const blockedCount = blockedAttempts.length;
        const revertedProbeCount = scheduleResult.evaluations.reduce((sum, evaluation) => sum + (evaluation.revertedProbeCount ?? 0), 0);
        const revertedProbeBudgetExhausted = scheduleResult.evaluations.some((evaluation) => evaluation.revertedProbeBudgetExhausted === true);
        let hasRateLimited = false;
        let hasRpcUnavailable = false;
        let hasRpcFailed = false;
        for (const attempt of blockedAttempts) {
          if (attempt.status === 'RATE_LIMITED') hasRateLimited = true;
          else if (attempt.status === 'RPC_UNAVAILABLE') hasRpcUnavailable = true;
          else if (attempt.status === 'RPC_FAILED') hasRpcFailed = true;
        }
        const reason: 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED' =
          revertedProbeBudgetExhausted
            ? 'QUOTE_REVERTED'
            : hasRateLimited
          ? 'RATE_LIMITED'
          : hasRpcUnavailable
            ? 'RPC_UNAVAILABLE'
            : hasRpcFailed
              ? 'RPC_FAILED'
              : 'QUOTE_REVERTED';
        const errorMessage = blockedAttempts.find((attempt) => attempt.errorMessage)?.errorMessage;
        this.blockedRetryByOrder.set(orderHash, {
          nextEligibleTick: this.schedulerTickCounter + this.deps.config.infraBlockedRetryCooldownTicks,
          reason,
          errorMessage,
          candidateCount: scheduleResult.evaluations.length,
          blockedCount,
          revertedProbeCount,
          revertedProbeBudgetExhausted
        });
        this.deps.metrics.incrementOrdersEvaluationBlocked();
        if (reason === 'RATE_LIMITED') {
          this.deps.metrics.incrementRouteEvalRateLimited();
        } else if (reason === 'QUOTE_REVERTED') {
          this.deps.metrics.incrementRouteEvalQuoteReverted();
        } else {
          this.deps.metrics.incrementRouteEvalRpcFailed();
        }
        if (revertedProbeBudgetExhausted) {
          this.deps.metrics.incrementOrderEvalRevertedProbeBudgetExhausted();
        }
        await this.deps.journal.append({
          type: 'ORDER_EVALUATION_BLOCKED',
          atMs: Date.now(),
          orderHash,
          payload: {
            orderHash,
            reason,
            candidateCount: scheduleResult.evaluations.length,
            blockedCount,
            revertedProbeCount,
            revertedProbeBudgetExhausted,
            errorMessage,
            venueAttempts: blockedAttempts.map((attempt) => this.toJournalVenueAttempt(attempt))
          }
        });
        this.deps.ingress.requeueForScheduling(orderHash);
        continue;
      }
      if (!scheduleResult.ok) {
        const bestRejectedSummary = scheduleResult.bestObservedEvaluation?.bestRejectedSummary
          ? this.withDerivedRejectedCandidateClass(scheduleResult.bestObservedEvaluation.bestRejectedSummary)
          : undefined;
        const venueAttempts = scheduleResult.bestObservedEvaluation?.venueAttempts.map(
          (attempt) => this.withDerivedRejectedCandidateClass(attempt)
        );
        await this.deps.store.transition(orderHash, 'DROPPED', 'SCHEDULER_NO_EDGE');
        this.deps.metrics.increment('orders_dropped_total{reason="SCHEDULER_NO_EDGE"}');
        this.deps.metrics.increment('scheduler_no_edge_total');
        if (scheduleResult.bestObservedEvaluation) {
          this.deps.metrics.observeHistogram(
            'scheduler_best_observed_net_edge_out',
            Number(scheduleResult.bestObservedEvaluation.netEdgeOut)
          );
        }
        if (bestRejectedSummary?.constraintBreakdown?.nearMiss) {
          this.deps.metrics.incrementSchedulerNearMiss();
        }
        if (bestRejectedSummary) {
          this.deps.metrics.incrementRouteEvalFamilyFalseDominant(
            bestRejectedSummary.venue,
            bestRejectedSummary.pathKind ?? 'DIRECT',
            bestRejectedSummary.executionMode ?? 'EXACT_INPUT'
          );
        }
        if (bestRejectedSummary?.dominanceMargin !== undefined) {
          this.deps.metrics.observeRouteEvalFamilyDominanceMargin(
            bestRejectedSummary.venue,
            bestRejectedSummary.pathKind ?? 'DIRECT',
            bestRejectedSummary.dominanceMargin
          );
        }
        if (bestRejectedSummary?.candidateClass) {
          this.deps.metrics.incrementSchedulerBestRejectedCandidateClass(
            bestRejectedSummary.candidateClass
          );
          if (
            bestRejectedSummary.candidateClass === 'POLICY_BLOCKED'
            && bestRejectedSummary.constraintBreakdown?.nearMiss
          ) {
            this.deps.metrics.incrementSchedulerPolicyBlockedNearMiss();
          }
        }
        if (bestRejectedSummary?.constraintReason === 'REQUIRED_OUTPUT') {
          if (bestRejectedSummary.exactOutputViability?.status === 'UNSATISFIABLE') {
            this.deps.metrics.incrementSchedulerRequiredOutputUnsatisfiable();
            if (bestRejectedSummary.venue === 'CAMELOT_AMMV3') {
              this.deps.metrics.incrementSchedulerCamelotRequiredOutputUnsatisfiable();
            }
          }
          if (bestRejectedSummary.constraintBreakdown?.nearMiss) {
            this.deps.metrics.incrementSchedulerRequiredOutputNearMiss();
          }
        }
        if (bestRejectedSummary?.hedgeGap) {
          this.deps.metrics.incrementSchedulerGapClass(
            bestRejectedSummary.hedgeGap.gapClass
          );
        }
        if (
          bestRejectedSummary?.constraintReason === 'REQUIRED_OUTPUT'
          && bestRejectedSummary.exactOutputViability?.status === 'SATISFIABLE'
        ) {
          this.deps.metrics.incrementSchedulerRequiredOutputSatisfiable();
        }
        this.logger.log('info', 'scheduler_no_edge', {
          orderHash,
          thresholdOut: this.deps.config.thresholdOut.toString(),
          bestObservedNetEdgeOut: scheduleResult.bestObservedEvaluation?.netEdgeOut.toString(),
          bestObservedVenue: scheduleResult.bestObservedEvaluation?.chosenRouteVenue,
          candidateCount: scheduleResult.evaluations.length
        });
        this.logger.log('info', 'routebook_no_edge_summary', {
          orderHash,
          thresholdOut: this.deps.config.thresholdOut.toString(),
          bestObservedNetEdgeOut: scheduleResult.bestObservedEvaluation?.netEdgeOut.toString(),
          bestObservedVenue: scheduleResult.bestObservedEvaluation?.chosenRouteVenue,
          bestRejectedCandidateClass: bestRejectedSummary?.candidateClass,
          bestRejectedReason: bestRejectedSummary?.reason,
          bestRejectedConstraintReason: bestRejectedSummary?.constraintReason,
          bestRejectedNearMiss: bestRejectedSummary?.constraintBreakdown?.nearMiss,
          bestRejectedShortfallOut: bestRejectedSummary?.constraintBreakdown?.minAmountOutShortfallOut.toString(),
          bestRejectedExactOutputStatus: bestRejectedSummary?.exactOutputViability?.status,
          bestRejectedGapClass: bestRejectedSummary?.hedgeGap?.gapClass,
          bestRejectedInputDeficit:
            bestRejectedSummary?.hedgeGap?.inputDeficit?.toString()
            ?? bestRejectedSummary?.exactOutputViability?.inputDeficit?.toString(),
          bestRejectedInputSlack:
            bestRejectedSummary?.hedgeGap?.inputSlack?.toString()
            ?? bestRejectedSummary?.exactOutputViability?.inputSlack?.toString(),
          bestRejectedOutputCoverageBps: bestRejectedSummary?.hedgeGap?.outputCoverageBps.toString(),
          bestRejectedRequiredOutputShortfallOut: bestRejectedSummary?.hedgeGap?.requiredOutputShortfallOut.toString(),
          bestRejectedCheckedFeeTier: bestRejectedSummary?.exactOutputViability?.checkedFeeTier,
          venueAttemptStatuses: venueAttempts?.map((attempt) => ({
            venue: attempt.venue,
            status: attempt.status,
            reason: attempt.reason
          }))
        });
        await this.deps.journal.append({
          type: 'ORDER_DROPPED',
          atMs: Date.now(),
          orderHash,
          payload: {
            reason: 'SCHEDULER_NO_EDGE',
            resolveSnapshot: resolveSnapshot
              ? {
                  chainId: resolveSnapshot.chainId.toString(),
                  blockNumber: resolveSnapshot.blockNumber.toString(),
                  blockNumberish: resolveSnapshot.blockNumberish.toString(),
                  timestamp: resolveSnapshot.timestamp.toString(),
                  baseFeePerGas: resolveSnapshot.baseFeePerGas.toString(),
                  sampledAtMs: Date.now()
                }
              : undefined,
            thresholdOut: this.deps.config.thresholdOut.toString(),
            candidateBlockOffsets: this.deps.config.candidateBlockOffsets.map((offset) => offset.toString()),
            bestObservedNetEdgeOut: scheduleResult.bestObservedEvaluation?.netEdgeOut.toString(),
            bestObservedVenue: scheduleResult.bestObservedEvaluation?.chosenRouteVenue,
            bestRejectedSummary: bestRejectedSummary
              ? (() => {
                  return {
                    ...this.toJournalVenueAttempt(bestRejectedSummary),
                    candidateClass: bestRejectedSummary.candidateClass ?? 'UNKNOWN'
                  };
                })()
              : undefined,
            evaluations: scheduleResult.evaluations.map((evaluation) => this.toCompactDroppedEvaluation({
              ...evaluation,
              venueAttempts: evaluation.venueAttempts.map((attempt) => this.withDerivedRejectedCandidateClass(attempt)),
              bestRejectedSummary: evaluation.bestRejectedSummary
                ? this.withDerivedRejectedCandidateClass(evaluation.bestRejectedSummary)
                : undefined
            }))
          }
        });
        continue;
      }
      const schedule = scheduleResult.schedule;

      await this.deps.store.transition(orderHash, 'SCHEDULED');
      this.deps.metrics.incrementOrdersSupportedToScheduled();
      this.deps.metrics.incrementRouteEvalFamilyChosen(
        schedule.chosenRoute.venue,
        schedule.chosenRoute.pathKind,
        schedule.chosenRoute.executionMode ?? 'EXACT_INPUT'
      );
      this.deps.metrics.incrementRouteEvalFamilyActionableWinner(
        schedule.chosenRoute.venue,
        schedule.chosenRoute.pathKind,
        schedule.chosenRoute.executionMode ?? 'EXACT_INPUT'
      );
      this.hotQueue.push({
        orderHash,
        scheduledBlock: schedule.scheduledBlock,
        competeWindowEnd: schedule.competeWindowEnd,
        predictedEdgeOut: schedule.chosenRoute.netEdgeOut
      });
      while (this.hotQueue.length > BotRuntime.HOT_QUEUE_MAX_ENTRIES) {
        this.hotQueue.shift();
      }
      this.observeRuntimeGaugeSnapshot();
      this.deps.metrics.increment('orders_scheduled_total');
      this.deps.metrics.increment(`route_chosen_total{venue="${schedule.chosenRoute.venue}"}`);
      this.deps.metrics.observeHistogram('first_seen_to_scheduled_ms', Math.max(0, Date.now() - record.firstSeenAtMs));
      await this.deps.journal.append({
        type: 'ORDER_SCHEDULED',
        atMs: Date.now(),
        orderHash,
        payload: {
          scheduledBlock: schedule.scheduledBlock.toString(),
          competeWindowEnd: schedule.competeWindowEnd.toString(),
          predictedEdgeOut: schedule.chosenRoute.netEdgeOut.toString(),
          chosenVenue: schedule.chosenRoute.venue
        }
      });
    }
  }

  private async hotLaneTick(): Promise<void> {
    this.deps.metrics.increment('bot_runtime_ticks_total');
    const hotLane = this.deps.hotLaneContext;
    if (!hotLane) {
      return;
    }

    for (let index = 0; index < this.hotQueue.length; ) {
      const queued = this.hotQueue[index]!;
      const record = await this.deps.store.get(queued.orderHash);
      const normalized = record?.normalizedOrder;
      if (!record || !normalized) {
        this.hotQueue.splice(index, 1);
        continue;
      }
      if (this.isTerminalOrderState(record.state)) {
        this.logTerminalOrderSkipped(queued.orderHash, record.state, 'hot_lane_queue_processing');
        this.removeQueuedEntries(queued.orderHash);
        continue;
      }
      if (record.state !== 'SCHEDULED' && record.state !== 'PLAN_BUILT') {
        this.hotQueue.splice(index, 1);
        continue;
      }

      const outputToken = normalized.decodedOrder.order.baseOutputs[0]?.token;
      if (!outputToken) {
        this.hotQueue.splice(index, 1);
        continue;
      }

      const policy = decideExecutionMode(
        {
          inputToken: normalized.decodedOrder.order.baseInput.token,
          outputToken,
          inputAmount: normalized.decodedOrder.order.baseInput.startAmount
        },
        { netEdgeOut: queued.predictedEdgeOut },
        this.deps.config,
        { inflightCount: this.getPolicyInflightCount() }
      );

      if (policy.mode === 'SKIP') {
        await this.deps.store.transition(queued.orderHash, 'DROPPED', policy.reason);
        this.deps.metrics.increment(`orders_dropped_total{reason="${policy.reason}"}`);
        await this.deps.journal.append({
          type: 'ORDER_DROPPED',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: {
            reason: policy.reason,
            netEdgeOut: queued.predictedEdgeOut.toString()
          }
        });
        this.hotQueue.splice(index, 1);
        continue;
      }

      const liveAttemptTracking = policy.mode === 'LIVE';
      if (liveAttemptTracking) {
        this.deps.inflightTracker.markAttempted(queued.orderHash);
      }
      const routeEvalReadCache = new RouteEvalReadCache({
        maxEntries: this.deps.config.routeEvalCacheMaxEntries,
        maxNegativeEntries: this.deps.config.routeEvalNegativeCacheMaxEntries
      });

      const decision = await runHotLaneStep({
        entry: queued,
        currentBlock: queued.scheduledBlock,
        thresholdOut: this.deps.config.thresholdOut,
        normalizedOrder: normalized,
        order: normalized.decodedOrder.order,
        routeBook: hotLane.routeBook,
        resolveEnv: hotLane.resolveEnv,
        conditionalEnvelope: hotLane.conditionalEnvelope,
        executor: hotLane.executor,
        simService: hotLane.simService,
        sequencerClient: hotLane.sequencerClient,
        nonceManager: hotLane.nonceManager,
        executionPreparer: hotLane.executionPreparer,
        shadowMode: policy.mode !== 'LIVE',
        routeEvalReadCache
      });
      this.deps.metrics.setGauge('route_eval_cache_entries', routeEvalReadCache.getEntryCount());
      this.deps.metrics.setGauge('route_eval_negative_cache_entries', routeEvalReadCache.getNegativeEntryCount());
      this.deps.metrics.setGauge('route_eval_cache_snapshots', routeEvalReadCache.getSnapshotCount());

      if (decision.action === 'WAIT') {
        if (liveAttemptTracking) {
          this.deps.inflightTracker.markResolved(queued.orderHash);
        }
        index += 1;
        continue;
      }
      if (decision.action === 'REQUEUE' && decision.reason === 'PREPARE_STALE_PLAN') {
        const retry = this.stalePlanRetryByOrder.get(queued.orderHash) ?? { attempts: 0, nextEligibleTick: this.schedulerTickCounter };
        const nextAttempts = retry.attempts + 1;
        this.deps.metrics.increment('prepare_stale_plan_total');
        this.deps.metrics.increment('prepare_preflight_failed_total');
        this.deps.metrics.increment('prepare_preflight_failed_total{reason="PREPARE_STALE_PLAN"}');
        this.deps.metrics.increment('prepare_failure_reason_total{reason="PREPARE_STALE_PLAN"}');
        if (nextAttempts <= STALE_PLAN_MAX_RETRIES) {
          this.stalePlanRetryByOrder.set(queued.orderHash, {
            attempts: nextAttempts,
            nextEligibleTick: this.schedulerTickCounter + this.deps.config.infraBlockedRetryCooldownTicks
          });
          this.deps.ingress.requeueForScheduling(queued.orderHash);
          this.removeQueuedEntries(queued.orderHash);
          this.deps.inflightTracker.markResolved(queued.orderHash);
          await this.deps.journal.append({
            type: 'ORDER_PREPARE_FAILED',
            atMs: Date.now(),
            orderHash: queued.orderHash,
            payload: {
              orderHash: queued.orderHash,
              venue: decision.chosenRouteVenue,
              pathKind: decision.pathKind,
              hopCount: decision.hopCount,
              bridgeToken: decision.bridgeToken,
              executionMode: decision.executionMode,
              pathDescriptor: decision.pathDescriptor,
              error: decision.prepareError ?? 'STALE_PLAN',
              message: decision.prepareMessage ?? 'execution plan is stale',
              errorCategory: 'PREPARE_STALE_PLAN',
              errorMessage: decision.prepareMessage ?? 'execution plan is stale'
            }
          });
          await this.deps.journal.append({
            type: 'PREPARED',
            atMs: Date.now(),
            orderHash: queued.orderHash,
            payload: { ok: false, reason: 'PREPARE_STALE_PLAN' }
          });
          continue;
        }
        this.stalePlanRetryByOrder.delete(queued.orderHash);
        await this.deps.store.transition(queued.orderHash, 'DROPPED', 'PREPARE_STALE_PLAN');
        await this.deps.journal.append({
          type: 'ORDER_DROPPED',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: {
            reason: 'PREPARE_STALE_PLAN',
            chosenRouteVenue: decision.chosenRouteVenue,
            chosenRoutePathKind: decision.pathKind,
            chosenRouteHopCount: decision.hopCount,
            chosenRouteBridgeToken: decision.bridgeToken,
            chosenRouteExecutionMode: decision.executionMode,
            chosenRoutePathDescriptor: decision.pathDescriptor,
            error: decision.prepareError ?? 'STALE_PLAN_RETRY_EXHAUSTED',
            message: decision.prepareMessage ?? 'stale plan retry exhausted',
            errorCategory: 'PREPARE_STALE_PLAN',
            errorMessage: decision.prepareMessage ?? 'stale plan retry exhausted'
          }
        });
        this.deps.metrics.increment('orders_dropped_total{reason="PREPARE_STALE_PLAN"}');
        this.deps.inflightTracker.markResolved(queued.orderHash);
        this.hotQueue.splice(index, 1);
        this.observeRuntimeGaugeSnapshot();
        continue;
      }

      const latestRecordBeforePlanBuild = await this.deps.store.get(queued.orderHash);
      if (!latestRecordBeforePlanBuild?.normalizedOrder) {
        this.removeQueuedEntries(queued.orderHash);
        continue;
      }
      if (this.isTerminalOrderState(latestRecordBeforePlanBuild.state)) {
        this.logTerminalOrderSkipped(queued.orderHash, latestRecordBeforePlanBuild.state, 'plan_build_transition');
        this.removeQueuedEntries(queued.orderHash);
        continue;
      }
      if (latestRecordBeforePlanBuild.state !== 'SCHEDULED' && latestRecordBeforePlanBuild.state !== 'PLAN_BUILT') {
        this.removeQueuedEntries(queued.orderHash);
        continue;
      }

      this.deps.metrics.increment('plan_built_total');
      await this.deps.store.transition(queued.orderHash, 'PLAN_BUILT');
      if ('chosenRouteVenue' in decision && decision.chosenRouteVenue) {
        this.deps.metrics.increment(`route_chosen_total{venue="${decision.chosenRouteVenue}"}`);
      }
      if ('routeAlternatives' in decision && decision.routeAlternatives) {
        for (const candidate of decision.routeAlternatives) {
          this.deps.metrics.increment(
            `route_candidate_total{venue="${candidate.venue}",result="${candidate.eligible ? 'eligible' : 'rejected'}"}`
          );
          if (!candidate.eligible || candidate.reason) {
            this.deps.metrics.increment(
              `route_rejected_total{venue="${candidate.venue}",reason="${candidate.reason ?? 'INELIGIBLE'}"}`
            );
          }
        }
      }
      await this.deps.journal.append({
        type: 'PLAN_BUILT',
        atMs: Date.now(),
        orderHash: queued.orderHash,
        payload: {
          ok: true,
          routeDecision: decision.preparedExecution
            ? buildRouteDecisionAttribution(decision.preparedExecution.executionPlan)
            : undefined
        }
      });
      this.deps.metrics.incrementPreparePreflight();

      let preparedAtMs: number | undefined;
      if ('preparedExecution' in decision && decision.preparedExecution) {
        preparedAtMs = Date.now();
        this.deps.metrics.observeHistogram('first_seen_to_prepared_ms', Math.max(0, Date.now() - record.firstSeenAtMs));
        await this.deps.journal.append({
          type: 'PREPARED',
          atMs: preparedAtMs,
          orderHash: queued.orderHash,
          payload: { ok: true, nonce: decision.preparedExecution.nonce.toString() }
        });
      }
      if (decision.action === 'DROP' && decision.reason === 'PREPARE_FAILED') {
        const error = (decision.prepareError ?? 'PrepareError').trim() || 'PrepareError';
        const message = (decision.prepareMessage ?? 'executionPreparer failed').trim() || 'executionPreparer failed';
        const prepareFailureReason = decision.prepareFailureReason ?? 'PREPARE_TX_BUILD_FAILED';
        this.deps.metrics.incrementOrdersPrepareFailed(decision.chosenRouteVenue, decision.pathKind, decision.executionMode);
        this.deps.metrics.increment('prepare_preflight_failed_total');
        this.deps.metrics.increment(`prepare_preflight_failed_total{reason="${prepareFailureReason}"}`);
        this.deps.metrics.increment('prepare_preflight_failed_total{reason="PREPARE_FAILED"}');
        if (prepareFailureReason === 'PREPARE_CALL_REVERTED') {
          this.deps.metrics.increment('prepare_call_reverted_total');
        }
        if (prepareFailureReason === 'PREPARE_ESTIMATE_GAS_FAILED') {
          this.deps.metrics.increment('prepare_estimate_gas_failed_total');
        }
        this.deps.metrics.increment(`prepare_failure_reason_total{reason="${error}"}`);
        await this.deps.journal.append({
          type: 'PREPARED',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: { ok: false, reason: decision.reason }
        });
        await this.deps.journal.append({
          type: 'ORDER_PREPARE_FAILED',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: {
            orderHash: queued.orderHash,
            venue: decision.chosenRouteVenue,
            pathKind: decision.pathKind,
            hopCount: decision.hopCount,
            bridgeToken: decision.bridgeToken,
            executionMode: decision.executionMode,
            pathDescriptor: decision.pathDescriptor,
            candidateClass: decision.chosenRouteCandidateClass,
            constraintReason: decision.chosenRouteConstraintReason,
            error,
            message,
            errorCategory: prepareFailureReason,
            errorMessage: message,
            errorSelector: 'prepareErrorSelector' in decision ? decision.prepareErrorSelector : undefined,
            decodedErrorName: 'decodedErrorName' in decision ? decision.decodedErrorName : undefined
          }
        });
      }
      if ('simResult' in decision && decision.simResult) {
        const simOk = decision.simResult.ok;
        this.deps.metrics.increment(
          simOk
            ? `sim_ok_total{venue="${decision.chosenRouteVenue}"}`
            : `sim_fail_total{venue="${decision.chosenRouteVenue}",reason="${decision.simResult.reason}"}`
        );
        await this.deps.journal.append({
          type: 'SIM_RESULT',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: {
            ok: simOk,
            reason: decision.simResult.reason,
            attribution:
              decision.preparedExecution
                ? buildExecutionOutcomeAttribution({
                    plan: decision.preparedExecution.executionPlan,
                    simResult: decision.simResult
                  })
                : undefined
          }
        });
      }

      if (decision.action === 'NO_SEND') {
        await this.deps.store.transition(queued.orderHash, 'SIM_OK', 'SHADOW_MODE');
        this.deps.inflightTracker.markResolved(queued.orderHash);
        this.deps.metrics.increment(`send_attempt_total{venue="${decision.chosenRouteVenue}",mode="SHADOW",writer="shadow"}`);
        this.deps.metrics.increment('shadow_would_send_total');
        await this.deps.journal.append({
          type: 'SEND_ATTEMPT',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: { mode: 'SHADOW', writer: 'shadow' }
        });
        await this.deps.journal.append({
          type: 'SEND_RESULT',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: { accepted: false, reason: 'SHADOW_MODE' }
        });
      } else if (decision.action === 'WOULD_SEND' || (decision.action === 'DROP' && decision.sendResult)) {
        const writer = decision.sendResult?.attempts[0]?.writer ?? 'sequencer';
        this.deps.metrics.increment(
          `send_attempt_total{venue="${decision.chosenRouteVenue}",mode="LIVE",writer="${writer}"}`
        );
        this.deps.metrics.observeHistogram('first_seen_to_send_attempt_ms', Math.max(0, Date.now() - record.firstSeenAtMs));
        await this.deps.journal.append({
          type: 'SEND_ATTEMPT',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: { mode: 'LIVE', writer }
        });

        const accepted = decision.action === 'WOULD_SEND' && decision.sendResult.accepted;
        if (accepted) {
          await this.deps.store.transition(
            queued.orderHash,
            'SIM_OK',
            decision.action === 'WOULD_SEND' ? decision.simResult.reason : 'SUPPORTED'
          );
          await this.deps.store.transition(queued.orderHash, 'SUBMITTING');
          this.deps.metrics.increment('live_send_total');
          if (this.deps.config.canaryMode) {
            this.deps.metrics.increment('canary_live_send_total');
          }
          this.deps.metrics.increment(`send_accept_total{venue="${decision.chosenRouteVenue}",writer="${writer}"}`);
        } else {
          this.deps.inflightTracker.markResolved(queued.orderHash);
          this.deps.metrics.increment(
            `send_reject_total{venue="${decision.chosenRouteVenue}",reason="SEND_REJECTED"}`
          );
        }
        if (preparedAtMs !== undefined) {
          this.deps.metrics.observeHistogram('prepared_to_send_result_ms', Math.max(0, Date.now() - preparedAtMs));
        }
        await this.deps.journal.append({
          type: 'SEND_RESULT',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: {
            accepted,
            reason: accepted ? undefined : 'SEND_REJECTED',
            writer,
            attribution:
              decision.preparedExecution
                ? buildExecutionOutcomeAttribution({
                    plan: decision.preparedExecution.executionPlan,
                    simResult: decision.simResult,
                    sendResult: decision.sendResult
                  })
                : undefined
          }
        });
      }

      if (decision.action === 'DROP') {
        let removedQueuedEntries = false;
        const hotResolveEnv = this.deps.hotLaneContext?.resolveEnv;
        const hotResolveSnapshot = hotResolveEnv
          ? {
              chainId: (hotResolveEnv.chainId ?? 42161n).toString(),
              blockNumber: queued.scheduledBlock.toString(),
              blockNumberish: queued.scheduledBlock.toString(),
              timestamp: hotResolveEnv.timestamp.toString(),
              baseFeePerGas: hotResolveEnv.basefee.toString(),
              sampledAtMs: Date.now()
            }
          : undefined;
        if (decision.simResult && !decision.simResult.ok) {
          await this.deps.store.transition(queued.orderHash, 'SIM_FAIL', decision.simResult.reason);
          this.blockedRetryByOrder.delete(queued.orderHash);
        } else if (decision.reason === 'PREPARE_FAILED') {
          await this.deps.store.transition(queued.orderHash, 'PREPARE_FAILED', decision.reason);
          this.blockedRetryByOrder.delete(queued.orderHash);
          this.removeQueuedEntries(queued.orderHash);
          removedQueuedEntries = true;
        } else if (decision.reason === 'INFRA_BLOCKED') {
          await this.deps.store.transition(queued.orderHash, 'SUPPORTED', 'INFRA_BLOCKED');
          this.deps.ingress.requeueForScheduling(queued.orderHash);
          this.deps.metrics.incrementOrdersEvaluationBlocked();
          await this.deps.journal.append({
            type: 'ORDER_EVALUATION_BLOCKED',
            atMs: Date.now(),
            orderHash: queued.orderHash,
            payload: {
              orderHash: queued.orderHash,
              reason: 'INFRA_BLOCKED',
              candidateCount: 1,
              blockedCount: 1,
              revertedProbeCount: 0,
              revertedProbeBudgetExhausted: false
            }
          });
        } else {
          await this.deps.store.transition(queued.orderHash, 'DROPPED', decision.reason);
          this.blockedRetryByOrder.delete(queued.orderHash);
        }
        if (decision.reason !== 'INFRA_BLOCKED') {
          this.deps.metrics.increment(`orders_dropped_total{reason="${decision.reason}"}`);
        }
      if (decision.reason === 'INFRA_BLOCKED') {
          this.deps.inflightTracker.markResolved(queued.orderHash);
          this.hotQueue.splice(index, 1);
          this.observeRuntimeGaugeSnapshot();
          continue;
        }
        const droppedErrorContext =
          decision.reason === 'PREPARE_FAILED'
            ? {
                error: decision.prepareError ?? 'PrepareError',
                message: decision.prepareMessage ?? 'executionPreparer failed',
                errorCategory: decision.prepareFailureReason ?? decision.prepareError ?? 'PrepareError',
                errorMessage: decision.prepareMessage ?? 'executionPreparer failed',
                errorSelector: 'prepareErrorSelector' in decision ? decision.prepareErrorSelector : undefined,
                decodedErrorName: 'decodedErrorName' in decision ? decision.decodedErrorName : undefined
              }
            : undefined;
        await this.deps.journal.append({
          type: 'ORDER_DROPPED',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: {
            reason: decision.reason,
            resolveSnapshot: hotResolveSnapshot,
            chosenRouteVenue: decision.chosenRouteVenue,
            chosenRoutePathKind: decision.pathKind,
            chosenRouteHopCount: decision.hopCount,
            chosenRouteBridgeToken: decision.bridgeToken,
            chosenRouteExecutionMode: decision.executionMode,
            chosenRoutePathDescriptor: decision.pathDescriptor,
            chosenRouteCandidateClass: decision.chosenRouteCandidateClass,
            chosenRouteConstraintReason: decision.chosenRouteConstraintReason,
            netEdgeOut: queued.predictedEdgeOut.toString(),
            simReason: decision.simResult?.reason,
            error: droppedErrorContext?.error,
            message: droppedErrorContext?.message,
            errorCategory: droppedErrorContext?.errorCategory,
            errorMessage: droppedErrorContext?.errorMessage
          }
        });
        this.deps.inflightTracker.markResolved(queued.orderHash);
        if (removedQueuedEntries) {
          this.observeRuntimeGaugeSnapshot();
          continue;
        }
      }

      this.hotQueue.splice(index, 1);
      this.observeRuntimeGaugeSnapshot();
    }
  }
}
