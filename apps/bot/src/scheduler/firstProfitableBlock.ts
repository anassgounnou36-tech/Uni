import type { ResolveEnv, ResolvedV3DutchOrder, V3DutchOrder } from '@uni/protocol';
import { getOrderDecayEndBlock, resolveAt } from '@uni/protocol';
import type { RouteBook } from '../routing/routeBook.js';
import type { HedgeRoutePlan } from '../routing/venues.js';
import type { VenueRouteAttemptSummary } from '../routing/attemptTypes.js';
import type { ResolveEnvProvider } from '../runtime/resolveEnvProvider.js';
import type { HedgeExecutionMode } from '../routing/executionModeTypes.js';
import { RouteEvalReadCache } from '../routing/rpc/readCache.js';

export type BlockEvaluation = {
  block: bigint;
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  minAmountOut: bigint;
  slippageBufferOut: bigint;
  gasCostOut: bigint;
  riskBufferOut: bigint;
  profitFloorOut: bigint;
  grossEdgeOut: bigint;
  netEdgeOut: bigint;
  chosenRouteVenue?: HedgeRoutePlan['venue'];
  chosenExecutionMode?: HedgeExecutionMode;
  selectionOk: boolean;
  selectionReason?:
    | 'NOT_ROUTEABLE'
    | 'CONSTRAINT_REJECTED'
    | 'NOT_PROFITABLE'
    | 'QUOTE_FAILED'
    | 'QUOTE_REVERTED'
    | 'GAS_NOT_PRICEABLE'
    | 'RATE_LIMITED'
    | 'RPC_UNAVAILABLE'
    | 'RPC_FAILED';
  infraBlocked?: boolean;
  revertedProbeCount?: number;
  revertedProbeBudgetExhausted?: boolean;
  venueAttempts: VenueRouteAttemptSummary[];
  bestRejectedSummary?: VenueRouteAttemptSummary;
};

export type FirstProfitableSchedule = {
  scheduledBlock: bigint;
  competeWindowStart: bigint;
  competeWindowEnd: bigint;
  chosenRoute: HedgeRoutePlan;
  evaluations: BlockEvaluation[];
  /**
   * Candidate blocks are resolved from off-chain reactor semantics, while route quotes
   * are mark-to-market observations of current AMM state at quote time.
   */
  quoteModel: 'MARK_TO_MARKET_AMM';
};

export type FirstProfitableBlockResult =
  | {
      ok: true;
      schedule: FirstProfitableSchedule;
      evaluations: BlockEvaluation[];
    }
  | {
      ok: false;
      reason: 'NO_EDGE' | 'INCONCLUSIVE';
      evaluations: BlockEvaluation[];
      bestObservedEvaluation?: BlockEvaluation;
    };

export type FirstProfitableBlockParams = {
  order: V3DutchOrder;
  resolveEnvProvider?: ResolveEnvProvider;
  baseEnv?: Omit<ResolveEnv, 'blockNumberish'>;
  routeBook: RouteBook;
  candidateBlockOffsets?: readonly bigint[];
  candidateBlocks?: readonly bigint[];
  threshold: bigint;
  competeWindowBlocks: bigint;
  routeEvalCacheMaxEntries?: number;
  routeEvalNegativeCacheMaxEntries?: number;
  maxCandidateBlocksPerOrder?: number;
  onRouteEvalCacheStats?: (stats: { entries: number; negativeEntries: number; snapshots: number }) => void;
};

const DEFAULT_MAX_CANDIDATE_BLOCKS_PER_ORDER = 7;
const DEFAULT_CANDIDATE_BLOCK_OFFSETS = [0n, 1n, 2n] as const;
const ONE_SECOND_PER_BLOCK = 1n;

function toDeadlineBlockCap(nowBlock: bigint, nowTimestamp: bigint, deadlineTimestamp: bigint): bigint {
  if (deadlineTimestamp <= nowTimestamp) {
    return nowBlock;
  }
  return nowBlock + (deadlineTimestamp - nowTimestamp) / ONE_SECOND_PER_BLOCK;
}

function clampBlock(value: bigint, minValue: bigint, maxValue: bigint): bigint {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

type CandidatePlanInput = {
  order: V3DutchOrder;
  currentBlockNumberish: bigint;
  defaultOffsets: readonly bigint[];
  maxBlocks: number;
  fillerAddress?: `0x${string}`;
  deadlineBlockCap?: bigint;
};

export function planCandidateBlocks(input: CandidatePlanInput): bigint[] {
  const raw = new Set<bigint>();
  for (const offset of input.defaultOffsets) {
    raw.add(input.currentBlockNumberish + offset);
  }

  const decayStartPlusOne = input.order.cosignerData.decayStartBlock + 1n;
  const decayEndBlock = getOrderDecayEndBlock(input.order);
  const earliest = input.currentBlockNumberish > decayStartPlusOne ? input.currentBlockNumberish : decayStartPlusOne;
  const latest = input.deadlineBlockCap !== undefined
    ? (input.deadlineBlockCap < decayEndBlock ? input.deadlineBlockCap : decayEndBlock)
    : decayEndBlock;

  raw.add(decayStartPlusOne);
  raw.add(decayEndBlock);
  if (latest >= earliest) {
    const span = latest - earliest;
    raw.add(earliest + span / 2n);
    raw.add(earliest + (span * 2n) / 3n);
  }

  const filtered = [...raw]
    .filter((block) => block >= input.currentBlockNumberish)
    .filter((block) => input.deadlineBlockCap === undefined || block <= input.deadlineBlockCap)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return filtered.slice(0, Math.max(1, input.maxBlocks));
}

function totalOutputAmount(resolved: ResolvedV3DutchOrder): bigint {
  return resolved.outputs.reduce((sum, output) => sum + output.amount, 0n);
}

export async function findFirstProfitableBlock(params: FirstProfitableBlockParams): Promise<FirstProfitableBlockResult> {
  const evaluations: BlockEvaluation[] = [];
  const currentEnv = params.resolveEnvProvider ? await params.resolveEnvProvider.getCurrent() : undefined;
  const baseEnv: Omit<ResolveEnv, 'blockNumberish'> = currentEnv
    ? {
        timestamp: currentEnv.timestamp,
        basefee: currentEnv.baseFeePerGas,
        chainId: currentEnv.chainId
      }
    : (params.baseEnv ?? { timestamp: 0n, basefee: 0n, chainId: 42161n });
  const maxBlocks = params.maxCandidateBlocksPerOrder ?? DEFAULT_MAX_CANDIDATE_BLOCKS_PER_ORDER;
  const nowBlock = currentEnv?.blockNumberish ?? (params.candidateBlocks?.[0] ?? 0n);
  const deadlineBlockCap = toDeadlineBlockCap(nowBlock, baseEnv.timestamp, params.order.info.deadline);
  const initialCandidates = currentEnv
    ? planCandidateBlocks({
      order: params.order,
      currentBlockNumberish: currentEnv.blockNumberish,
      defaultOffsets: params.candidateBlockOffsets ?? DEFAULT_CANDIDATE_BLOCK_OFFSETS,
      maxBlocks,
      deadlineBlockCap
    })
    : [...(params.candidateBlocks ?? [])]
      .filter((block) => block >= nowBlock && block <= deadlineBlockCap)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, maxBlocks);
  const candidateBlocks = [...initialCandidates];
  const evaluatedBlocks = new Set<bigint>();
  const decayEndBlock = getOrderDecayEndBlock(params.order);

  const readCache = new RouteEvalReadCache({
    maxEntries: params.routeEvalCacheMaxEntries,
    maxNegativeEntries: params.routeEvalNegativeCacheMaxEntries
  });
  for (let index = 0; index < candidateBlocks.length; index += 1) {
    const block = candidateBlocks[index]!;
    if (evaluatedBlocks.has(block)) {
      continue;
    }
    evaluatedBlocks.add(block);
    const resolved = await resolveAt(params.order, {
      ...baseEnv,
      blockNumberish: block
    });

    const routeResult = await params.routeBook.selectBestRoute({
      resolvedOrder: resolved,
      routeEval: {
        chainId: baseEnv.chainId ?? 42161n,
        blockNumberish: block,
        readCache
      }
    });
    params.onRouteEvalCacheStats?.({
      entries: readCache.getEntryCount(),
      negativeEntries: readCache.getNegativeEntryCount(),
      snapshots: readCache.getSnapshotCount()
    });
    if (!routeResult.ok) {
      const bestRejectedSummary = routeResult.bestRejectedSummary ? { ...routeResult.bestRejectedSummary } : undefined;
      const bestRejectedQuotedAmountOut = bestRejectedSummary?.quotedAmountOut ?? 0n;
      const bestRejectedMinAmountOut = bestRejectedSummary?.minAmountOut ?? 0n;
      const bestRejectedGasCostOut = bestRejectedSummary?.constraintBreakdown?.gasCostOut ?? 0n;
      const bestRejectedRiskBufferOut = bestRejectedSummary?.constraintBreakdown?.riskBufferOut ?? 0n;
      const bestRejectedProfitFloorOut = bestRejectedSummary?.constraintBreakdown?.profitFloorOut ?? 0n;
      const bestRejectedSlippageBufferOut = bestRejectedSummary?.constraintBreakdown?.slippageBufferOut ?? 0n;
      const bestRejectedGrossEdgeOut =
        bestRejectedSummary?.grossEdgeOut
        ?? (bestRejectedSummary?.quotedAmountOut !== undefined
          ? bestRejectedSummary.quotedAmountOut - totalOutputAmount(resolved)
          : 0n);
      evaluations.push({
        block,
        requiredOutput: totalOutputAmount(resolved),
        quotedAmountOut: bestRejectedQuotedAmountOut,
        minAmountOut: bestRejectedMinAmountOut,
        slippageBufferOut: bestRejectedSlippageBufferOut,
        gasCostOut: bestRejectedGasCostOut,
        riskBufferOut: bestRejectedRiskBufferOut,
        profitFloorOut: bestRejectedProfitFloorOut,
        grossEdgeOut: bestRejectedGrossEdgeOut,
        netEdgeOut: bestRejectedSummary?.netEdgeOut ?? -1n,
        selectionOk: false,
        selectionReason: routeResult.reason,
        infraBlocked: routeResult.infraBlocked ?? false,
        revertedProbeCount: routeResult.revertedProbeCount ?? 0,
        revertedProbeBudgetExhausted: routeResult.revertedProbeBudgetExhausted ?? false,
        venueAttempts: routeResult.venueAttempts,
        bestRejectedSummary
      });
      if (
        candidateBlocks.length < maxBlocks
        && bestRejectedSummary?.constraintReason === 'REQUIRED_OUTPUT'
        && bestRejectedSummary?.exactOutputViability?.status === 'UNSATISFIABLE'
        && bestRejectedSummary?.constraintBreakdown?.nearMiss === true
        && block < decayEndBlock
      ) {
        const shortfallOut =
          bestRejectedSummary?.hedgeGap?.requiredOutputShortfallOut
          ?? bestRejectedSummary?.constraintBreakdown?.requiredOutputShortfallOut
          ?? 0n;
        if (shortfallOut > 0n) {
          const nextResolved = await resolveAt(params.order, {
            ...baseEnv,
            blockNumberish: block + 1n
          });
          const requiredNow = totalOutputAmount(resolved);
          const requiredNext = totalOutputAmount(nextResolved);
          const deltaRequiredOutputPerBlock = requiredNow > requiredNext ? requiredNow - requiredNext : 1n;
          const blocksNeeded = (shortfallOut + deltaRequiredOutputPerBlock - 1n) / deltaRequiredOutputPerBlock;
          const jumpMax = deadlineBlockCap < decayEndBlock ? deadlineBlockCap : decayEndBlock;
          const jumpBlock = clampBlock(block + blocksNeeded, block, jumpMax);
          if (!evaluatedBlocks.has(jumpBlock) && !candidateBlocks.includes(jumpBlock)) {
            candidateBlocks.push(jumpBlock);
            candidateBlocks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            if (candidateBlocks.length > maxBlocks) {
              candidateBlocks.length = maxBlocks;
            }
          }
        }
      }
      continue;
    }

    const route = routeResult.chosenRoute;
    const requiredOutput = route.requiredOutput;
    const quotedAmountOut = route.quotedAmountOut;
    const evaluation: BlockEvaluation = {
      block,
      requiredOutput,
      quotedAmountOut,
      minAmountOut: route.minAmountOut,
      slippageBufferOut: route.slippageBufferOut,
      gasCostOut: route.gasCostOut,
      riskBufferOut: route.riskBufferOut,
      profitFloorOut: route.profitFloorOut,
      grossEdgeOut: route.grossEdgeOut,
      netEdgeOut: route.netEdgeOut,
      chosenRouteVenue: route.venue,
      chosenExecutionMode: route.executionMode,
      selectionOk: true,
      venueAttempts: routeResult.venueAttempts
    };
    evaluations.push(evaluation);

    if (route.netEdgeOut >= params.threshold) {
      return {
        ok: true,
        schedule: {
          scheduledBlock: block,
          competeWindowStart: block,
          competeWindowEnd: block + params.competeWindowBlocks,
          chosenRoute: route,
          evaluations,
          quoteModel: 'MARK_TO_MARKET_AMM'
        },
        evaluations,
      };
    }
  }

  let bestObservedEvaluation: BlockEvaluation | undefined;
  let hasInfraBlocked = false;
  for (const evaluation of evaluations) {
    if (evaluation.infraBlocked === true) {
      hasInfraBlocked = true;
    }
    if (!bestObservedEvaluation || evaluation.netEdgeOut > bestObservedEvaluation.netEdgeOut) {
      bestObservedEvaluation = evaluation;
      continue;
    }
    if (evaluation.netEdgeOut === bestObservedEvaluation.netEdgeOut) {
      const currentHasBestRejected = bestObservedEvaluation.bestRejectedSummary !== undefined;
      const candidateHasBestRejected = evaluation.bestRejectedSummary !== undefined;
      if (!currentHasBestRejected && candidateHasBestRejected) {
        bestObservedEvaluation = evaluation;
      }
    }
  }

  return {
    ok: false,
    reason: hasInfraBlocked ? 'INCONCLUSIVE' : 'NO_EDGE',
    evaluations,
    bestObservedEvaluation
  };
}
