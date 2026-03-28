import type { Address, PublicClient } from 'viem';
import type { RoutePlanningPolicy } from '../univ3/types.js';
import type { HedgeRoutePlan } from '../venues.js';
import type { VenueRouteAttemptSummary } from '../attemptTypes.js';
import type { RouteEvalReadCache } from '../rpc/readCache.js';
import type { RouteEvalRpcGate } from '../rpc/rpcGate.js';

export type LfjLbPathVersion = 0 | 1 | 2;

export type LfjLbPathShape = {
  kind: 'DIRECT' | 'TWO_HOP';
  hopCount: 1 | 2;
  bridgeToken?: Address;
  binSteps: number[];
  versions: LfjLbPathVersion[];
};

export type LfjLbRoutingContext = {
  client: PublicClient;
  enabled: boolean;
  factory: Address;
  quoter: Address;
  router: Address;
  bridgeTokens?: readonly Address[];
  enableTwoHop?: boolean;
  maxTwoHopFamiliesPerOrder?: number;
  routeEvalChainId?: bigint;
  routeEvalRpcGate?: RouteEvalRpcGate;
  onRouteEvalCacheAccess?: (hit: boolean, venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP') => void;
  onRouteEvalNegativeCacheAccess?: (hit: boolean, venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP') => void;
  onRouteEvalFamilyEvaluated?: (venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP', familyKind: 'DIRECT' | 'TWO_HOP') => void;
  onRouteEvalFamilyPruned?: (venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP') => void;
  onRouteEvalFamilyPromoted?: (venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP', executionMode: 'EXACT_INPUT' | 'EXACT_OUTPUT') => void;
  onRouteEvalFamilyDominant?: (venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP') => void;
  onRouteEvalFamilyDemoted?: (venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP') => void;
  onRouteEvalFamilyBestRejected?: (venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP') => void;
  onRouteEvalFamilyChosen?: (venue: 'LFJ_LB', pathKind: 'DIRECT' | 'TWO_HOP', executionMode: 'EXACT_INPUT' | 'EXACT_OUTPUT') => void;
  onRouteEvalInfraError?: (
    category: 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED',
    venue: 'LFJ_LB',
    pathKind: 'DIRECT' | 'TWO_HOP'
  ) => void;
};

export type LfjLbRoutePlan = HedgeRoutePlan & {
  venue: 'LFJ_LB';
  quoteMetadata: {
    venue: 'LFJ_LB';
    observedFee?: number;
  };
};

export type LfjLbRoutePlanningResult =
  | {
      ok: true;
      route: LfjLbRoutePlan;
      summary: VenueRouteAttemptSummary;
    }
  | {
      ok: false;
      failure: {
        reason:
          | 'NOT_ROUTEABLE'
          | 'QUOTE_FAILED'
          | 'NOT_PROFITABLE'
          | 'GAS_NOT_PRICEABLE'
          | 'CONSTRAINT_REJECTED'
          | 'RATE_LIMITED'
          | 'RPC_UNAVAILABLE'
          | 'RPC_FAILED'
          | 'QUOTE_REVERTED';
        details?: string;
        summary: VenueRouteAttemptSummary;
      };
    };

export type LfjLbRoutePlannerInput = {
  resolvedOrder: {
    input: { token: Address; amount: bigint };
    outputs: ReadonlyArray<{ token: Address; amount: bigint }>;
  };
  policy?: RoutePlanningPolicy;
  routeEval?: {
    chainId?: bigint;
    blockNumberish?: bigint;
    readCache?: RouteEvalReadCache;
  };
};
