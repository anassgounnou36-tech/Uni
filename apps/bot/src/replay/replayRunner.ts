import type { ResolveEnv, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import { findFirstProfitableBlock } from '../scheduler/firstProfitableBlock.js';
import { runHotLaneStep } from '../scheduler/hotLane.js';
import type { Univ3QuoteModel } from '../routing/univ3QuoteModel.js';
import { hasSameOutputTokenShape } from '../routing/univ3QuoteModel.js';
import type { ForkSimService } from '../sim/forkSimService.js';
import type { NormalizedOrder, OrderReasonCode, OrderStore } from '../store/types.js';

export type ReplaySupportPolicy = {
  allowlistedPairs: ReadonlyArray<{ inputToken: `0x${string}`; outputToken: `0x${string}` }>;
  threshold: bigint;
  candidateBlocks: readonly bigint[];
  competeWindowBlocks: bigint;
};

export type ReplayRecord = {
  orderHash: `0x${string}`;
  scheduledBlock?: bigint;
  decision: 'NO_SEND' | 'WOULD_SEND';
  reason: OrderReasonCode;
  predictedEdge: bigint;
  simResult: 'SIM_OK' | 'SIM_FAIL' | 'NOT_RUN';
};

export type ReplayRunnerParams = {
  corpus: readonly NormalizedOrder[];
  store: OrderStore;
  supportPolicy: ReplaySupportPolicy;
  quoteModel: Univ3QuoteModel;
  simService: ForkSimService;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  shadowMode: boolean;
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

function classifySupport(order: V3DutchOrder, quoteModel: Univ3QuoteModel, policy: ReplaySupportPolicy): OrderReasonCode {
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
  if (!quoteModel.isRouteable(order.baseInput.token, firstOutput.token)) {
    return 'NOT_ROUTEABLE';
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

    const support = classifySupport(order, params.quoteModel, params.supportPolicy);
    if (support !== 'SUPPORTED') {
      params.store.transition(normalized.orderHash, 'UNSUPPORTED', support);
      records.push({
        orderHash: normalized.orderHash,
        decision: 'NO_SEND',
        reason: support,
        predictedEdge: 0n,
        simResult: 'NOT_RUN'
      });
      continue;
    }

    params.store.transition(normalized.orderHash, 'SUPPORTED', 'SUPPORTED');

    const schedule = await findFirstProfitableBlock({
      order,
      baseEnv: params.resolveEnv,
      quoteModel: params.quoteModel,
      candidateBlocks: params.supportPolicy.candidateBlocks,
      threshold: params.supportPolicy.threshold,
      competeWindowBlocks: params.supportPolicy.competeWindowBlocks
    });

    if (!schedule) {
      params.store.transition(normalized.orderHash, 'SIM_FAIL', 'SCHEDULER_NO_EDGE');
      records.push({
        orderHash: normalized.orderHash,
        decision: 'NO_SEND',
        reason: 'SCHEDULER_NO_EDGE',
        predictedEdge: 0n,
        simResult: 'NOT_RUN'
      });
      continue;
    }

    params.store.transition(normalized.orderHash, 'SCHEDULED');
    const finalResolved = await resolveAt(order, {
      ...params.resolveEnv,
      blockNumberish: schedule.scheduledBlock
    });
    if (!hasSameOutputTokenShape(finalResolved)) {
      params.store.transition(normalized.orderHash, 'UNSUPPORTED', 'EXOTIC_OUTPUT_SHAPE');
      records.push({
        orderHash: normalized.orderHash,
        scheduledBlock: schedule.scheduledBlock,
        decision: 'NO_SEND',
        reason: 'EXOTIC_OUTPUT_SHAPE',
        predictedEdge: 0n,
        simResult: 'NOT_RUN'
      });
      continue;
    }

    const predictedEdge = schedule.evaluations.at(-1)?.netEdge ?? 0n;
    const hotDecision = await runHotLaneStep({
      entry: {
        orderHash: normalized.orderHash,
        scheduledBlock: schedule.scheduledBlock,
        competeWindowEnd: schedule.competeWindowEnd,
        predictedEdge
      },
      currentBlock: schedule.scheduledBlock,
      latestResolved: finalResolved,
      threshold: params.supportPolicy.threshold,
      quoteRefresher: (resolved) => params.quoteModel.estimateHedgeOutput(resolved) - resolved.outputs.reduce((sum, o) => sum + o.amount, 0n),
      simService: params.simService,
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
        predictedEdge,
        simResult: 'SIM_OK'
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
        predictedEdge,
        simResult: 'SIM_OK'
      });
      continue;
    }

    const failureReason =
      hotDecision.action === 'DROP' ? hotDecision.simResult?.reason ?? 'NOT_PROFITABLE' : 'NOT_PROFITABLE';
    params.store.transition(normalized.orderHash, 'SIM_FAIL', failureReason);
    records.push({
      orderHash: normalized.orderHash,
      scheduledBlock: schedule.scheduledBlock,
      decision: 'NO_SEND',
      reason: failureReason,
      predictedEdge,
      simResult: 'SIM_FAIL'
    });
  }

  return records;
}
