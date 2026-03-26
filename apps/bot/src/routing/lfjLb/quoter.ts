import type { Address } from 'viem';
import { LFJ_LB_FACTORY_ABI, LFJ_LB_QUOTER_ABI } from './abi.js';
import { classifyQuoteFailure } from '../univ3/quoter.js';
import { normalizeRouteEvalRpcError } from '../rpc/errors.js';
import { buildConstraintBreakdown } from '../constraintTypes.js';
import type { ExactOutputViability } from '../exactOutputTypes.js';
import { buildHedgeGapSummary } from '../hedgeGapTypes.js';
import { deriveRejectedCandidateClass } from '../rejectedCandidateTypes.js';
import type { RoutePlanningPolicy } from '../univ3/types.js';
import type { LfjLbPathShape, LfjLbRoutePlan, LfjLbRoutingContext } from './types.js';
import type { VenueRouteAttemptSummary } from '../attemptTypes.js';
import type { RouteEvalReadCache } from '../rpc/readCache.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_NEAR_MISS_BPS = 25n;

type RouteEvalContext = {
  chainId?: bigint;
  blockNumberish?: bigint;
  readCache?: RouteEvalReadCache;
};

function applyBpsFloor(amount: bigint, bpsToKeep: bigint): bigint {
  return (amount * bpsToKeep) / 10_000n;
}

function sumRequiredOutput(outputs: ReadonlyArray<{ token: Address; amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function toUint8Version(version: number): number {
  return Math.max(0, Math.min(255, version));
}

function asLfjPath(shape: LfjLbPathShape, tokenIn: Address, tokenOut: Address) {
  const tokenPath = shape.hopCount === 2 && shape.bridgeToken
    ? [tokenIn, shape.bridgeToken, tokenOut]
    : [tokenIn, tokenOut];
  return {
    tokenPath,
    binSteps: shape.binSteps,
    versions: shape.versions
  };
}

function lfjPathDescriptor(shape: LfjLbPathShape, tokenIn: Address, tokenOut: Address): string {
  if (shape.kind === 'TWO_HOP' && shape.bridgeToken) {
    return `TWO_HOP: ${tokenIn} -> ${shape.bridgeToken} -> ${tokenOut}`;
  }
  return `DIRECT: ${tokenIn} -> ${tokenOut}`;
}

export class LfjLbQuoter {
  constructor(private readonly context: LfjLbRoutingContext) {}

  private async runRouteEvalRpc<T>(task: () => Promise<T>): Promise<T> {
    if (this.context.routeEvalRpcGate) {
      return this.context.routeEvalRpcGate.run(task);
    }
    return task();
  }

  private async readWithCache<T>(params: {
    routeEval?: RouteEvalContext;
    pathKind: 'DIRECT' | 'TWO_HOP';
    target: Address;
    fn: string;
    args: readonly unknown[];
    extraKey?: string;
    loader: () => Promise<T>;
    shouldMemoizeNegative?: (error: unknown) => boolean;
  }): Promise<T> {
    const run = () => this.runRouteEvalRpc(params.loader);
    const cache = params.routeEval?.readCache;
    if (!cache) {
      return run();
    }
    const cached = await cache.getOrSetNegative<T>(
      {
        chainId: params.routeEval?.chainId ?? this.context.routeEvalChainId ?? 42161n,
        blockNumberish: params.routeEval?.blockNumberish ?? 0n,
        target: params.target,
        fn: params.fn,
        args: params.args,
        extraKey: params.extraKey
      },
      run,
      params.shouldMemoizeNegative ?? (() => false),
      (hit) => this.context.onRouteEvalCacheAccess?.(hit, 'LFJ_LB', params.pathKind),
      (hit) => this.context.onRouteEvalNegativeCacheAccess?.(hit, 'LFJ_LB', params.pathKind)
    );
    return cached.value;
  }

  async quotePath(params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    outputs: ReadonlyArray<{ token: Address; amount: bigint }>;
    policy?: RoutePlanningPolicy;
    shape: LfjLbPathShape;
    routeEval?: RouteEvalContext;
  }): Promise<
    | { ok: true; route: LfjLbRoutePlan; summary: VenueRouteAttemptSummary }
    | {
        ok: false;
        reason: 'NOT_ROUTEABLE' | 'QUOTE_FAILED' | 'NOT_PROFITABLE' | 'CONSTRAINT_REJECTED' | 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED';
        details?: string;
        summary: VenueRouteAttemptSummary;
      }
  > {
    if (!this.context.enabled) {
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
        summary: {
          venue: 'LFJ_LB',
          pathKind: params.shape.kind,
          hopCount: params.shape.hopCount,
          bridgeToken: params.shape.bridgeToken,
          lfjPath: asLfjPath(params.shape, params.tokenIn, params.tokenOut),
          pathDescriptor: lfjPathDescriptor(params.shape, params.tokenIn, params.tokenOut),
          status: 'NOT_ROUTEABLE',
          reason: 'LFJ_DISABLED',
          candidateClass: 'ROUTE_MISSING'
        }
      };
    }

    const pathDescriptor = lfjPathDescriptor(params.shape, params.tokenIn, params.tokenOut);
    const lfjPath = asLfjPath(params.shape, params.tokenIn, params.tokenOut);
    const pairCheck = await this.readWithCache({
      routeEval: params.routeEval,
      pathKind: params.shape.kind,
      target: this.context.factory,
      fn: 'getLBPairInformation',
      args: [params.tokenIn, params.tokenOut, BigInt(params.shape.binSteps[0] ?? 20)],
      extraKey: `pair:${params.tokenIn}-${params.tokenOut}-${params.shape.binSteps.join(',')}`,
      loader: () =>
        this.context.client.readContract({
          address: this.context.factory,
          abi: LFJ_LB_FACTORY_ABI,
          functionName: 'getLBPairInformation',
          args: [params.tokenIn, params.tokenOut, BigInt(params.shape.binSteps[0] ?? 20)]
        }) as Promise<[Address, bigint, number, boolean]>
    }).catch((error: unknown) => {
      const normalized = normalizeRouteEvalRpcError(error);
      if (normalized.category === 'RATE_LIMITED' || normalized.category === 'RPC_UNAVAILABLE' || normalized.category === 'QUOTE_REVERTED') {
        this.context.onRouteEvalInfraError?.(normalized.category, 'LFJ_LB', params.shape.kind);
      } else {
        this.context.onRouteEvalInfraError?.('RPC_FAILED', 'LFJ_LB', params.shape.kind);
      }
      throw error;
    });
    if (params.shape.hopCount === 2 && params.shape.bridgeToken) {
      const bridgePair = await this.readWithCache({
        routeEval: params.routeEval,
        pathKind: params.shape.kind,
        target: this.context.factory,
        fn: 'getLBPairInformation',
        args: [params.shape.bridgeToken, params.tokenOut, BigInt(params.shape.binSteps[1] ?? params.shape.binSteps[0] ?? 20)],
        extraKey: `pair:${params.shape.bridgeToken}-${params.tokenOut}-${params.shape.binSteps.join(',')}`,
        loader: () =>
          this.context.client.readContract({
            address: this.context.factory,
            abi: LFJ_LB_FACTORY_ABI,
            functionName: 'getLBPairInformation',
            args: [params.shape.bridgeToken as Address, params.tokenOut, BigInt(params.shape.binSteps[1] ?? params.shape.binSteps[0] ?? 20)]
          }) as Promise<[Address, bigint, number, boolean]>
      }).catch((error: unknown) => {
        const normalized = normalizeRouteEvalRpcError(error);
        this.context.onRouteEvalInfraError?.(
          normalized.category === 'RATE_LIMITED' || normalized.category === 'RPC_UNAVAILABLE' || normalized.category === 'QUOTE_REVERTED'
            ? normalized.category
            : 'RPC_FAILED',
          'LFJ_LB',
          params.shape.kind
        );
        throw error;
      });
      if (!bridgePair || bridgePair[0].toLowerCase() === ZERO_ADDRESS) {
        return {
          ok: false,
          reason: 'NOT_ROUTEABLE',
          summary: {
            venue: 'LFJ_LB',
            pathKind: params.shape.kind,
            hopCount: params.shape.hopCount,
            bridgeToken: params.shape.bridgeToken,
            lfjPath,
            pathDescriptor,
            status: 'NOT_ROUTEABLE',
            reason: 'POOL_MISSING',
            candidateClass: 'ROUTE_MISSING'
          }
        };
      }
    }
    if (!pairCheck || pairCheck[0].toLowerCase() === ZERO_ADDRESS) {
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
        summary: {
          venue: 'LFJ_LB',
          pathKind: params.shape.kind,
          hopCount: params.shape.hopCount,
          bridgeToken: params.shape.bridgeToken,
          lfjPath,
          pathDescriptor,
          status: 'NOT_ROUTEABLE',
          reason: 'POOL_MISSING',
          candidateClass: 'ROUTE_MISSING'
        }
      };
    }

    const routeStruct = {
      pairBinSteps: params.shape.binSteps.map((step) => BigInt(step)),
      versions: params.shape.versions.map((version) => toUint8Version(version)),
      tokenPath: lfjPath.tokenPath
    };
    let quotedAmountOut: bigint;
    try {
      const quoteIn = await this.readWithCache({
        routeEval: params.routeEval,
        pathKind: params.shape.kind,
        target: this.context.quoter,
        fn: 'findBestPathFromAmountIn',
        args: [routeStruct, params.amountIn],
        extraKey: `quoteIn:${lfjPath.tokenPath.join('-')}:${params.amountIn.toString()}`,
        shouldMemoizeNegative: (error) => {
          const failure = classifyQuoteFailure(error);
          return failure === 'QUOTE_REVERTED' || failure === 'INSUFFICIENT_INPUT' || failure === 'REVERTED';
        },
        loader: () =>
          this.context.client.readContract({
            address: this.context.quoter,
            abi: LFJ_LB_QUOTER_ABI,
            functionName: 'findBestPathFromAmountIn',
            args: [routeStruct, BigInt(params.amountIn)]
          }) as Promise<[bigint, unknown, unknown, bigint[], bigint[]]>
      });
      quotedAmountOut = quoteIn[0];
    } catch (error) {
      const failure = classifyQuoteFailure(error);
      const normalized = normalizeRouteEvalRpcError(error);
      if (failure === 'RATE_LIMITED' || failure === 'RPC_UNAVAILABLE' || failure === 'RPC_FAILED' || failure === 'QUOTE_REVERTED') {
        this.context.onRouteEvalInfraError?.(
          failure === 'RPC_FAILED' ? 'RPC_FAILED' : failure,
          'LFJ_LB',
          params.shape.kind
        );
      }
      return {
        ok: false,
        reason:
          failure === 'RATE_LIMITED'
          || failure === 'RPC_UNAVAILABLE'
          || failure === 'RPC_FAILED'
          || failure === 'QUOTE_REVERTED'
            ? failure
            : 'QUOTE_FAILED',
        details: normalized.message,
        summary: {
          venue: 'LFJ_LB',
          pathKind: params.shape.kind,
          hopCount: params.shape.hopCount,
          bridgeToken: params.shape.bridgeToken,
          lfjPath,
          pathDescriptor,
          status:
            failure === 'RATE_LIMITED'
            || failure === 'RPC_UNAVAILABLE'
            || failure === 'RPC_FAILED'
            || failure === 'QUOTE_REVERTED'
              ? failure
              : 'QUOTE_FAILED',
          reason: failure,
          errorCategory: normalized.category,
          errorMessage: normalized.message.slice(0, 220),
          candidateClass:
            failure === 'RATE_LIMITED'
            || failure === 'RPC_UNAVAILABLE'
            || failure === 'RPC_FAILED'
            || failure === 'QUOTE_REVERTED'
              ? 'INFRA_BLOCKED'
              : 'QUOTE_FAILED'
        }
      };
    }

    const requiredOutput = sumRequiredOutput(params.outputs);
    let exactOutputViability: ExactOutputViability;
    try {
      const quoteOut = await this.readWithCache({
        routeEval: params.routeEval,
        pathKind: params.shape.kind,
        target: this.context.quoter,
        fn: 'findBestPathFromAmountOut',
        args: [routeStruct, requiredOutput],
        extraKey: `quoteOut:${lfjPath.tokenPath.join('-')}:${requiredOutput.toString()}`,
        shouldMemoizeNegative: (error) => {
          const failure = classifyQuoteFailure(error);
          return failure === 'QUOTE_REVERTED' || failure === 'INSUFFICIENT_INPUT' || failure === 'REVERTED';
        },
        loader: () =>
          this.context.client.readContract({
            address: this.context.quoter,
            abi: LFJ_LB_QUOTER_ABI,
            functionName: 'findBestPathFromAmountOut',
            args: [routeStruct, requiredOutput]
          }) as Promise<[bigint, unknown, unknown, bigint[], bigint[]]>
      });
      const requiredInputForTargetOutput = quoteOut[0];
      const inputDeficit = requiredInputForTargetOutput > params.amountIn ? requiredInputForTargetOutput - params.amountIn : 0n;
      const inputSlack = params.amountIn > requiredInputForTargetOutput ? params.amountIn - requiredInputForTargetOutput : 0n;
      exactOutputViability = {
        status: requiredInputForTargetOutput <= params.amountIn ? 'SATISFIABLE' : 'UNSATISFIABLE',
        targetOutput: requiredOutput,
        requiredInputForTargetOutput,
        availableInput: params.amountIn,
        inputDeficit,
        inputSlack,
        pathKind: params.shape.kind,
        hopCount: params.shape.hopCount,
        bridgeToken: params.shape.bridgeToken,
        pathDescriptor,
        reason:
          requiredInputForTargetOutput <= params.amountIn
            ? 'required output satisfiable with available input'
            : 'required output unsatisfiable with available input'
      };
    } catch (error) {
      exactOutputViability = {
        status: 'QUOTE_FAILED',
        targetOutput: requiredOutput,
        requiredInputForTargetOutput: 0n,
        availableInput: params.amountIn,
        inputDeficit: 0n,
        inputSlack: params.amountIn > 0n ? params.amountIn : 0n,
        pathKind: params.shape.kind,
        hopCount: params.shape.hopCount,
        bridgeToken: params.shape.bridgeToken,
        pathDescriptor,
        reason: `exact-output quote failed: ${classifyQuoteFailure(error)}`
      };
    }

    const policy = {
      slippageBufferBps: params.policy?.slippageBufferBps ?? 50n,
      riskBufferBps: params.policy?.riskBufferBps ?? 10n,
      riskBufferOut: params.policy?.riskBufferOut ?? 0n,
      profitFloorOut: params.policy?.profitFloorOut ?? 0n,
      nearMissBps: params.policy?.nearMissBps ?? DEFAULT_NEAR_MISS_BPS
    };

    const slippageBufferOut = quotedAmountOut - applyBpsFloor(quotedAmountOut, 10_000n - policy.slippageBufferBps);
    const gasCostOut = 0n;
    const riskBufferOut = policy.riskBufferOut + (quotedAmountOut * policy.riskBufferBps) / 10_000n;
    const profitFloorOut = policy.profitFloorOut;
    const breakdown = buildConstraintBreakdown({
      requiredOutput,
      quotedAmountOut,
      slippageBufferOut,
      gasCostOut,
      riskBufferOut,
      profitFloorOut,
      nearMissBps: policy.nearMissBps
    });
    const grossEdgeOut = quotedAmountOut - breakdown.requiredOutput;
    const minAmountOut = breakdown.minAmountOut;
    const netEdgeOut = quotedAmountOut - breakdown.requiredOutput - breakdown.slippageBufferOut - gasCostOut - riskBufferOut - profitFloorOut;

    if (exactOutputViability.status === 'SATISFIABLE' && exactOutputViability.requiredInputForTargetOutput <= params.amountIn) {
      const targetOutput = requiredOutput;
      const maxAmountIn = params.amountIn;
      const leftoverInput = maxAmountIn - exactOutputViability.requiredInputForTargetOutput;
      const grossEdgeOutExactOutput = leftoverInput;
      const riskBufferOutExactOutput = policy.riskBufferOut + (grossEdgeOutExactOutput * policy.riskBufferBps) / 10_000n;
      const netEdgeOutExactOutput = grossEdgeOutExactOutput - gasCostOut - riskBufferOutExactOutput - profitFloorOut;
      const directNearMissRequiredOutput = breakdown.nearMiss && quotedAmountOut < breakdown.requiredOutput;
      if (netEdgeOutExactOutput > 0n && (netEdgeOutExactOutput > netEdgeOut || directNearMissRequiredOutput)) {
        const route: LfjLbRoutePlan = {
          venue: 'LFJ_LB',
          executionMode: 'EXACT_OUTPUT',
          pathKind: params.shape.kind,
          hopCount: params.shape.hopCount,
          pathDirection: 'FORWARD',
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          bridgeToken: params.shape.bridgeToken,
          lfjPath,
          amountIn: maxAmountIn,
          requiredOutput: targetOutput,
          targetOutput,
          maxAmountIn,
          quotedAmountOut: targetOutput + grossEdgeOutExactOutput,
          minAmountOut: targetOutput,
          limitSqrtPriceX96: 0n,
          grossEdgeOut: grossEdgeOutExactOutput,
          slippageBufferOut: 0n,
          gasCostOut,
          riskBufferOut: riskBufferOutExactOutput,
          profitFloorOut,
          netEdgeOut: netEdgeOutExactOutput,
          quoteMetadata: { venue: 'LFJ_LB' }
        };
        return {
          ok: true,
          route,
          summary: {
            venue: 'LFJ_LB',
            executionMode: 'EXACT_OUTPUT',
            pathKind: params.shape.kind,
            hopCount: params.shape.hopCount,
            bridgeToken: params.shape.bridgeToken,
            lfjPath,
            pathDescriptor,
            status: 'ROUTEABLE',
            reason: 'ROUTEABLE',
            quotedAmountOut: route.quotedAmountOut,
            minAmountOut: route.minAmountOut,
            grossEdgeOut: route.grossEdgeOut,
            netEdgeOut: route.netEdgeOut,
            exactOutputViability,
            hedgeGap: buildHedgeGapSummary({
              pathKind: params.shape.kind,
              hopCount: params.shape.hopCount,
              bridgeToken: params.shape.bridgeToken,
              pathDescriptor,
              requiredOutput: targetOutput,
              quotedAmountOut: route.quotedAmountOut,
              minAmountOut: targetOutput,
              exactOutputViability,
              nearMiss: false,
              nearMissBps: policy.nearMissBps
            })
          }
        };
      }
    }

    let status: VenueRouteAttemptSummary['status'] = 'ROUTEABLE';
    let reason = 'ROUTEABLE';
    let constraintReason: VenueRouteAttemptSummary['constraintReason'];
    if (quotedAmountOut < breakdown.requiredOutput) {
      status = 'CONSTRAINT_REJECTED';
      reason = 'REQUIRED_OUTPUT';
      constraintReason = 'REQUIRED_OUTPUT';
    } else if (quotedAmountOut < minAmountOut) {
      status = 'CONSTRAINT_REJECTED';
      reason = breakdown.bindingFloor;
      constraintReason = breakdown.bindingFloor;
    } else if (netEdgeOut <= 0n) {
      status = 'NOT_PROFITABLE';
      reason = 'NET_EDGE_NON_POSITIVE';
    }

    const summary: VenueRouteAttemptSummary = {
      venue: 'LFJ_LB',
      executionMode: 'EXACT_INPUT',
      pathKind: params.shape.kind,
      hopCount: params.shape.hopCount,
      bridgeToken: params.shape.bridgeToken,
      lfjPath,
      pathDescriptor,
      status,
      reason,
      quotedAmountOut,
      minAmountOut,
      grossEdgeOut,
      netEdgeOut,
      constraintReason,
      constraintBreakdown: constraintReason ? breakdown : undefined,
      exactOutputViability,
      hedgeGap: buildHedgeGapSummary({
        pathKind: params.shape.kind,
        hopCount: params.shape.hopCount,
        bridgeToken: params.shape.bridgeToken,
        pathDescriptor,
        requiredOutput,
        quotedAmountOut,
        minAmountOut,
        exactOutputViability,
        nearMiss: breakdown.nearMiss,
        nearMissBps: breakdown.nearMissBps
      }),
      candidateClass:
        status === 'ROUTEABLE'
          ? undefined
          : deriveRejectedCandidateClass({
              venue: 'LFJ_LB',
              status,
              reason,
              constraintReason,
              constraintBreakdown: constraintReason ? breakdown : undefined,
              exactOutputViability,
              quotedAmountOut
            } as VenueRouteAttemptSummary)
    };
    if (status !== 'ROUTEABLE') {
      return {
        ok: false,
        reason: status === 'CONSTRAINT_REJECTED' ? 'CONSTRAINT_REJECTED' : 'NOT_PROFITABLE',
        summary
      };
    }
    return {
      ok: true,
      route: {
        venue: 'LFJ_LB',
        executionMode: 'EXACT_INPUT',
        pathKind: params.shape.kind,
        hopCount: params.shape.hopCount,
        pathDirection: 'FORWARD',
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        bridgeToken: params.shape.bridgeToken,
        lfjPath,
        amountIn: params.amountIn,
        requiredOutput,
        quotedAmountOut,
        minAmountOut,
        limitSqrtPriceX96: 0n,
        grossEdgeOut,
        slippageBufferOut,
        gasCostOut,
        riskBufferOut,
        profitFloorOut,
        netEdgeOut,
        quoteMetadata: { venue: 'LFJ_LB' }
      },
      summary
    };
  }
}
