import type { RuntimeConfig } from './config.js';

export type ExecutionModeDecision =
  | { mode: 'SHADOW'; reason: 'SHADOW_MODE_ENABLED' }
  | { mode: 'LIVE'; reason: 'CANARY_ALLOWED' | 'LIVE_MODE' }
  | {
      mode: 'SKIP';
      reason:
        | 'PAIR_NOT_ALLOWLISTED'
        | 'EDGE_BELOW_MIN_LIVE'
        | 'NOTIONAL_ABOVE_MAX_LIVE'
        | 'MAX_INFLIGHT_REACHED';
    };

export type LivePolicyOrderShape = {
  inputToken: `0x${string}`;
  outputToken: `0x${string}`;
  inputAmount: bigint;
};

export type LivePolicyRouteShape = {
  netEdgeOut: bigint;
};

export type LivePolicyInflightState = {
  inflightCount: number;
};

function normalize(address: `0x${string}`): string {
  return address.toLowerCase();
}

export function decideExecutionMode(
  order: LivePolicyOrderShape,
  route: LivePolicyRouteShape,
  config: RuntimeConfig,
  inflightState: LivePolicyInflightState
): ExecutionModeDecision {
  if (config.shadowMode) {
    return { mode: 'SHADOW', reason: 'SHADOW_MODE_ENABLED' };
  }

  if (config.canaryMode) {
    const allowedPair = config.canaryAllowlistedPairs.some(
      (pair) => normalize(pair.inputToken) === normalize(order.inputToken) && normalize(pair.outputToken) === normalize(order.outputToken)
    );
    if (!allowedPair) {
      return { mode: 'SKIP', reason: 'PAIR_NOT_ALLOWLISTED' };
    }
    if (route.netEdgeOut < config.minLiveEdgeOut) {
      return { mode: 'SKIP', reason: 'EDGE_BELOW_MIN_LIVE' };
    }
    if (order.inputAmount > config.maxLiveNotionalIn) {
      return { mode: 'SKIP', reason: 'NOTIONAL_ABOVE_MAX_LIVE' };
    }
    if (inflightState.inflightCount >= config.maxLiveInflight) {
      return { mode: 'SKIP', reason: 'MAX_INFLIGHT_REACHED' };
    }
    return { mode: 'LIVE', reason: 'CANARY_ALLOWED' };
  }

  return { mode: 'LIVE', reason: 'LIVE_MODE' };
}
