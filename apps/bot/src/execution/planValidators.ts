import { decodeRoutePlanCallbackData } from './callbackData.js';
import type { ExecutionPlan } from './types.js';
import type { PrepareFailureContext } from './prepareFailureTypes.js';

function fail(message: string): { ok: false; failure: PrepareFailureContext } {
  return {
    ok: false,
    failure: {
      reason: 'PREPARE_PLAN_INVALID',
      errorCategory: 'PLAN_VALIDATION',
      errorMessage: message
    }
  };
}

export function validateExecutionPlanStatic(
  plan: ExecutionPlan,
  currentChainId: bigint
): { ok: true } | { ok: false; failure: PrepareFailureContext } {
  if (!plan.executor || plan.executor === '0x0000000000000000000000000000000000000000') {
    return fail('executor address is missing');
  }
  if (plan.txRequestDraft.chainId !== currentChainId) {
    return fail('txRequestDraft chainId mismatch');
  }
  if (plan.txRequestDraft.to.toLowerCase() !== plan.executor.toLowerCase()) {
    return fail('txRequestDraft.to must match executor');
  }
  if (plan.txRequestDraft.data.toLowerCase() !== plan.executeCalldata.toLowerCase()) {
    return fail('txRequestDraft.data must match execute calldata');
  }
  if (plan.selectedPathKind === 'DIRECT' && plan.selectedHopCount !== 1) {
    return fail('DIRECT path must use hopCount=1');
  }
  if (plan.selectedPathKind === 'TWO_HOP' && plan.selectedHopCount !== 2) {
    return fail('TWO_HOP path must use hopCount=2');
  }
  if (plan.selectedPathKind === 'TWO_HOP' && !plan.selectedBridgeToken) {
    return fail('TWO_HOP path requires bridge token');
  }
  if (plan.route.requiredOutput <= 0n || plan.route.minAmountOut <= 0n || plan.requiredOutputOut <= 0n) {
    return fail('required outputs must be positive');
  }
  if (plan.selectedExecutionMode === 'EXACT_OUTPUT') {
    if (!plan.route.targetOutput || plan.route.targetOutput <= 0n) {
      return fail('EXACT_OUTPUT requires positive targetOutput');
    }
    if (!plan.route.maxAmountIn || plan.route.maxAmountIn <= 0n) {
      return fail('EXACT_OUTPUT requires positive maxAmountIn');
    }
  }

  const decoded = decodeRoutePlanCallbackData(plan.callbackData);
  if (decoded.venue !== plan.route.venue) {
    return fail('callback venue mismatch');
  }
  if (decoded.pathKind !== plan.route.pathKind) {
    return fail('callback pathKind mismatch');
  }
  if (decoded.hopCount !== plan.route.hopCount) {
    return fail('callback hopCount mismatch');
  }

  if (plan.route.venue === 'UNISWAP_V3') {
    if (decoded.pathKind === 'DIRECT' && decoded.uniPoolFee === 0) {
      return fail('UNISWAP_V3 direct route requires non-zero pool fee');
    }
    if (plan.selectedExecutionMode === 'EXACT_OUTPUT' && plan.selectedPathDirection !== 'REVERSE') {
      return fail('UNISWAP_V3 exact-output should use reverse path direction');
    }
  }
  if (plan.route.venue === 'CAMELOT_AMMV3') {
    if (decoded.pathKind === 'DIRECT' && decoded.uniPoolFee !== 0) {
      return fail('CAMELOT_AMMV3 direct route must not set uniPoolFee');
    }
    if (decoded.pathKind === 'TWO_HOP' && decoded.encodedPath === '0x') {
      return fail('CAMELOT_AMMV3 two-hop route requires encoded path');
    }
  }
  if (plan.route.venue === 'LFJ_LB') {
    const expectedHopCount = decoded.hopCount;
    if (decoded.lfjTokenPath.length !== expectedHopCount + 1) {
      return fail('LFJ tokenPath length mismatch');
    }
    if (decoded.lfjBinSteps.length !== expectedHopCount) {
      return fail('LFJ binSteps length mismatch');
    }
    if (decoded.lfjVersions.length !== expectedHopCount) {
      return fail('LFJ versions length mismatch');
    }
  }

  return { ok: true };
}

