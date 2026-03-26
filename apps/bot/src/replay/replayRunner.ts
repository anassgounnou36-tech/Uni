import type { ResolveEnv, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import { RouteEvalReadCache } from '../routing/rpc/readCache.js';
import { findFirstProfitableBlock } from '../scheduler/firstProfitableBlock.js';
import { runHotLaneStep } from '../scheduler/hotLane.js';
import type { RouteBook } from '../routing/routeBook.js';
import type { ForkSimService } from '../sim/forkSimService.js';
import type { NormalizedOrder, OrderReasonCode, OrderStore } from '../store/types.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { SequencerClient } from '../send/sequencerClient.js';
import { NonceManager } from '../send/nonceManager.js';
import type { PreparedExecution } from '../execution/preparedExecution.js';
import type { ExecutionPlan } from '../execution/types.js';
import type { RouteCandidateSummary } from '../routing/venues.js';
import type { ResolveEnvProvider } from '../runtime/resolveEnvProvider.js';

export type ReplaySupportPolicy = {
  allowlistedPairs: ReadonlyArray<{ inputToken: `0x${string}`; outputToken: `0x${string}` }>;
  thresholdOut: bigint;
  candidateBlockOffsets?: readonly bigint[];
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
  chosenVenue?: 'UNISWAP_V3' | 'CAMELOT_AMMV3' | 'LFJ_LB';
  rejectedVenueSummaries?: RouteCandidateSummary[];
};

export type ReplayRunnerParams = {
  corpus: readonly NormalizedOrder[];
  store: OrderStore;
  supportPolicy: ReplaySupportPolicy;
  routeBook: RouteBook;
  simService: ForkSimService;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  resolveEnvProvider?: ResolveEnvProvider;
  shadowMode: boolean;
  executor: `0x${string}`;
  conditionalEnvelope: ConditionalEnvelope;
  sequencerClient: SequencerClient;
  nonceManager: NonceManager;
  executionPreparer: (input: { executionPlan: ExecutionPlan }) => Promise<PreparedExecution>;
};

export type ReplayRegressionSummary = {
  ordersConsidered: number;
  routeableUniOnly: number;
  routeableCamelotOnly: number;
  routeableBoth: number;
  chosenVenueCounts: Record<'UNISWAP_V3' | 'CAMELOT_AMMV3' | 'LFJ_LB', number>;
  averageBestRouteNetEdgeOut: bigint;
  camelotStrictImprovementCount: number;
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

  const candidateBlockOffsets = params.supportPolicy.candidateBlockOffsets ?? [0n, 1n, 2n];
  for (const normalized of orderedCorpus) {
    await params.store.upsertDiscovered(normalized, normalized);
    await params.store.transition(normalized.orderHash, 'DECODED');
    const order = normalized.decodedOrder.order;

    const support = classifySupport(order, params.supportPolicy);
    if (support !== 'SUPPORTED') {
      await params.store.transition(normalized.orderHash, 'UNSUPPORTED', support);
      records.push({
        orderHash: normalized.orderHash,
        decision: 'NO_SEND',
        reason: support,
        predictedEdgeOut: 0n,
        simResult: 'NOT_RUN'
      });
      continue;
    }

    await params.store.transition(normalized.orderHash, 'SUPPORTED', 'SUPPORTED');

    const scheduleResult = await findFirstProfitableBlock({
      order,
      resolveEnvProvider: params.resolveEnvProvider,
      baseEnv: params.resolveEnv,
      routeBook: params.routeBook,
      candidateBlockOffsets,
      threshold: params.supportPolicy.thresholdOut,
      competeWindowBlocks: params.supportPolicy.competeWindowBlocks
    });

    if (!scheduleResult.ok) {
      let noEdgeReason: OrderReasonCode = 'SCHEDULER_NO_EDGE';
      const probeBlockOffset = candidateBlockOffsets[0];
      let probeBlockNumberish: bigint | undefined = probeBlockOffset;
      if (params.resolveEnvProvider && probeBlockOffset !== undefined) {
        const probeBase = await params.resolveEnvProvider.getCurrent();
        probeBlockNumberish = probeBase.blockNumberish + probeBlockOffset;
      }
      if (probeBlockNumberish !== undefined) {
        const probeResolved = await resolveAt(order, { ...params.resolveEnv, blockNumberish: probeBlockNumberish });
        const probeRoute = await params.routeBook.selectBestRoute({
          resolvedOrder: probeResolved,
          routeEval: {
            chainId: params.resolveEnv.chainId ?? 42161n,
            blockNumberish: probeBlockNumberish,
            readCache: new RouteEvalReadCache()
          }
        });
        if (!probeRoute.ok && probeRoute.reason === 'GAS_NOT_PRICEABLE') {
          noEdgeReason = 'NOT_PRICEABLE_GAS';
        }
      }

      await params.store.transition(normalized.orderHash, 'SIM_FAIL', noEdgeReason);
      records.push({
        orderHash: normalized.orderHash,
        decision: 'NO_SEND',
        reason: noEdgeReason,
        predictedEdgeOut: 0n,
        simResult: 'NOT_RUN'
      });
      continue;
    }
    const schedule = scheduleResult.schedule;

    await params.store.transition(normalized.orderHash, 'SCHEDULED');

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
      routeBook: params.routeBook,
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
      await params.store.transition(normalized.orderHash, 'SIM_OK', 'SUPPORTED');
      await params.store.transition(normalized.orderHash, 'SUBMITTING');
      records.push({
        orderHash: normalized.orderHash,
        scheduledBlock: schedule.scheduledBlock,
        decision: 'WOULD_SEND',
        reason: 'SUPPORTED',
        predictedEdgeOut,
        simResult: 'SIM_OK',
        preparedExecution: hotDecision.preparedExecution,
        chosenVenue: hotDecision.chosenRouteVenue,
        rejectedVenueSummaries: hotDecision.routeAlternatives
      });
      continue;
    }

    if (hotDecision.action === 'NO_SEND') {
      await params.store.transition(normalized.orderHash, 'SIM_OK', 'SHADOW_MODE');
      records.push({
        orderHash: normalized.orderHash,
        scheduledBlock: schedule.scheduledBlock,
        decision: 'NO_SEND',
        reason: 'SHADOW_MODE',
        predictedEdgeOut,
        simResult: 'SIM_OK',
        preparedExecution: hotDecision.preparedExecution,
        chosenVenue: hotDecision.chosenRouteVenue,
        rejectedVenueSummaries: hotDecision.routeAlternatives
      });
      continue;
    }

    const failureReason = hotDecision.action === 'DROP' ? hotDecision.simResult?.reason ?? 'NOT_PROFITABLE' : 'NOT_PROFITABLE';
    await params.store.transition(normalized.orderHash, 'SIM_FAIL', failureReason);
    records.push({
      orderHash: normalized.orderHash,
      scheduledBlock: schedule.scheduledBlock,
      decision: 'NO_SEND',
      reason: failureReason,
      predictedEdgeOut,
      simResult: 'SIM_FAIL',
      preparedExecution: hotDecision.action === 'DROP' ? hotDecision.preparedExecution : undefined,
      chosenVenue: hotDecision.action === 'DROP' ? hotDecision.chosenRouteVenue : undefined,
      rejectedVenueSummaries: hotDecision.action === 'DROP' ? hotDecision.routeAlternatives : undefined
    });
  }

  return records;
}

export async function runReplayRegression(params: {
  corpus: readonly NormalizedOrder[];
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  candidateBlockOffsets?: readonly bigint[];
  resolveEnvProvider?: ResolveEnvProvider;
  baselineRouteBook: RouteBook;
  candidateRouteBook: RouteBook;
}): Promise<ReplayRegressionSummary> {
  let ordersConsidered = 0;
  let routeableUniOnly = 0;
  let routeableCamelotOnly = 0;
  let routeableBoth = 0;
  const chosenVenueCounts: Record<'UNISWAP_V3' | 'CAMELOT_AMMV3' | 'LFJ_LB', number> = {
    UNISWAP_V3: 0,
    CAMELOT_AMMV3: 0,
    LFJ_LB: 0
  };
  let aggregateBestRouteNetEdgeOut = 0n;
  let aggregateBestRouteCount = 0n;
  let camelotStrictImprovementCount = 0;

  for (const order of params.corpus) {
    const blockOffset = (params.candidateBlockOffsets ?? [0n])[0];
    const block = params.resolveEnvProvider && blockOffset !== undefined
      ? (await params.resolveEnvProvider.getCurrent()).blockNumberish + blockOffset
      : blockOffset;
    if (block === undefined) {
      break;
    }
    const resolved = await resolveAt(order.decodedOrder.order, { ...params.resolveEnv, blockNumberish: block });
    const baseline = await params.baselineRouteBook.selectBestRoute({
      resolvedOrder: resolved,
      routeEval: {
        chainId: params.resolveEnv.chainId ?? 42161n,
        blockNumberish: block,
        readCache: new RouteEvalReadCache()
      }
    });
    const candidate = await params.candidateRouteBook.selectBestRoute({
      resolvedOrder: resolved,
      routeEval: {
        chainId: params.resolveEnv.chainId ?? 42161n,
        blockNumberish: block,
        readCache: new RouteEvalReadCache()
      }
    });
    ordersConsidered += 1;

    const baselineHasUni = baseline.alternativeRoutes.some((summary) => summary.venue === 'UNISWAP_V3' && summary.eligible);
    const candidateHasSecondaryRouteableVenue = candidate.alternativeRoutes.some(
      (summary) => summary.venue !== 'UNISWAP_V3' && summary.eligible
    );
    if (baselineHasUni && !candidateHasSecondaryRouteableVenue) {
      routeableUniOnly += 1;
    } else if (!baselineHasUni && candidateHasSecondaryRouteableVenue) {
      routeableCamelotOnly += 1;
    } else if (baselineHasUni && candidateHasSecondaryRouteableVenue) {
      routeableBoth += 1;
    }

    if (candidate.ok) {
      chosenVenueCounts[candidate.chosenRoute.venue] += 1;
      aggregateBestRouteNetEdgeOut += candidate.chosenRoute.netEdgeOut;
      aggregateBestRouteCount += 1n;
    }

    if (
      baseline.ok
      && candidate.ok
      && candidate.chosenRoute.venue === 'CAMELOT_AMMV3'
      && candidate.chosenRoute.netEdgeOut > baseline.chosenRoute.netEdgeOut
    ) {
      camelotStrictImprovementCount += 1;
    }
  }

  return {
    ordersConsidered,
    routeableUniOnly,
    routeableCamelotOnly,
    routeableBoth,
    chosenVenueCounts,
    averageBestRouteNetEdgeOut:
      aggregateBestRouteCount === 0n ? 0n : aggregateBestRouteNetEdgeOut / aggregateBestRouteCount,
    camelotStrictImprovementCount
  };
}
