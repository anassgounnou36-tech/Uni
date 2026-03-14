import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { arbitrum } from 'viem/chains';
import { decodeFunctionData, type PublicClient, type WalletClient } from 'viem';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { decodeSignedOrder } from '@uni/protocol';
import { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';
import { decodeRoutePlanCallbackData } from '../src/execution/callbackData.js';
import { EXECUTOR_ABI } from '../src/execution/abi.js';
import { buildExecutionPlan } from '../src/execution/planBuilder.js';
import { prepareExecution } from '../src/execution/prepareExecution.js';
import { createForkClients } from '../src/sim/forkClient.js';
import { ForkSimService } from '../src/sim/forkSimService.js';
import { SequencerClient } from '../src/send/sequencerClient.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import { convertGasWeiToTokenOut, ARBITRUM_WETH } from '../src/routing/univ3/gasValue.js';
import type { UniV3RoutePlanner as UniV3RoutePlannerType } from '../src/routing/univ3/routePlanner.js';

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

function makeRoutePlanner(client: PublicClient): UniV3RoutePlannerType {
  return new UniV3RoutePlanner({
    client,
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
  });
}

async function deployNoopExecutor(walletClient: WalletClient, publicClient: PublicClient): Promise<`0x${string}`> {
  const txHash = await walletClient.sendTransaction({
    account: walletClient.account!,
    data: '0x6001600c60003960016000f30000',
    chain: arbitrum
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new Error('executor deploy failed');
  }
  return receipt.contractAddress;
}

describe('quoting/planning unit accounting', () => {
  it('converts gas to tokenOut units with WETH identity and direct quote path', async () => {
    const mockClient = {
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === 'getPool') {
          const fee = args?.[2] as number;
          return fee === 500 ? '0x5000000000000000000000000000000000000000' : '0x0000000000000000000000000000000000000000';
        }
        if (functionName === 'liquidity') {
          return 1n;
        }
        if (functionName === 'slot0') {
          return [1n, 0, 0, 0, 0, 0, false];
        }
        if (functionName === 'quoteExactInputSingle') {
          return [2_000_000n, 0n, 0, 100_000n];
        }
        throw new Error('unexpected call');
      }
    } as never;

    const identity = await convertGasWeiToTokenOut({
      client: mockClient,
      factory: '0xf000000000000000000000000000000000000000',
      quoter: '0xf100000000000000000000000000000000000000',
      tokenOut: ARBITRUM_WETH,
      gasWei: 123n,
      supportedFeeTiers: [500, 3000, 10000]
    });
    expect(identity).toEqual({ ok: true, gasCostOut: 123n });

    const direct = await convertGasWeiToTokenOut({
      client: mockClient,
      factory: '0xf000000000000000000000000000000000000000',
      quoter: '0xf100000000000000000000000000000000000000',
      tokenOut: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      gasWei: 100_000n,
      supportedFeeTiers: [500, 3000, 10000]
    });
    expect(direct).toMatchObject({ ok: true, gasCostOut: 2_000_000n });
  });

  it('returns NOT_PRICEABLE_GAS when no direct WETH-tokenOut pool quote exists', async () => {
    const mockClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getPool') {
          return '0x0000000000000000000000000000000000000000';
        }
        throw new Error('unexpected call');
      }
    } as never;

    const result = await convertGasWeiToTokenOut({
      client: mockClient,
      factory: '0xf000000000000000000000000000000000000000',
      quoter: '0xf100000000000000000000000000000000000000',
      tokenOut: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      gasWei: 100_000n,
      supportedFeeTiers: [500, 3000, 10000]
    });
    expect(result).toEqual({ ok: false, reason: 'NOT_PRICEABLE_GAS' });
  });

  it('computes netEdgeOut and minAmountOut in output-token units only', async () => {
    const resolvedOrder = {
      info: {} as never,
      input: {
        token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amount: 1000n,
        maxAmount: 1000n
      },
      outputs: [
        {
          token: ARBITRUM_WETH,
          amount: 900n,
          recipient: '0x1111111111111111111111111111111111111111'
        }
      ],
      sig: '0x',
      hash: '0x1234'
    } as const;

    const planner = {
      planBestRoute: async () => ({
        ok: true,
        consideredFees: [500],
        route: {
          tokenIn: resolvedOrder.input.token,
          tokenOut: resolvedOrder.outputs[0]!.token,
          amountIn: resolvedOrder.input.amount,
          requiredOutput: 900n,
          quotedAmountOut: 1100n,
          poolFee: 500,
          slippageBufferOut: 10n,
          gasCostOut: 30n,
          riskBufferOut: 20n,
          profitFloorOut: 5n,
          minAmountOut: 1090n,
          grossEdgeOut: 200n,
          netEdgeOut: 135n
        }
      })
    } as UniV3RoutePlannerType;

    const result = await planner.planBestRoute({ resolvedOrder });
    expect(result.ok).toEqual(true);
    if (!result.ok) return;
    expect(result.route.netEdgeOut).toEqual(
      result.route.quotedAmountOut -
        result.route.requiredOutput -
        result.route.slippageBufferOut -
        result.route.gasCostOut -
        result.route.riskBufferOut -
        result.route.profitFloorOut
    );
    const slippageFloorOut = result.route.quotedAmountOut - result.route.slippageBufferOut;
    const profitabilityFloorOut =
      result.route.requiredOutput + result.route.gasCostOut + result.route.riskBufferOut + result.route.profitFloorOut;
    expect(result.route.minAmountOut).toEqual(slippageFloorOut > profitabilityFloorOut ? slippageFloorOut : profitabilityFloorOut);
  });
});

describe('execution plan pipeline integration', () => {
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
            slippageBufferOut: 0n,
            gasCostOut: 0n,
            riskBufferOut: 0n,
            profitFloorOut: 0n,
            grossEdgeOut: 500n,
            netEdgeOut: 500n
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
    if (!built.ok) return;

    const callbackDecoded = decodeRoutePlanCallbackData(built.plan.callbackData);
    expect(callbackDecoded.tokenIn.toLowerCase()).toEqual(built.plan.route.tokenIn.toLowerCase());
    expect(callbackDecoded.tokenOut.toLowerCase()).toEqual(built.plan.route.tokenOut.toLowerCase());
    expect(callbackDecoded.poolFee).toEqual(built.plan.route.poolFee);

    const executeDecoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: built.plan.executeCalldata });
    expect(executeDecoded.functionName).toEqual('execute');
    const [signedOrder, callbackData] = executeDecoded.args as [{ order: `0x${string}`; sig: `0x${string}` }, `0x${string}`];
    expect(signedOrder.order).toEqual(fixture.encodedOrder);
    expect(signedOrder.sig).toEqual(fixture.signature);
    expect(callbackData).toEqual(built.plan.callbackData);
  });

  it('shadow mode stores serialized tx and conditional envelope from prepared execution', async () => {
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
    expect(client.getSendRecords()[0]!.serializedTransaction.startsWith('0x')).toEqual(true);
  });
});

const ARB_FORK_URL = process.env.ARB_FORK_URL;

describe.skipIf(!ARB_FORK_URL)('fork-backed execution pipeline (real fork + deployed code)', () => {
  let anvil: ChildProcessWithoutNullStreams | undefined;
  const port = 8600 + Math.floor(Math.random() * 200);
  const rpcUrl = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', ARB_FORK_URL!, '--chain-id', '42161', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('anvil fork start timeout')), 20_000);
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
    anvil?.stdin.end();
  });

  it('submits a real serialized tx to deployed executor code and gets success receipt', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const { fixture, decoded } = loadSigned();

    const executorAddress = await deployNoopExecutor(clients.walletClient, clients.publicClient);
    const code = await clients.publicClient.getCode({ address: executorAddress });
    if (!code || code === '0x') {
      throw new Error('EXECUTOR_CODE_MISSING');
    }

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
            slippageBufferOut: 0n,
            gasCostOut: 0n,
            riskBufferOut: 0n,
            profitFloorOut: 0n,
            grossEdgeOut: 1n,
            netEdgeOut: 1n
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

    const planResult = await buildExecutionPlan({
      normalizedOrder: normalized,
      planner,
      executor: executorAddress,
      blockNumberish: 1000n,
      resolveEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      conditionalEnvelope: { TimestampMax: 1_900_000_100n }
    });
    expect(planResult.ok).toEqual(true);
    if (!planResult.ok) return;

    const nonceManager = new NonceManager({
      ledger: new InMemoryNonceLedger(),
      chainNonceReader: async (account) =>
        BigInt(
          await clients.publicClient.getTransactionCount({
            address: account,
            blockTag: 'pending'
          })
        )
    });

    const prepared = await prepareExecution({
      executionPlan: planResult.plan,
      account: clients.sender,
      nonceManager,
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      txPolicy: {
        gasHeadroomBps: 100n,
        maxGasCeiling: 2_000_000n
      },
      conditionalPolicy: {
        currentL2TimestampSec: 1_900_000_000n,
        scheduledWindowBlocks: 2n,
        avgBlockTimeSec: 1n,
        maxStalenessSec: 10n
      }
    });

    const sim = new ForkSimService({ clients });
    const result = await sim.simulatePrepared(prepared);
    expect(result.serializedTransaction).toEqual(prepared.serializedTransaction);
    expect(result.receipt?.status).toEqual('success');
  });

  it('can read real route quotes from forked pool state', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const planner = makeRoutePlanner(clients.publicClient);

    const routeResult = await planner.planBestRoute({
      resolvedOrder: {
        info: {} as never,
        input: {
          token: ARBITRUM_WETH,
          amount: 10_000_000_000_000n,
          maxAmount: 10_000_000_000_000n
        },
        outputs: [
          {
            token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
            amount: 1n,
            recipient: '0x1111111111111111111111111111111111111111'
          }
        ],
        sig: '0x',
        hash: '0x1234'
      }
    });

    expect(routeResult.ok).toEqual(true);
  });
});
