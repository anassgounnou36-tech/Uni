import { decodeRoutePlanCallbackData } from './callbackData.js';
import type { ExecutionPlan } from './types.js';
import type { PrepareFailureContext } from './prepareFailureTypes.js';

function fail(plan: ExecutionPlan, message: string): { ok: false; failure: PrepareFailureContext } {
  return {
    ok: false,
    failure: {
      reason: 'PREPARE_PLAN_INVALID',
      errorCategory: 'PLAN_VALIDATION',
      errorMessage: message,
      preflightStage: 'validate',
      venue: plan.route.venue,
      pathKind: plan.route.pathKind,
      executionMode: plan.selectedExecutionMode
    }
  };
}

function validateUniswapExactOutputCoherence(
  plan: ExecutionPlan,
  decoded: ReturnType<typeof decodeRoutePlanCallbackData>
): { ok: true } | { ok: false; failure: PrepareFailureContext } {
  if (plan.route.venue !== 'UNISWAP_V3' || plan.selectedExecutionMode !== 'EXACT_OUTPUT') {
    return { ok: true };
  }
  if (decoded.executionMode !== 'EXACT_OUTPUT') {
    return fail(plan, 'UNISWAP_V3 exact-output callback executionMode mismatch');
  }
  if (decoded.pathDirection !== 'REVERSE' || plan.selectedPathDirection !== 'REVERSE') {
    return fail(plan, 'UNISWAP_V3 exact-output requires reverse path direction');
  }
  if (decoded.tokenIn.toLowerCase() !== plan.route.tokenIn.toLowerCase() || decoded.tokenOut.toLowerCase() !== plan.route.tokenOut.toLowerCase()) {
    return fail(plan, 'UNISWAP_V3 exact-output callback token path mismatch');
  }
  if (!plan.route.targetOutput || !plan.route.maxAmountIn) {
    return fail(plan, 'UNISWAP_V3 exact-output requires targetOutput and maxAmountIn');
  }
  if (decoded.targetOutput !== plan.route.targetOutput) {
    return fail(plan, 'UNISWAP_V3 exact-output targetOutput mismatch between route and callback');
  }
  if (decoded.maxAmountIn !== plan.route.maxAmountIn) {
    return fail(plan, 'UNISWAP_V3 exact-output maxAmountIn mismatch between route and callback');
  }
  if (plan.route.pathKind === 'DIRECT' && decoded.hopCount !== 1) {
    return fail(plan, 'UNISWAP_V3 exact-output direct route requires hopCount=1');
  }
  if (plan.route.pathKind === 'TWO_HOP' && (decoded.hopCount !== 2 || decoded.encodedPath === '0x')) {
    return fail(plan, 'UNISWAP_V3 exact-output two-hop route requires hopCount=2 and encodedPath');
  }
  return { ok: true };
}

export function validateExecutionPlanStatic(
  plan: ExecutionPlan,
  currentChainId: bigint
): { ok: true } | { ok: false; failure: PrepareFailureContext } {
  if (!plan.executor || plan.executor === '0x0000000000000000000000000000000000000000') {
    return fail(plan, 'executor address is missing');
  }
  if (plan.txRequestDraft.chainId !== currentChainId) {
    return fail(plan, 'txRequestDraft chainId mismatch');
  }
  if (plan.txRequestDraft.to.toLowerCase() !== plan.executor.toLowerCase()) {
    return fail(plan, 'txRequestDraft.to must match executor');
  }
  if (plan.txRequestDraft.data.toLowerCase() !== plan.executeCalldata.toLowerCase()) {
    return fail(plan, 'txRequestDraft.data must match execute calldata');
  }
  if (plan.selectedPathKind === 'DIRECT' && plan.selectedHopCount !== 1) {
    return fail(plan, 'DIRECT path must use hopCount=1');
  }
  if (plan.selectedPathKind === 'TWO_HOP' && plan.selectedHopCount !== 2) {
    return fail(plan, 'TWO_HOP path must use hopCount=2');
  }
  if (plan.selectedPathKind === 'TWO_HOP' && !plan.selectedBridgeToken) {
    return fail(plan, 'TWO_HOP path requires bridge token');
  }
  if (plan.route.requiredOutput <= 0n || plan.route.minAmountOut <= 0n || plan.requiredOutputOut <= 0n) {
    return fail(plan, 'required outputs must be positive');
  }
  if (plan.selectedExecutionMode === 'EXACT_OUTPUT') {
    if (!plan.route.targetOutput || plan.route.targetOutput <= 0n) {
      return fail(plan, 'EXACT_OUTPUT requires positive targetOutput');
    }
    if (!plan.route.maxAmountIn || plan.route.maxAmountIn <= 0n) {
      return fail(plan, 'EXACT_OUTPUT requires positive maxAmountIn');
    }
  }

  let decoded: ReturnType<typeof decodeRoutePlanCallbackData>;
  try {
    decoded = decodeRoutePlanCallbackData(plan.callbackData);
  } catch (error) {
    return fail(plan, `callbackData decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (decoded.venue !== plan.route.venue) {
    return fail(plan, 'callback venue mismatch');
  }
  if (decoded.pathKind !== plan.route.pathKind) {
    return fail(plan, 'callback pathKind mismatch');
  }
  if (decoded.hopCount !== plan.route.hopCount) {
    return fail(plan, 'callback hopCount mismatch');
  }

  if (plan.route.venue === 'UNISWAP_V3') {
    if (decoded.pathKind === 'DIRECT' && decoded.uniPoolFee === 0) {
      return fail(plan, 'UNISWAP_V3 direct route requires non-zero pool fee');
    }
    if (plan.selectedExecutionMode === 'EXACT_OUTPUT' && plan.selectedPathDirection !== 'REVERSE') {
      return fail(plan, 'UNISWAP_V3 exact-output should use reverse path direction');
    }
    const exactOutputCheck = validateUniswapExactOutputCoherence(plan, decoded);
    if (!exactOutputCheck.ok) {
      return exactOutputCheck;
    }
  }
  if (plan.route.venue === 'CAMELOT_AMMV3') {
    if (decoded.pathKind === 'DIRECT' && decoded.uniPoolFee !== 0) {
      return fail(plan, 'CAMELOT_AMMV3 direct route must not set uniPoolFee');
    }
    if (decoded.pathKind === 'TWO_HOP' && decoded.encodedPath === '0x') {
      return fail(plan, 'CAMELOT_AMMV3 two-hop route requires encoded path');
    }
  }
  if (plan.route.venue === 'LFJ_LB') {
    const expectedHopCount = decoded.hopCount;
    if (decoded.lfjTokenPath.length !== expectedHopCount + 1) {
      return fail(plan, 'LFJ tokenPath length mismatch');
    }
    if (decoded.lfjBinSteps.length !== expectedHopCount) {
      return fail(plan, 'LFJ binSteps length mismatch');
    }
    if (decoded.lfjVersions.length !== expectedHopCount) {
      return fail(plan, 'LFJ versions length mismatch');
    }
  }

  return { ok: true };
}
