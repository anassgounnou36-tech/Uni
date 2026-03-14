import type { ResolveEnv, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import { findFirstProfitableBlock } from '../scheduler/firstProfitableBlock.js';
import { runHotLaneStep } from '../scheduler/hotLane.js';
import type { UniV3RoutePlanner } from '../routing/univ3/routePlanner.js';
import type { ForkSimService } from '../sim/forkSimService.js';
import type { NormalizedOrder, OrderReasonCode, OrderStore } from '../store/types.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { SequencerClient } from '../send/sequencerClient.js';
import { NonceManager } from '../send/nonceManager.js';
import type { PreparedExecution } from '../execution/preparedExecution.js';
import type { ExecutionPlan } from '../execution/types.js';

export type ReplaySupportPolicy = {
  allowlistedPairs: ReadonlyArray<{ inputToken: `0x${string}`; outputToken: `0x${string}` }>;
  thresholdOut: bigint;
  candidateBlocks: readonly bigint[];
  competeWindowBlocks: bigint;
};

export type ReplayRecord = {
  orderHash: `0x${string}`;
  scheduledBlock?: bigint;
  decision: 'NO_SEND' | 'WOULD_SEND';
  reason: OrderReasonCode;
  predictedEdgeOut: bigint;
  simResult: 'SIM_OK' | 'SIM_FAIL' | 'NOT_RUN';
  preparedExecution?: PreparedExecution;
};

export type ReplayRunnerParams = {
  corpus: readonly NormalizedOrder[];
  store: OrderStore;
  supportPolicy: ReplaySupportPolicy;
  routePlanner: UniV3RoutePlanner;
  simService: ForkSimService;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  shadowMode: boolean;
  executor: `0x${string}`;
  conditionalEnvelope: ConditionalEnvelope;
  sequencerClient: SequencerClient;
  nonceManager: NonceManager;
  executionPreparer: (input: { executionPlan: ExecutionPlan }) => Promise<PreparedExecution>;
};

function normalize(address: `0x${string}`): string {
  return address.toLowerCase();
}

function isAllowlisted(order: V3DutchOrder, allowlistedPairs: ReplaySupportPolicy['allowlistedPairs']): boolean {
  const outputToken = order.baseOutputs[0]?.token;
  if (!outputToken) {
    return false;
  }
  return allowlistedPairs.some(
    (pair) => normalize(pair.inputToken) === normalize(order.baseInput.token) && normalize(pair.outputToken) === normalize(outputToken)
  );
}

function classifySupport(order: V3DutchOrder, policy: ReplaySupportPolicy): OrderReasonCode {
  if (order.baseOutputs.length === 0) {
    return 'EXOTIC_OUTPUT_SHAPE';
  }
  const firstOutput = order.baseOutputs[0]!;
  const sameToken = order.baseOutputs.every((output) => normalize(output.token) === normalize(firstOutput.token));
  if (!sameToken) {
    return 'OUTPUT_TOKEN_MISMATCH';
  }
  const sameRecipient = order.baseOutputs.every((output) => normalize(output.recipient) === normalize(firstOutput.recipient));
  if (!sameRecipient) {
    return 'EXOTIC_OUTPUT_SHAPE';
  }
  if (!isAllowlisted(order, policy.allowlistedPairs)) {
    return 'TOKEN_PAIR_NOT_ALLOWLISTED';
  }
  return 'SUPPORTED';
}

export async function runReplay(params: ReplayRunnerParams): Promise<ReplayRecord[]> {
  const orderedCorpus = [...params.corpus].sort((a, b) => a.orderHash.localeCompare(b.orderHash));
  const records: ReplayRecord[] = [];

  for (const normalized of orderedCorpus) {
    params.store.upsertDiscovered(normalized, normalized);
    params.store.transition(normalized.orderHash, 'DECODED');
    const order = normalized.decodedOrder.order;

    const support = classifySupport(order, params.supportPolicy);
    if (support !== 'SUPPORTED') {
      params.store.transition(normalized.orderHash, 'UNSUPPORTED', support);
      records.push({
        orderHash: normalized.orderHash,
        decision: 'NO_SEND',
        reason: support,
        predictedEdgeOut: 0n,
        simResult: 'NOT_RUN'
      });
      continue;
    }

    params.store.transition(normalized.orderHash, 'SUPPORTED', 'SUPPORTED');

    const schedule = await findFirstProfitableBlock({
      order,
      baseEnv: params.resolveEnv,
      routePlanner: params.routePlanner,
      candidateBlocks: params.supportPolicy.candidateBlocks,
      threshold: params.supportPolicy.thresholdOut,
      competeWindowBlocks: params.supportPolicy.competeWindowBlocks
    });

    if (!schedule) {
      let noEdgeReason: OrderReasonCode = 'SCHEDULER_NO_EDGE';
      const probeBlock = params.supportPolicy.candidateBlocks[0];
      if (probeBlock !== undefined) {
        const probeResolved = await resolveAt(order, { ...params.resolveEnv, blockNumberish: probeBlock });
        const probeRoute = await params.routePlanner.planBestRoute({ resolvedOrder: probeResolved });
        if (!probeRoute.ok && probeRoute.failure.reason === 'NOT_PRICEABLE_GAS') {
          noEdgeReason = 'NOT_PRICEABLE_GAS';
        }
      }

      params.store.transition(normalized.orderHash, 'SIM_FAIL', noEdgeReason);
      records.push({
        orderHash: normalized.orderHash,
        decision: 'NO_SEND',
        reason: noEdgeReason,
        predictedEdgeOut: 0n,
        simResult: 'NOT_RUN'
      });
      continue;
    }

    params.store.transition(normalized.orderHash, 'SCHEDULED');

    const predictedEdgeOut = schedule.chosenRoute.netEdgeOut;
    const hotDecision = await runHotLaneStep({
      entry: {
        orderHash: normalized.orderHash,
        scheduledBlock: schedule.scheduledBlock,
        competeWindowEnd: schedule.competeWindowEnd,
        predictedEdgeOut
      },
      currentBlock: schedule.scheduledBlock,
      thresholdOut: params.supportPolicy.thresholdOut,
      normalizedOrder: normalized,
      order,
      routePlanner: params.routePlanner,
      resolveEnv: params.resolveEnv,
      conditionalEnvelope: params.conditionalEnvelope,
      executor: params.executor,
      simService: params.simService,
      sequencerClient: params.sequencerClient,
      nonceManager: params.nonceManager,
      executionPreparer: params.executionPreparer,
      shadowMode: params.shadowMode
    });

    if (hotDecision.action === 'WOULD_SEND') {
      params.store.transition(normalized.orderHash, 'SIM_OK', 'SUPPORTED');
      params.store.transition(normalized.orderHash, 'SUBMITTING');
      records.push({
        orderHash: normalized.orderHash,
        scheduledBlock: schedule.scheduledBlock,
        decision: 'WOULD_SEND',
        reason: 'SUPPORTED',
        predictedEdgeOut,
        simResult: 'SIM_OK',
        preparedExecution: hotDecision.preparedExecution
      });
      continue;
    }

    if (hotDecision.action === 'NO_SEND') {
      params.store.transition(normalized.orderHash, 'SIM_OK', 'SHADOW_MODE');
      records.push({
        orderHash: normalized.orderHash,
        scheduledBlock: schedule.scheduledBlock,
        decision: 'NO_SEND',
        reason: 'SHADOW_MODE',
        predictedEdgeOut,
        simResult: 'SIM_OK',
        preparedExecution: hotDecision.preparedExecution
      });
      continue;
    }

    const failureReason = hotDecision.action === 'DROP' ? hotDecision.simResult?.reason ?? 'NOT_PROFITABLE' : 'NOT_PROFITABLE';
    params.store.transition(normalized.orderHash, 'SIM_FAIL', failureReason);
    records.push({
      orderHash: normalized.orderHash,
      scheduledBlock: schedule.scheduledBlock,
      decision: 'NO_SEND',
      reason: failureReason,
      predictedEdgeOut,
      simResult: 'SIM_FAIL',
      preparedExecution: hotDecision.action === 'DROP' ? hotDecision.preparedExecution : undefined
    });
  }

  return records;
}
