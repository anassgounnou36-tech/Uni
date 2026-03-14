import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { decodeFunctionData } from 'viem';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { decodeSignedOrder } from '@uni/protocol';
import { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';
import { decodeRoutePlanCallbackData } from '../src/execution/callbackData.js';
import { EXECUTOR_ABI } from '../src/execution/abi.js';
import { buildExecutionPlan } from '../src/execution/planBuilder.js';
import { createForkClients } from '../src/sim/forkClient.js';
import { ForkSimService } from '../src/sim/forkSimService.js';
import { SequencerClient } from '../src/send/sequencerClient.js';

function loadSigned() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  return {
    fixture,
    decoded: decodeSignedOrder(fixture.encodedOrder, fixture.signature)
  };
}

describe('execution plan pipeline integration', () => {
  it('route planner selects best fee tier by positive net edge or rejects as NOT_ROUTEABLE', async () => {
    const resolvedOrder = {
      info: {} as never,
      input: {
        token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amount: 1000n,
        maxAmount: 1000n
      },
      outputs: [
        {
          token: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          amount: 900n,
          recipient: '0x1111111111111111111111111111111111111111'
        }
      ],
      sig: '0x',
      hash: '0x1234'
    } as const;

    const mockClient = {
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === 'getPool') {
          const fee = args?.[2] as number;
          if (fee === 500) {
            return '0x5000000000000000000000000000000000000000';
          }
          if (fee === 3000) {
            return '0x3000000000000000000000000000000000000000';
          }
          return '0x0000000000000000000000000000000000000000';
        }
        if (functionName === 'liquidity') {
          return 1n;
        }
        if (functionName === 'slot0') {
          return [1n, 0, 0, 0, 0, 0, false];
        }
        if (functionName === 'quoteExactInputSingle') {
          const quoteParams = args?.[0] as { fee: number };
          if (quoteParams.fee === 500) {
            return [1100n, 0n, 0, 100n];
          }
          return [1200n, 0n, 0, 260n];
        }
        throw new Error('unexpected call');
      }
    } as never;

    const planner = new UniV3RoutePlanner({
      client: mockClient,
      factory: '0xf000000000000000000000000000000000000000',
      quoter: '0xf100000000000000000000000000000000000000'
    });

    const selected = await planner.planBestRoute({ resolvedOrder });
    expect(selected.ok).toEqual(true);
    expect(selected.ok && selected.route.poolFee).toEqual(500);

    const rejectingClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getPool') {
          return '0x0000000000000000000000000000000000000000';
        }
        throw new Error('unexpected');
      }
    } as never;

    const rejectingPlanner = new UniV3RoutePlanner({
      client: rejectingClient,
      factory: '0xf000000000000000000000000000000000000000',
      quoter: '0xf100000000000000000000000000000000000000'
    });
    const rejected = await rejectingPlanner.planBestRoute({ resolvedOrder });
    expect(rejected.ok).toEqual(false);
  });

  it('builds real execution plan with callbackData and execute calldata shapes', async () => {
    const { fixture, decoded } = loadSigned();
    const normalized = {
      orderHash: '0x3efd647626a32590eff1daa3d028ebcbd9553dbe2a144c50980cdcffc60a9c92',
      orderType: 'Dutch_V3',
      encodedOrder: fixture.encodedOrder,
      signature: fixture.signature,
      decodedOrder: decoded,
      reactor: decoded.order.info.reactor
    } as const;

    const planner = {
      planBestRoute: async ({ resolvedOrder }: { resolvedOrder: { input: { token: `0x${string}`; amount: bigint }; outputs: Array<{ token: `0x${string}`; amount: bigint }> } }) => {
        const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
        return {
          ok: true,
          consideredFees: [3000],
          route: {
            tokenIn: resolvedOrder.input.token,
            tokenOut: resolvedOrder.outputs[0]!.token,
            amountIn: resolvedOrder.input.amount,
            requiredOutput,
            quotedAmountOut: requiredOutput + 500n,
            poolFee: 3000,
            minAmountOut: requiredOutput,
            grossEdge: 500n,
            gasCostWei: 10n,
            riskBufferWei: 5n,
            netEdge: 485n
          }
        };
      }
    } as never;

    const built = await buildExecutionPlan({
      normalizedOrder: normalized,
      planner,
      executor: '0x3333333333333333333333333333333333333333',
      blockNumberish: 1000n,
      resolveEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      conditionalEnvelope: { TimestampMax: 1_900_000_100n }
    });

    expect(built.ok).toEqual(true);
    if (!built.ok) {
      return;
    }

    const callbackDecoded = decodeRoutePlanCallbackData(built.plan.callbackData);
    expect(callbackDecoded.tokenIn.toLowerCase()).toEqual(built.plan.route.tokenIn.toLowerCase());
    expect(callbackDecoded.tokenOut.toLowerCase()).toEqual(built.plan.route.tokenOut.toLowerCase());
    expect(callbackDecoded.poolFee).toEqual(built.plan.route.poolFee);

    const executeDecoded = decodeFunctionData({
      abi: EXECUTOR_ABI,
      data: built.plan.executeCalldata
    });
    expect(executeDecoded.functionName).toEqual('execute');
    const [signedOrder, callbackData] = executeDecoded.args as [{ order: `0x${string}`; sig: `0x${string}` }, `0x${string}`];
    expect(signedOrder.order).toEqual(fixture.encodedOrder);
    expect(signedOrder.sig).toEqual(fixture.signature);
    expect(callbackData).toEqual(built.plan.callbackData);
  });

  it('sequencer shadow mode records real serialized tx and conditional envelope', async () => {
    const client = new SequencerClient({
      sequencerUrl: 'https://sequencer.example',
      fallbackUrl: 'https://fallback.example',
      shadowMode: true,
      getCurrentL2TimestampSec: () => 100n
    });

    const response = await client.send({
      orderHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      serializedTransaction: '0x02f86c8201a9843b9aca00847735940082520894aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa80c001a09fcb8962f55b4a7f7d8bd4409c9876f4bbef01a9fa6cb1f5e49f84b80d8dc945a0609d4c43fd4bbca60f1d469be9396a96f664f645dd5bb58b2f9b2585fa1313cf',
      nonce: 1n,
      conditional: { TimestampMax: 101n }
    });
    expect(response.accepted).toEqual(false);
    expect(client.getSendRecords()[0]!.conditionalEnvelope?.TimestampMax).toEqual(101n);
  });
});

describe('fork-backed simulation (real signed tx shape)', () => {
  let anvil: ChildProcessWithoutNullStreams | undefined;
  const port = 8600 + Math.floor(Math.random() * 200);
  const rpcUrl = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(port), '--chain-id', '42161'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('anvil start timeout')), 10_000);
      anvil!.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Listening on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      anvil!.stderr.on('data', (chunk) => {
        if (String(chunk).toLowerCase().includes('error')) {
          clearTimeout(timeout);
          reject(new Error(String(chunk)));
        }
      });
    });
  });

  afterAll(async () => {
    if (anvil && anvil.exitCode === null) {
      anvil.kill('SIGTERM');
    }
  });

  it('simulates a real serialized executor transaction on local forked environment', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const { fixture, decoded } = loadSigned();

    const planner = {
      planBestRoute: async ({ resolvedOrder }: { resolvedOrder: { input: { token: `0x${string}`; amount: bigint }; outputs: Array<{ token: `0x${string}`; amount: bigint }> } }) => {
        const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
        return {
          ok: true,
          consideredFees: [500],
          route: {
            tokenIn: resolvedOrder.input.token,
            tokenOut: resolvedOrder.outputs[0]!.token,
            amountIn: resolvedOrder.input.amount,
            requiredOutput,
            quotedAmountOut: requiredOutput + 1n,
            poolFee: 500,
            minAmountOut: requiredOutput,
            grossEdge: 1n,
            gasCostWei: 1n,
            riskBufferWei: 0n,
            netEdge: 1n
          }
        };
      }
    } as never;

    const normalized = {
      orderHash: '0x3efd647626a32590eff1daa3d028ebcbd9553dbe2a144c50980cdcffc60a9c92',
      orderType: 'Dutch_V3',
      encodedOrder: fixture.encodedOrder,
      signature: fixture.signature,
      decodedOrder: decoded,
      reactor: decoded.order.info.reactor
    } as const;

    const built = await buildExecutionPlan({
      normalizedOrder: normalized,
      planner,
      executor: '0x7777777777777777777777777777777777777777',
      blockNumberish: 1000n,
      resolveEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      conditionalEnvelope: { TimestampMax: 1_900_000_100n }
    });

    expect(built.ok).toEqual(true);
    if (!built.ok) {
      return;
    }

    const sim = new ForkSimService({ clients });
    const result = await sim.simulateFinal(built.plan);
    expect(result.serializedTransaction.startsWith('0x')).toEqual(true);
    expect(result.txRequest.to.toLowerCase()).toEqual('0x7777777777777777777777777777777777777777');
  });
});
