import { findFirstProfitableBlock } from '../scheduler/firstProfitableBlock.js';
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

export type SchedulerContext = {
  routeBook: RouteBook;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
};

export type HotLaneContext = SchedulerContext & {
  conditionalEnvelope: ConditionalEnvelope;
  executor: `0x${string}`;
  simService: ForkSimService;
  sequencerClient: SequencerClient;
  nonceManager: NonceManager;
  executionPreparer: (input: { executionPlan: ExecutionPlan }) => Promise<PreparedExecution>;
};

type ScheduledOrder = HotLaneEntry;

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

  constructor(private readonly deps: BotRuntimeDeps) {
    this.logger = deps.logger ?? new JsonConsoleLogger();
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private getPolicyInflightCount(): number {
    return this.deps.inflightTracker.getInflightCount();
  }

  private assertTradingDependencies(): void {
    if (!this.deps.schedulerContext || !this.deps.hotLaneContext) {
      throw new Error('runtime trading dependencies are required (schedulerContext/hotLaneContext)');
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
    const scheduler = this.deps.schedulerContext;
    if (!scheduler) {
      return;
    }

    for (const orderHash of this.deps.ingress.dequeueForScheduling()) {
      const record = await this.deps.store.get(orderHash);
      if (!record?.normalizedOrder) {
        continue;
      }
        const schedule = await findFirstProfitableBlock({
          order: record.normalizedOrder.decodedOrder.order,
          baseEnv: scheduler.resolveEnv,
          routeBook: scheduler.routeBook,
          candidateBlocks: this.deps.config.candidateBlocks,
          threshold: this.deps.config.thresholdOut,
          competeWindowBlocks: this.deps.config.competeWindowBlocks
      });
      if (!schedule) {
        this.deps.metrics.increment('orders_dropped_total{reason="SCHEDULER_NO_EDGE"}');
        await this.deps.journal.append({
          type: 'ORDER_DROPPED',
          atMs: Date.now(),
          orderHash,
          payload: { reason: 'SCHEDULER_NO_EDGE' }
        });
        continue;
      }

      await this.deps.store.transition(orderHash, 'SCHEDULED');
      this.hotQueue.push({
        orderHash,
        scheduledBlock: schedule.scheduledBlock,
        competeWindowEnd: schedule.competeWindowEnd,
        predictedEdgeOut: schedule.chosenRoute.netEdgeOut
      });
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
        this.deps.metrics.increment(`orders_dropped_total{reason="${policy.reason}"}`);
        await this.deps.journal.append({
          type: 'ORDER_DROPPED',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: { reason: policy.reason }
        });
        this.hotQueue.splice(index, 1);
        continue;
      }

      const liveAttemptTracking = policy.mode === 'LIVE';
      if (liveAttemptTracking) {
        this.deps.inflightTracker.markAttempted(queued.orderHash);
      }

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
        shadowMode: policy.mode !== 'LIVE'
      });

      if (decision.action === 'WAIT') {
        if (liveAttemptTracking) {
          this.deps.inflightTracker.markResolved(queued.orderHash);
        }
        index += 1;
        continue;
      }

      this.deps.metrics.increment('plan_built_total');
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
      } else if (decision.action === 'DROP') {
        this.deps.inflightTracker.markResolved(queued.orderHash);
      }

      this.hotQueue.splice(index, 1);
    }
  }
}
