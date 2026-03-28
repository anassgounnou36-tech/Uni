import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { decodeExecutionError } from '../src/execution/errorDecode.js';
import { runPreparePreflight } from '../src/execution/preparePreflight.js';
import { validateExecutionPlanStatic } from '../src/execution/planValidators.js';
import type { ExecutionPlan } from '../src/execution/types.js';
import { encodeRoutePlanCallbackData } from '../src/execution/callbackData.js';

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  const base: ExecutionPlan = {
    orderHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    reactor: '0x1111111111111111111111111111111111111111',
    executor: '0x2222222222222222222222222222222222222222',
    signedOrder: { order: '0x1234', sig: '0x5678' },
    normalizedOrder: {} as never,
    resolvedOrder: {} as never,
    route: {
      venue: 'UNISWAP_V3',
      executionMode: 'EXACT_INPUT',
      pathKind: 'DIRECT',
      hopCount: 1,
      tokenIn: '0x3333333333333333333333333333333333333333',
      tokenOut: '0x4444444444444444444444444444444444444444',
      amountIn: 10n,
      requiredOutput: 9n,
      quotedAmountOut: 10n,
      minAmountOut: 9n,
      limitSqrtPriceX96: 0n,
      grossEdgeOut: 1n,
      slippageBufferOut: 0n,
      gasCostOut: 0n,
      riskBufferOut: 0n,
      profitFloorOut: 0n,
      netEdgeOut: 1n,
      quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 },
      encodedPath: '0xabcdef'
    } as never,
    routeAlternatives: [],
    callbackData: encodeRoutePlanCallbackData({
      venue: 'UNISWAP_V3',
      executionMode: 'EXACT_INPUT',
      pathKind: 'DIRECT',
      hopCount: 1,
      pathDirection: 'FORWARD',
      tokenIn: '0x3333333333333333333333333333333333333333',
      tokenOut: '0x4444444444444444444444444444444444444444',
      encodedPath: '0xabcdef',
      quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 },
      limitSqrtPriceX96: 0n,
      minAmountOut: 9n,
      requiredOutput: 9n,
      amountIn: 10n
    }),
    executeCalldata: '0x1234',
    txRequestDraft: {
      chainId: 42161n,
      to: '0x2222222222222222222222222222222222222222',
      data: '0x1234',
      value: 0n
    },
    conditionalEnvelope: { TimestampMax: 100n },
    requiredOutputOut: 9n,
    predictedNetEdgeOut: 1n,
    selectedExecutionMode: 'EXACT_INPUT',
    selectedPathKind: 'DIRECT',
    selectedHopCount: 1,
    selectedPathDirection: 'FORWARD',
    selectedBlock: 100n,
    resolveEnv: { timestamp: 99n, basefee: 1n, chainId: 42161n },
    runtimeSessionId: 'runtime-test',
    plannedAtBlockNumber: 100n,
    plannedAtTimestampMs: 1_000,
    resolvedAtBlockNumber: 100n,
    resolvedAtTimestampSec: 99n,
    scheduledAtMs: 1_000,
    candidateBlockNumberish: 100n,
    planFingerprint: '0xdeadbeef'
  };
  return { ...base, ...overrides };
}

function preflightArgs(executionPlan: ExecutionPlan, publicClient: PublicClient) {
  return {
    executionPlan,
    account: '0x9999999999999999999999999999999999999999' as const,
    publicClient,
    runtimeSessionId: 'runtime-test',
    currentBlockNumber: 100n,
    nowMs: 1_000,
    maxPrepareStalenessBlocks: 2n,
    maxPrepareStalenessMs: 4_000
  };
}

describe('prepare preflight pipeline', () => {
  it('invalid execution plan fails static validation with PREPARE_PLAN_INVALID', () => {
    const invalid = makePlan({
      selectedPathKind: 'TWO_HOP',
      selectedHopCount: 1
    });
    const result = validateExecutionPlanStatic(invalid, 42161n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('PREPARE_PLAN_INVALID');
  });

  it('uniswap exact-output malformed plan fails early as PREPARE_PLAN_INVALID', () => {
    const invalid = makePlan({
      selectedExecutionMode: 'EXACT_OUTPUT',
      selectedPathDirection: 'FORWARD',
      route: {
        ...(makePlan().route as never),
        venue: 'UNISWAP_V3',
        executionMode: 'EXACT_OUTPUT',
        targetOutput: 9n,
        maxAmountIn: 10n
      } as never
    });
    const result = validateExecutionPlanStatic(invalid, 42161n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('PREPARE_PLAN_INVALID');
  });

  it('reverting call is PREPARE_CALL_REVERTED with selector preservation', async () => {
    const client = {
      getChainId: async () => 42161,
      call: async () => {
        const error = new Error('reverted');
        (error as Error & { data?: `0x${string}` }).data = '0xb08ce5b3';
        throw error;
      }
    } as unknown as PublicClient;
    const result = await runPreparePreflight({
      ...preflightArgs(makePlan(), client)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('PREPARE_CALL_REVERTED');
    expect(result.failure.errorSelector).toBe('0xb08ce5b3');
  });

  it('unknown selector is still persisted as selector hex', async () => {
    const client = {
      getChainId: async () => 42161,
      call: async () => {
        const error = new Error('reverted');
        (error as Error & { data?: `0x${string}` }).data = '0x12345678';
        throw error;
      }
    } as unknown as PublicClient;
    const result = await runPreparePreflight({
      ...preflightArgs(makePlan(), client)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.errorSelector).toBe('0x12345678');
    expect(result.failure.decodedErrorName).toBe('UNKNOWN_SELECTOR_0x12345678');
  });

  it('nested viem-like text-only selector mention is extracted', () => {
    const decoded = decodeExecutionError({
      shortMessage: 'Execution reverted',
      details: 'execution reverted: custom error 0xb08ce5b3',
      cause: {
        message: 'rpc error',
        metaMessages: ['Simulation failed with custom error 0xb08ce5b3']
      }
    });
    expect(decoded.errorSelector).toBe('0xb08ce5b3');
    expect(decoded.decodedErrorName).toBe('DeadlineReached');
  });

  it('known selector maps to decodedErrorName', () => {
    const decoded = decodeExecutionError({
      data: '0x5c427cd9'
    });
    expect(decoded.errorSelector).toBe('0x5c427cd9');
    expect(decoded.decodedErrorName).toBe('UnauthorizedCaller');
  });

  it('unknown textual selector persists with stable fallback decode name', () => {
    const decoded = decodeExecutionError({
      message: 'custom error 0xfeedbeef'
    });
    expect(decoded.errorSelector).toBe('0xfeedbeef');
    expect(decoded.decodedErrorName).toBe('UNKNOWN_SELECTOR_0xfeedbeef');
  });

  it('successful call then estimateGas failure is PREPARE_ESTIMATE_GAS_FAILED', async () => {
    const client = {
      getChainId: async () => 42161,
      call: async () => ({ data: '0x' }),
      estimateGas: async () => {
        throw new Error('EstimateGasExecutionError');
      }
    } as unknown as PublicClient;
    const result = await runPreparePreflight({
      ...preflightArgs(makePlan(), client)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('PREPARE_ESTIMATE_GAS_FAILED');
  });

  it('scheduled plan with mismatched session id becomes PREPARE_INVALID_PLAN_ANCHOR', async () => {
    const client = {
      getChainId: async () => 42161,
      call: async () => ({ data: '0x' }),
      estimateGas: async () => 21_000n
    } as unknown as PublicClient;
    const result = await runPreparePreflight({
      ...preflightArgs(makePlan({ runtimeSessionId: 'runtime-other' }), client)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('PREPARE_INVALID_PLAN_ANCHOR');
  });

  it('negative block delta becomes PREPARE_INVALID_PLAN_ANCHOR (not stale)', async () => {
    const client = {
      getChainId: async () => 42161,
      call: async () => ({ data: '0x' }),
      estimateGas: async () => 21_000n
    } as unknown as PublicClient;
    const result = await runPreparePreflight({
      ...preflightArgs(makePlan({ plannedAtBlockNumber: 200n }), client)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('PREPARE_INVALID_PLAN_ANCHOR');
  });

  it('old scheduled plan with matching session id becomes PREPARE_STALE_PLAN', async () => {
    const client = {
      getChainId: async () => 42161,
      call: async () => ({ data: '0x' }),
      estimateGas: async () => 21_000n
    } as unknown as PublicClient;
    const result = await runPreparePreflight({
      ...preflightArgs(
        makePlan({
          plannedAtBlockNumber: 90n,
          plannedAtTimestampMs: 100
        }),
        client
      ),
      nowMs: 10_000
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('PREPARE_STALE_PLAN');
  });

  it('fresh scheduled plan with matching session id can enter prepare preflight', async () => {
    const client = {
      getChainId: async () => 42161,
      call: async () => ({ data: '0x' }),
      estimateGas: async () => 21_000n
    } as unknown as PublicClient;
    const result = await runPreparePreflight({
      ...preflightArgs(makePlan(), client)
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.estimatedGas).toBe(21_000n);
  });
});
