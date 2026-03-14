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
import type { OrderStore } from '../store/types.js';
import type { ResolveEnv } from '@uni/protocol';
import type { UniV3RoutePlanner } from '../routing/univ3/routePlanner.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { ForkSimService } from '../sim/forkSimService.js';
import type { SequencerClient } from '../send/sequencerClient.js';
import { NonceManager } from '../send/nonceManager.js';
import type { ExecutionPlan } from '../execution/types.js';
import type { PreparedExecution } from '../execution/preparedExecution.js';

type SchedulerContext = {
  routePlanner: UniV3RoutePlanner;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
};

type HotLaneContext = SchedulerContext & {
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
  schedulerContext?: SchedulerContext;
  hotLaneContext?: HotLaneContext;
};

export class BotRuntime {
  private pollTimer: NodeJS.Timeout | undefined;
  private schedulerTimer: NodeJS.Timeout | undefined;
  private hotLaneTimer: NodeJS.Timeout | undefined;
  private readonly hotQueue: ScheduledOrder[] = [];

  constructor(private readonly deps: BotRuntimeDeps) {}

  async start(): Promise<void> {
    if (this.pollTimer || this.schedulerTimer || this.hotLaneTimer) {
      return;
    }

    if (this.deps.webhookServer) {
      await this.deps.webhookServer.start();
    }
    if (this.deps.metricsServer) {
      await this.deps.metricsServer.start();
    }

    this.pollTimer = setInterval(() => void this.pollTick(), this.deps.config.pollCadenceMs);
    this.schedulerTimer = setInterval(() => void this.schedulerTick(), this.deps.config.schedulerCadenceMs);
    this.hotLaneTimer = setInterval(() => void this.hotLaneTick(), this.deps.config.hotLaneCadenceMs);

    await this.pollTick();
    await this.schedulerTick();
    await this.hotLaneTick();
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
  }

  private async schedulerTick(): Promise<void> {
    const scheduler = this.deps.schedulerContext;
    if (!scheduler) {
      return;
    }

    for (const orderHash of this.deps.ingress.dequeueForScheduling()) {
      const record = this.deps.store.get(orderHash);
      if (!record?.normalizedOrder) {
        continue;
      }
      const schedule = await findFirstProfitableBlock({
        order: record.normalizedOrder.decodedOrder.order,
        baseEnv: scheduler.resolveEnv,
        routePlanner: scheduler.routePlanner,
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

      this.deps.store.transition(orderHash, 'SCHEDULED');
      this.hotQueue.push({
        orderHash,
        scheduledBlock: schedule.scheduledBlock,
        competeWindowEnd: schedule.competeWindowEnd,
        predictedEdgeOut: schedule.chosenRoute.netEdgeOut
      });
      this.deps.metrics.increment('orders_scheduled_total');
      this.deps.metrics.observeHistogram('first_seen_to_scheduled_ms', Math.max(0, Date.now() - record.firstSeenAtMs));
      await this.deps.journal.append({
        type: 'ORDER_SCHEDULED',
        atMs: Date.now(),
        orderHash,
        payload: {
          scheduledBlock: schedule.scheduledBlock.toString(),
          competeWindowEnd: schedule.competeWindowEnd.toString(),
          predictedEdgeOut: schedule.chosenRoute.netEdgeOut.toString()
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
      const record = this.deps.store.get(queued.orderHash);
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
        { inflightCount: this.hotQueue.length }
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

      const decision = await runHotLaneStep({
        entry: queued,
        currentBlock: queued.scheduledBlock,
        thresholdOut: this.deps.config.thresholdOut,
        normalizedOrder: normalized,
        order: normalized.decodedOrder.order,
        routePlanner: hotLane.routePlanner,
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
        index += 1;
        continue;
      }

      this.deps.metrics.increment('plan_built_total');
      await this.deps.journal.append({
        type: 'PLAN_BUILT',
        atMs: Date.now(),
        orderHash: queued.orderHash,
        payload: { ok: true }
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
        this.deps.metrics.increment(simOk ? 'sim_ok_total' : `sim_fail_total{reason="${decision.simResult.reason}"}`);
        await this.deps.journal.append({
          type: 'SIM_RESULT',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: { ok: simOk, reason: decision.simResult.reason }
        });
      }

      if (decision.action === 'NO_SEND') {
        this.deps.metrics.increment('send_attempt_total{mode="SHADOW",writer="shadow"}');
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
        this.deps.metrics.increment(`send_attempt_total{mode="LIVE",writer="${writer}"}`);
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
          this.deps.metrics.increment(`send_accept_total{writer="${writer}"}`);
        } else {
          this.deps.metrics.increment('send_reject_total{reason="SEND_REJECTED"}');
        }
        if (preparedAtMs !== undefined) {
          this.deps.metrics.observeHistogram('prepared_to_send_result_ms', Math.max(0, Date.now() - preparedAtMs));
        }
        await this.deps.journal.append({
          type: 'SEND_RESULT',
          atMs: Date.now(),
          orderHash: queued.orderHash,
          payload: { accepted, reason: accepted ? undefined : 'SEND_REJECTED', writer }
        });
      }

      this.hotQueue.splice(index, 1);
    }
  }
}
