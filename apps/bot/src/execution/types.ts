import type { Hex } from 'viem';
import type { ResolveEnv, ResolvedV3DutchOrder } from '@uni/protocol';
import type { NormalizedOrder } from '../store/types.js';
import type { HedgeRoutePlan, RouteCandidateSummary } from '../routing/venues.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { HedgeExecutionMode } from '../routing/executionModeTypes.js';
import type { PathEncodingDirection } from '../routing/pathTypes.js';

export type ExecutionPlan = {
  orderHash: `0x${string}`;
  reactor: `0x${string}`;
  executor: `0x${string}`;
  signedOrder: {
    order: Hex;
    sig: Hex;
  };
  normalizedOrder: NormalizedOrder;
  resolvedOrder: ResolvedV3DutchOrder;
  route: HedgeRoutePlan;
  routeAlternatives: RouteCandidateSummary[];
  callbackData: Hex;
  executeCalldata: Hex;
  txRequestDraft: {
    chainId: bigint;
    to: `0x${string}`;
    data: Hex;
    value: bigint;
  };
  conditionalEnvelope: ConditionalEnvelope;
  requiredOutputOut: bigint;
  predictedNetEdgeOut: bigint;
  selectedExecutionMode: HedgeExecutionMode;
  selectedPathKind: HedgeRoutePlan['pathKind'];
  selectedHopCount: HedgeRoutePlan['hopCount'];
  selectedBridgeToken?: HedgeRoutePlan['bridgeToken'];
  selectedPathDescriptor?: string;
  selectedLfjPath?: HedgeRoutePlan['lfjPath'];
  selectedPathDirection: PathEncodingDirection;
  selectedBlock: bigint;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  resolvedAtBlockNumber: bigint;
  resolvedAtTimestampSec: bigint;
  scheduledAtMs: number;
  candidateBlockNumberish?: bigint;
  planFingerprint: string;
};

export type BuildExecutionPlanResult =
  | { ok: true; plan: ExecutionPlan }
  | { ok: false; reason: 'NOT_ROUTEABLE' | 'NOT_PRICEABLE_GAS' | 'UNSUPPORTED_SHAPE' | 'NOT_PROFITABLE'; details?: string };
