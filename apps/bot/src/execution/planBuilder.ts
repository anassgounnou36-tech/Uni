import type { ResolveEnv } from '@uni/protocol';
import { encodeFunctionData, type Address } from 'viem';
import { resolveAt } from '@uni/protocol';
import { RouteEvalReadCache } from '../routing/rpc/readCache.js';
import { EXECUTOR_ABI } from './abi.js';
import { encodeRoutePlanCallbackData } from './callbackData.js';
import type { BuildExecutionPlanResult, ExecutionPlan } from './types.js';
import type { RouteBook } from '../routing/routeBook.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { NormalizedOrder } from '../store/types.js';
import { hasSameOutputTokenShape } from '../routing/univ3QuoteModel.js';

const ARBITRUM_ONE_CHAIN_ID = 42161n;

export type BuildExecutionPlanParams = {
  normalizedOrder: NormalizedOrder;
  routeBook: RouteBook;
  executor: Address;
  blockNumberish: bigint;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  conditionalEnvelope: ConditionalEnvelope;
};

function totalRequiredOutput(outputs: ReadonlyArray<{ amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

export async function buildExecutionPlan(params: BuildExecutionPlanParams): Promise<BuildExecutionPlanResult> {
  const signedOrder = params.normalizedOrder.decodedOrder;
  const resolvedOrder = await resolveAt(
    signedOrder.order,
    {
      ...params.resolveEnv,
      blockNumberish: params.blockNumberish
    },
    signedOrder.signature
  );

  if (!hasSameOutputTokenShape(resolvedOrder)) {
    return { ok: false, reason: 'UNSUPPORTED_SHAPE', details: 'resolved output shape is not same-token' };
  }

  const routeDecision = await params.routeBook.selectBestRoute({
    resolvedOrder,
    routeEval: {
      chainId: params.resolveEnv.chainId ?? ARBITRUM_ONE_CHAIN_ID,
      blockNumberish: params.blockNumberish,
      readCache: new RouteEvalReadCache()
    }
  });
  if (!routeDecision.ok) {
    return {
      ok: false,
      reason:
        routeDecision.reason === 'GAS_NOT_PRICEABLE'
          ? 'NOT_PRICEABLE_GAS'
          : routeDecision.reason === 'NOT_PROFITABLE'
            ? 'NOT_PROFITABLE'
            : 'NOT_ROUTEABLE'
    };
  }
  if (routeDecision.chosenRoute.pathKind === 'DIRECT' && routeDecision.chosenRoute.hopCount !== 1) {
    return { ok: false, reason: 'UNSUPPORTED_SHAPE', details: 'direct route must have hopCount=1' };
  }
  if (routeDecision.chosenRoute.pathKind === 'TWO_HOP' && routeDecision.chosenRoute.hopCount !== 2) {
    return { ok: false, reason: 'UNSUPPORTED_SHAPE', details: 'two-hop route must have hopCount=2' };
  }

  const callbackData = encodeRoutePlanCallbackData(routeDecision.chosenRoute);
  const executeCalldata = encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: 'execute',
    args: [
      {
        order: params.normalizedOrder.encodedOrder,
        sig: params.normalizedOrder.signature
      },
      callbackData
    ]
  });

  const plan: ExecutionPlan = {
    orderHash: params.normalizedOrder.orderHash,
    reactor: params.normalizedOrder.reactor,
    executor: params.executor,
    signedOrder: {
      order: params.normalizedOrder.encodedOrder,
      sig: params.normalizedOrder.signature
    },
    normalizedOrder: params.normalizedOrder,
    resolvedOrder,
    route: routeDecision.chosenRoute,
    routeAlternatives: routeDecision.alternativeRoutes,
    callbackData,
    executeCalldata,
    txRequestDraft: {
      chainId: params.resolveEnv.chainId ?? ARBITRUM_ONE_CHAIN_ID,
      to: params.executor,
      data: executeCalldata,
      value: 0n
    },
    conditionalEnvelope: params.conditionalEnvelope,
    requiredOutputOut: totalRequiredOutput(resolvedOrder.outputs),
    predictedNetEdgeOut: routeDecision.chosenRoute.netEdgeOut,
    selectedExecutionMode: routeDecision.chosenRoute.executionMode ?? 'EXACT_INPUT',
    selectedPathKind: routeDecision.chosenRoute.pathKind,
    selectedHopCount: routeDecision.chosenRoute.hopCount,
    selectedPathDirection: routeDecision.chosenRoute.pathDirection ?? 'FORWARD',
    selectedBlock: params.blockNumberish,
    resolveEnv: params.resolveEnv
  };

  return { ok: true, plan };
}
