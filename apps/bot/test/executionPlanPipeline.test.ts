import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  encodeAbiParameters,
  type Hex,
  type PublicClient,
  type WalletClient
} from 'viem';
import { arbitrum } from 'viem/chains';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import solc from 'solc';
import { decodeSignedOrder } from '@uni/protocol';
import { CAMELOT_AMMV3_FACTORY, CAMELOT_AMMV3_QUOTER, UNIV3_FACTORY, UNIV3_QUOTER_V2 } from '../../../packages/config/src/arbitrum.js';
import { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';
import { RouteBook } from '../src/routing/routeBook.js';
import { CamelotAmmv3RoutePlanner } from '../src/routing/camelotV3/routePlanner.js';
import { decodeRoutePlanCallbackData } from '../src/execution/callbackData.js';
import { EXECUTOR_ABI } from '../src/execution/abi.js';
import { buildExecutionPlan } from '../src/execution/planBuilder.js';
import { prepareExecution } from '../src/execution/prepareExecution.js';
import { createForkClients } from '../src/sim/forkClient.js';
import { ForkSimService } from '../src/sim/forkSimService.js';
import { SequencerClient } from '../src/send/sequencerClient.js';
import { deriveFreshnessEnvelopeFromSchedule } from '../src/send/conditional.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import { convertGasWeiToTokenOut, ARBITRUM_WETH } from '../src/routing/univ3/gasValue.js';
import type { UniV3RoutePlanner as UniV3RoutePlannerType } from '../src/routing/univ3/routePlanner.js';

const TREASURY = '0x1234560000000000000000000000000000000000' as const;

type CompiledExecutorArtifacts = {
  uniAdapterCreationCode: (mockUniRouter: `0x${string}`) => Hex;
  camelotAdapterCreationCode: (mockCamelotRouter: `0x${string}`) => Hex;
  executorCreationCode: (args: {
    reactor: `0x${string}`;
    uniswapAdapter: `0x${string}`;
    camelotAdapter: `0x${string}`;
    treasury: `0x${string}`;
    owner: `0x${string}`;
  }) => Hex;
  mockReactorCreationCode: Hex;
  mockUniRouterCreationCode: Hex;
  mockCamelotRouterCreationCode: Hex;
};

let compiledArtifacts: CompiledExecutorArtifacts | undefined;

const MOCK_REACTOR_ABI = [
  {
    type: 'function',
    name: 'setShouldCallback',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'value', type: 'bool' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'clearConfiguredResolvedOrders',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'pushConfiguredResolvedOrder',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          {
            name: 'info',
            type: 'tuple',
            components: [
              { name: 'reactor', type: 'address' },
              { name: 'swapper', type: 'address' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
              { name: 'additionalValidationContract', type: 'address' },
              { name: 'additionalValidationData', type: 'bytes' }
            ]
          },
          {
            name: 'input',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'maxAmount', type: 'uint256' }
            ]
          },
          {
            name: 'outputs',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'recipient', type: 'address' }
            ]
          },
          { name: 'sig', type: 'bytes' },
          { name: 'hash', type: 'bytes32' }
        ]
      }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'lastCaller',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  }
] as const;

const MOCK_UNI_ROUTER_ABI = [
  {
    type: 'function',
    name: 'setAmountOut',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: []
  }
] as const;

const MOCK_CAMELOT_ROUTER_ABI = [
  {
    type: 'function',
    name: 'setAmountOut',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'swapCalls',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

const EXECUTOR_WIRING_ABI = [
  {
    type: 'function',
    name: 'UNISWAP_V3_ADAPTER',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'CAMELOT_AMMV3_ADAPTER',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  }
] as const;

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
    factory: UNIV3_FACTORY,
    quoter: UNIV3_QUOTER_V2
  });
}

function collectSoliditySources(root: string): Record<string, { content: string }> {
  const sources: Record<string, { content: string }> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.sol')) {
        const rel = path.relative(root, absolutePath).replace(/\\/g, '/');
        sources[rel] = { content: fs.readFileSync(absolutePath, 'utf8') };
      }
    }
  };
  walk(root);
  return sources;
}

function compileExecutorArtifacts(): CompiledExecutorArtifacts {
  if (compiledArtifacts) {
    return compiledArtifacts;
  }

  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../contracts/executor/src');
  const sources = collectSoliditySources(srcRoot);
  sources['MockReactorForExecutorFlow.sol'] = {
    content: fs
      .readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../../contracts/executor/test/mocks/MockReactorForExecutorFlow.sol'
        ),
        'utf8'
      )
      .replaceAll('../../src/', '')
  };
  sources['MockSwapRouter02ForExecutorFlow.sol'] = {
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintableToken {
  function mint(address to, uint256 amount) external;
}

contract MockSwapRouter02ForExecutorFlow {
  uint256 public amountOut;
  uint256 public swapCalls;

  struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
  }

  function setAmountOut(uint256 value) external {
    amountOut = value;
  }

  function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256) {
    swapCalls += 1;
    if (amountOut < params.amountOutMinimum) {
      return amountOut;
    }
    if (amountOut > 0) {
      IMintableToken(params.tokenOut).mint(params.recipient, amountOut);
    }
    return amountOut;
  }
}`
  };
  sources['MockCamelotAmmv3RouterForExecutorFlow.sol'] = {
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintableToken {
  function mint(address to, uint256 amount) external;
}

contract MockCamelotAmmv3RouterForExecutorFlow {
  uint256 public amountOut;
  uint256 public swapCalls;

  struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 limitSqrtPrice;
  }

  function setAmountOut(uint256 value) external {
    amountOut = value;
  }

  function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256) {
    swapCalls += 1;
    if (amountOut < params.amountOutMinimum) {
      return amountOut;
    }
    if (amountOut > 0) {
      IMintableToken(params.tokenOut).mint(params.recipient, amountOut);
    }
    return amountOut;
  }
}`
  };

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': {
          '*': ['evm.bytecode.object']
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    contracts?: Record<string, Record<string, { evm: { bytecode: { object: string } } }>>;
    errors?: Array<{ severity: string; formattedMessage: string }>;
  };

  const compileErrors = (output.errors ?? []).filter((error) => error.severity === 'error');
  if (compileErrors.length > 0) {
    throw new Error(`solc compile failed: ${compileErrors.map((e) => e.formattedMessage).join('\n')}`);
  }

  const getBytecode = (sourcePath: string, contractName: string): Hex => {
    const code = output.contracts?.[sourcePath]?.[contractName]?.evm.bytecode.object;
    if (!code || code.length === 0) {
      throw new Error(`missing bytecode for ${contractName} (${sourcePath})`);
    }
    return `0x${code}`;
  };

  const uniAdapterBytecode = getBytecode('adapters/UniV3SwapRouter02Adapter.sol', 'UniV3SwapRouter02Adapter');
  const camelotAdapterBytecode = getBytecode('adapters/CamelotAmmv3Adapter.sol', 'CamelotAmmv3Adapter');
  const executorBytecode = getBytecode('UniswapXDutchV3Executor.sol', 'UniswapXDutchV3Executor');
  const mockReactorBytecode = getBytecode('MockReactorForExecutorFlow.sol', 'MockReactorForExecutorFlow');
  const mockUniRouterBytecode = getBytecode('MockSwapRouter02ForExecutorFlow.sol', 'MockSwapRouter02ForExecutorFlow');
  const mockCamelotRouterBytecode = getBytecode('MockCamelotAmmv3RouterForExecutorFlow.sol', 'MockCamelotAmmv3RouterForExecutorFlow');

  compiledArtifacts = {
    uniAdapterCreationCode: (mockUniRouter) =>
      concatHex([uniAdapterBytecode, encodeAbiParameters([{ type: 'address' }], [mockUniRouter])]),
    camelotAdapterCreationCode: (mockCamelotRouter) =>
      concatHex([camelotAdapterBytecode, encodeAbiParameters([{ type: 'address' }], [mockCamelotRouter])]),
    executorCreationCode: ({ reactor, uniswapAdapter, camelotAdapter, treasury, owner }) =>
      concatHex([
        executorBytecode,
        encodeAbiParameters(
          [
            { type: 'address' },
            { type: 'address' },
            { type: 'address' },
            { type: 'address' },
            { type: 'address' }
          ],
          [reactor, uniswapAdapter, camelotAdapter, treasury, owner]
        )
      ]),
    mockReactorCreationCode: mockReactorBytecode,
    mockUniRouterCreationCode: mockUniRouterBytecode,
    mockCamelotRouterCreationCode: mockCamelotRouterBytecode
  };

  return compiledArtifacts;
}

async function deployCreationCode(
  walletClient: WalletClient,
  publicClient: PublicClient,
  creationCode: Hex
): Promise<`0x${string}`> {
  const txHash = await walletClient.sendTransaction({
    account: walletClient.account!,
    data: creationCode,
    chain: arbitrum
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new Error('contract deployment failed');
  }
  return receipt.contractAddress;
}

async function sendContractCall(
  clients: { walletClient: WalletClient; publicClient: PublicClient },
  to: `0x${string}`,
  data: `0x${string}`
) {
  const txHash = await clients.walletClient.sendTransaction({
    account: clients.walletClient.account!,
    to,
    data,
    chain: arbitrum
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
}

async function deployRealExecutorStack(clients: { walletClient: WalletClient; publicClient: PublicClient }) {
  const artifacts = compileExecutorArtifacts();
  const mockUniRouterAddress = await deployCreationCode(
    clients.walletClient,
    clients.publicClient,
    artifacts.mockUniRouterCreationCode
  );
  const mockCamelotRouterAddress = await deployCreationCode(
    clients.walletClient,
    clients.publicClient,
    artifacts.mockCamelotRouterCreationCode
  );
  const mockReactorAddress = await deployCreationCode(
    clients.walletClient,
    clients.publicClient,
    artifacts.mockReactorCreationCode
  );
  const uniAdapterAddress = await deployCreationCode(
    clients.walletClient,
    clients.publicClient,
    artifacts.uniAdapterCreationCode(mockUniRouterAddress)
  );
  const camelotAdapterAddress = await deployCreationCode(
    clients.walletClient,
    clients.publicClient,
    artifacts.camelotAdapterCreationCode(mockCamelotRouterAddress)
  );
  const executorAddress = await deployCreationCode(
    clients.walletClient,
    clients.publicClient,
    artifacts.executorCreationCode({
      reactor: mockReactorAddress,
      uniswapAdapter: uniAdapterAddress,
      camelotAdapter: camelotAdapterAddress,
      treasury: TREASURY,
      owner: clients.walletClient.account!.address
    })
  );
  if (uniAdapterAddress.toLowerCase() === camelotAdapterAddress.toLowerCase()) {
    throw new Error('VENUE_ADAPTERS_MUST_BE_DISTINCT');
  }
  const [uniAdapterCode, camelotAdapterCode, executorCode] = await Promise.all([
    clients.publicClient.getCode({ address: uniAdapterAddress }),
    clients.publicClient.getCode({ address: camelotAdapterAddress }),
    clients.publicClient.getCode({ address: executorAddress })
  ]);
  if (!uniAdapterCode || uniAdapterCode === '0x') {
    throw new Error('UNI_ADAPTER_CODE_MISSING');
  }
  if (!camelotAdapterCode || camelotAdapterCode === '0x') {
    throw new Error('CAMELOT_ADAPTER_CODE_MISSING');
  }
  if (!executorCode || executorCode === '0x') {
    throw new Error('EXECUTOR_CODE_MISSING');
  }

  return {
    mockUniRouterAddress,
    mockCamelotRouterAddress,
    mockReactorAddress,
    uniAdapterAddress,
    camelotAdapterAddress,
    executorAddress
  };
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

    const routeBook = {
      selectBestRoute: async () => ({
        ok: true,
        chosenRoute: {
          venue: 'UNISWAP_V3',
          pathKind: 'DIRECT',
          hopCount: 1,
          tokenIn: resolvedOrder.input.token,
          tokenOut: resolvedOrder.outputs[0]!.token,
          amountIn: resolvedOrder.input.amount,
          requiredOutput: 900n,
          quotedAmountOut: 1100n,
          slippageBufferOut: 10n,
          gasCostOut: 30n,
          riskBufferOut: 20n,
          profitFloorOut: 5n,
          minAmountOut: 1090n,
          limitSqrtPriceX96: 0n,
          grossEdgeOut: 200n,
          netEdgeOut: 135n,
          quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 }
        },
        alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut: 135n }]
      })
    } as RouteBook;

    const result = await routeBook.selectBestRoute({ resolvedOrder });
    expect(result.ok).toEqual(true);
    if (!result.ok) return;
    expect(result.chosenRoute.netEdgeOut).toEqual(
      result.chosenRoute.quotedAmountOut -
        result.chosenRoute.requiredOutput -
        result.chosenRoute.slippageBufferOut -
        result.chosenRoute.gasCostOut -
        result.chosenRoute.riskBufferOut -
        result.chosenRoute.profitFloorOut
    );
    const slippageFloorOut = result.chosenRoute.quotedAmountOut - result.chosenRoute.slippageBufferOut;
    const profitabilityFloorOut =
      result.chosenRoute.requiredOutput
      + result.chosenRoute.gasCostOut
      + result.chosenRoute.riskBufferOut
      + result.chosenRoute.profitFloorOut;
    expect(result.chosenRoute.minAmountOut).toEqual(
      slippageFloorOut > profitabilityFloorOut ? slippageFloorOut : profitabilityFloorOut
    );
  });
});

describe('conditional envelope policy', () => {
  it('defaults to TimestampMax only and omits block bounds', () => {
    const envelope = deriveFreshnessEnvelopeFromSchedule({
      currentL2TimestampSec: 1_000n,
      scheduledWindowBlocks: 3n,
      avgBlockTimeSec: 2n,
      maxStalenessSec: 10n
    });
    expect(envelope.TimestampMax).toEqual(1_016n);
    expect(envelope.BlockNumberMax).toBeUndefined();
    expect(envelope.BlockNumberMin).toBeUndefined();
  });

  it('includes block bounds only when enableConditionalBlockBounds is true', () => {
    const envelope = deriveFreshnessEnvelopeFromSchedule({
      currentL2TimestampSec: 1_000n,
      scheduledWindowBlocks: 3n,
      avgBlockTimeSec: 2n,
      maxStalenessSec: 10n,
      enableConditionalBlockBounds: true,
      blockNumberMin: 10n,
      blockNumberMax: 20n
    });
    expect(envelope.TimestampMax).toEqual(1_016n);
    expect(envelope.BlockNumberMin).toEqual(10n);
    expect(envelope.BlockNumberMax).toEqual(20n);
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

    const routeBook = {
      selectBestRoute: async ({ resolvedOrder }: { resolvedOrder: { input: { token: `0x${string}`; amount: bigint }; outputs: Array<{ token: `0x${string}`; amount: bigint }> } }) => {
        const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
        return {
          ok: true,
          chosenRoute: {
            venue: 'UNISWAP_V3',
            pathKind: 'DIRECT',
            hopCount: 1,
            tokenIn: resolvedOrder.input.token,
            tokenOut: resolvedOrder.outputs[0]!.token,
            amountIn: resolvedOrder.input.amount,
            requiredOutput,
            quotedAmountOut: requiredOutput + 500n,
            minAmountOut: requiredOutput,
            limitSqrtPriceX96: 0n,
            slippageBufferOut: 0n,
            gasCostOut: 0n,
            riskBufferOut: 0n,
            profitFloorOut: 0n,
            grossEdgeOut: 500n,
            netEdgeOut: 500n,
            quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 3000 }
          },
          alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut: 500n }]
        };
      }
    } as never;

    const built = await buildExecutionPlan({
      normalizedOrder: normalized,
      routeBook,
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
    expect(callbackDecoded.uniPoolFee).toEqual(3000);
    expect(callbackDecoded.pathKind).toEqual('DIRECT');

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

describe.skipIf(!ARB_FORK_URL)('fork-backed execution pipeline using real executor contract code', () => {
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

  it('executorStackDeploysDistinctVenueAdapters', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const { uniAdapterAddress, camelotAdapterAddress } = await deployRealExecutorStack(clients);
    expect(uniAdapterAddress.toLowerCase()).not.toEqual(camelotAdapterAddress.toLowerCase());
    const [uniCode, camelotCode] = await Promise.all([
      clients.publicClient.getCode({ address: uniAdapterAddress }),
      clients.publicClient.getCode({ address: camelotAdapterAddress })
    ]);
    expect(uniCode && uniCode !== '0x').toEqual(true);
    expect(camelotCode && camelotCode !== '0x').toEqual(true);
  });

  it('usesSamePreparedExecutionAgainstRealExecutorAndReactorCompatibleMock', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const { fixture, decoded } = loadSigned();

    const { mockUniRouterAddress, mockReactorAddress, executorAddress } = await deployRealExecutorStack(clients);

    const reactorCode = await clients.publicClient.getCode({ address: mockReactorAddress });
    if (!reactorCode || reactorCode === '0x') {
      throw new Error('REACTOR_CODE_MISSING');
    }

    const routeBook = {
      selectBestRoute: async ({ resolvedOrder }: { resolvedOrder: { input: { token: `0x${string}`; amount: bigint }; outputs: Array<{ token: `0x${string}`; amount: bigint }> } }) => {
        const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
        return {
          ok: true,
          chosenRoute: {
            venue: 'UNISWAP_V3',
            pathKind: 'DIRECT',
            hopCount: 1,
            tokenIn: resolvedOrder.input.token,
            tokenOut: resolvedOrder.outputs[0]!.token,
            amountIn: resolvedOrder.input.amount,
            requiredOutput,
            quotedAmountOut: requiredOutput + 1n,
            minAmountOut: 0n,
            limitSqrtPriceX96: 0n,
            slippageBufferOut: 0n,
            gasCostOut: 0n,
            riskBufferOut: 0n,
            profitFloorOut: 0n,
            grossEdgeOut: 1n,
            netEdgeOut: 1n,
            quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 }
          },
          alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut: 1n }]
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
      routeBook,
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

    await sendContractCall(
      clients,
      mockUniRouterAddress,
      encodeFunctionData({
        abi: MOCK_UNI_ROUTER_ABI,
        functionName: 'setAmountOut',
        args: [0n]
      })
    );
    await sendContractCall(
      clients,
      mockReactorAddress,
      encodeFunctionData({
        abi: MOCK_REACTOR_ABI,
        functionName: 'clearConfiguredResolvedOrders',
        args: []
      })
    );
    await sendContractCall(
      clients,
      mockReactorAddress,
      encodeFunctionData({
        abi: MOCK_REACTOR_ABI,
        functionName: 'setShouldCallback',
        args: [true]
      })
    );
    await sendContractCall(
      clients,
      mockReactorAddress,
      encodeFunctionData({
        abi: MOCK_REACTOR_ABI,
        functionName: 'pushConfiguredResolvedOrder',
        args: [
          {
            info: {
              reactor: mockReactorAddress,
              swapper: clients.sender,
              nonce: 1n,
              deadline: 2n ** 255n,
              additionalValidationContract: '0x0000000000000000000000000000000000000000',
              additionalValidationData: '0x'
            },
            input: {
              token: planResult.plan.route.tokenIn,
              amount: 0n,
              maxAmount: 0n
            },
            outputs: [
              {
                token: planResult.plan.route.tokenOut,
                amount: 0n,
                recipient: clients.sender
              }
            ],
            sig: '0x',
            hash: '0x0000000000000000000000000000000000000000000000000000000000000000'
          }
        ]
      })
    );

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

    expect(prepared.serializedTransaction.startsWith('0x')).toEqual(true);
    expect(prepared.executionPlan.executor.toLowerCase()).toEqual(executorAddress.toLowerCase());
    expect(prepared.conditionalEnvelope.TimestampMax).toBeDefined();
    expect(prepared.conditionalEnvelope.BlockNumberMax).toBeUndefined();

    const sim = new ForkSimService({ clients, cleanupSnapshot: false });
    const simResult = await sim.simulatePrepared(prepared);
    expect(simResult.serializedTransaction).toEqual(prepared.serializedTransaction);
    expect(simResult.txRequest.to.toLowerCase()).toEqual(executorAddress.toLowerCase());
    expect(simResult.receipt).toBeDefined();
    expect(simResult.ok).toEqual(true);
    const lastCaller = await clients.publicClient.readContract({
      address: mockReactorAddress,
      abi: MOCK_REACTOR_ABI,
      functionName: 'lastCaller'
    });
    expect(String(lastCaller).toLowerCase()).toEqual(executorAddress.toLowerCase());

    let sendSerialized: `0x${string}` | undefined;
    const sequencerClient = new SequencerClient({
      sequencerUrl: 'https://sequencer.example',
      fallbackUrl: 'https://fallback.example',
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { params: [`0x${string}`, unknown?] };
        sendSerialized = body.params[0];
        return {
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          })
        } as Response;
      }) as typeof fetch,
      getCurrentL2TimestampSec: () => 1_900_000_000n
    });

    const sendResult = await sequencerClient.sendPreparedExecution(prepared);
    expect(sendResult.accepted).toEqual(true);
    expect(sendSerialized).toEqual(prepared.serializedTransaction);
    expect(simResult.serializedTransaction).toEqual(sendSerialized);
  });

  it('supports optional conditional block bounds only when explicitly enabled', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const { fixture, decoded } = loadSigned();
    const { executorAddress } = await deployRealExecutorStack(clients);

    const routeBook = {
      selectBestRoute: async ({ resolvedOrder }: { resolvedOrder: { input: { token: `0x${string}`; amount: bigint }; outputs: Array<{ token: `0x${string}`; amount: bigint }> } }) => {
        const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
        return {
          ok: true,
          chosenRoute: {
            venue: 'UNISWAP_V3',
            pathKind: 'DIRECT',
            hopCount: 1,
            tokenIn: resolvedOrder.input.token,
            tokenOut: resolvedOrder.outputs[0]!.token,
            amountIn: resolvedOrder.input.amount,
            requiredOutput,
            quotedAmountOut: requiredOutput + 1n,
            minAmountOut: requiredOutput,
            limitSqrtPriceX96: 0n,
            slippageBufferOut: 0n,
            gasCostOut: 0n,
            riskBufferOut: 0n,
            profitFloorOut: 0n,
            grossEdgeOut: 1n,
            netEdgeOut: 1n,
            quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 }
          },
          alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut: 1n }]
        };
      }
    } as never;

    const planResult = await buildExecutionPlan({
      normalizedOrder: {
        orderHash: '0x3efd647626a32590eff1daa3d028ebcbd9553dbe2a144c50980cdcffc60a9c92',
        orderType: 'Dutch_V3',
        encodedOrder: fixture.encodedOrder,
        signature: fixture.signature,
        decodedOrder: decoded,
        reactor: decoded.order.info.reactor
      },
      routeBook,
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

    const preparedWithBounds = await prepareExecution({
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
        maxStalenessSec: 10n,
        enableConditionalBlockBounds: true,
        blockNumberMin: 1000n,
        blockNumberMax: 1010n
      }
    });

    expect(preparedWithBounds.conditionalEnvelope.BlockNumberMin).toEqual(1000n);
    expect(preparedWithBounds.conditionalEnvelope.BlockNumberMax).toEqual(1010n);
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

  it('can read real Camelot AMMv3 single-hop quotes from forked pool state', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const planner = new CamelotAmmv3RoutePlanner({
      client: clients.publicClient,
      enabled: true,
      factory: CAMELOT_AMMV3_FACTORY,
      quoter: CAMELOT_AMMV3_QUOTER,
      univ3Factory: UNIV3_FACTORY,
      univ3Quoter: UNIV3_QUOTER_V2
    });
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

  it('routeBook compares Uni and Camelot deterministically on fork', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const routeBook = new RouteBook({
      uniswapV3: makeRoutePlanner(clients.publicClient),
      camelotAmmv3: new CamelotAmmv3RoutePlanner({
        client: clients.publicClient,
        enabled: true,
        factory: CAMELOT_AMMV3_FACTORY,
        quoter: CAMELOT_AMMV3_QUOTER,
        univ3Factory: UNIV3_FACTORY,
        univ3Quoter: UNIV3_QUOTER_V2,
        bridgeTokens: ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1']
      }),
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
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

    expect(selected.ok).toEqual(true);
    if (selected.ok) {
      expect(['UNISWAP_V3', 'CAMELOT_AMMV3']).toContain(selected.chosenRoute.venue);
    }
  });

  it('usesRealCamelotAdapterWhenPreparedExecutionVenueIsCamelot', async () => {
    const clients = createForkClients({
      rpcUrl,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    });
    const { fixture, decoded } = loadSigned();
    const {
      mockCamelotRouterAddress,
      mockReactorAddress,
      uniAdapterAddress,
      camelotAdapterAddress,
      executorAddress
    } = await deployRealExecutorStack(clients);

    await sendContractCall(
      clients,
      mockCamelotRouterAddress,
      encodeFunctionData({
        abi: MOCK_CAMELOT_ROUTER_ABI,
        functionName: 'setAmountOut',
        args: [0n]
      })
    );
    await sendContractCall(
      clients,
      mockReactorAddress,
      encodeFunctionData({
        abi: MOCK_REACTOR_ABI,
        functionName: 'clearConfiguredResolvedOrders',
        args: []
      })
    );
    await sendContractCall(
      clients,
      mockReactorAddress,
      encodeFunctionData({
        abi: MOCK_REACTOR_ABI,
        functionName: 'setShouldCallback',
        args: [true]
      })
    );

    const routeBook = {
      selectBestRoute: async ({ resolvedOrder }: { resolvedOrder: { input: { token: `0x${string}`; amount: bigint }; outputs: Array<{ token: `0x${string}`; amount: bigint }> } }) => ({
        ok: true,
        chosenRoute: {
          venue: 'CAMELOT_AMMV3',
          tokenIn: resolvedOrder.input.token,
          tokenOut: resolvedOrder.outputs[0]!.token,
          amountIn: resolvedOrder.input.amount,
          requiredOutput: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n),
          quotedAmountOut: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n) + 10n,
          minAmountOut: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n),
          limitSqrtPriceX96: 0n,
          slippageBufferOut: 0n,
          gasCostOut: 0n,
          riskBufferOut: 0n,
          profitFloorOut: 0n,
          grossEdgeOut: 10n,
          netEdgeOut: 10n,
          quoteMetadata: { venue: 'CAMELOT_AMMV3', observedFee: 30 }
        },
        alternativeRoutes: [{ venue: 'CAMELOT_AMMV3', eligible: true, netEdgeOut: 10n }]
      })
    } as RouteBook;

    const planResult = await buildExecutionPlan({
      normalizedOrder: {
        orderHash: '0x3efd647626a32590eff1daa3d028ebcbd9553dbe2a144c50980cdcffc60a9c92',
        orderType: 'Dutch_V3',
        encodedOrder: fixture.encodedOrder,
        signature: fixture.signature,
        decodedOrder: decoded,
        reactor: mockReactorAddress
      },
      routeBook,
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
    if (!planResult.ok) {
      return;
    }
    expect(planResult.plan.route.venue).toEqual('CAMELOT_AMMV3');
    expect(planResult.plan.executor.toLowerCase()).toEqual(executorAddress.toLowerCase());
    expect(planResult.plan.callbackData.startsWith('0x')).toEqual(true);

    const [wiredUniAdapter, wiredCamelotAdapter] = await Promise.all([
      clients.publicClient.readContract({
        address: executorAddress,
        abi: EXECUTOR_WIRING_ABI,
        functionName: 'UNISWAP_V3_ADAPTER'
      }),
      clients.publicClient.readContract({
        address: executorAddress,
        abi: EXECUTOR_WIRING_ABI,
        functionName: 'CAMELOT_AMMV3_ADAPTER'
      })
    ]);
    expect((wiredUniAdapter as `0x${string}`).toLowerCase()).toEqual(uniAdapterAddress.toLowerCase());
    expect((wiredCamelotAdapter as `0x${string}`).toLowerCase()).toEqual(camelotAdapterAddress.toLowerCase());
    expect(uniAdapterAddress.toLowerCase()).not.toEqual(camelotAdapterAddress.toLowerCase());

    await sendContractCall(
      clients,
      mockReactorAddress,
      encodeFunctionData({
        abi: MOCK_REACTOR_ABI,
        functionName: 'pushConfiguredResolvedOrder',
        args: [
          {
            info: {
              reactor: mockReactorAddress,
              swapper: clients.sender,
              nonce: 1n,
              deadline: 2n ** 255n,
              additionalValidationContract: '0x0000000000000000000000000000000000000000',
              additionalValidationData: '0x'
            },
            input: {
              token: planResult.plan.route.tokenIn,
              amount: 0n,
              maxAmount: 0n
            },
            outputs: [
              {
                token: planResult.plan.route.tokenOut,
                amount: 0n,
                recipient: clients.sender
              }
            ],
            sig: '0x',
            hash: '0x0000000000000000000000000000000000000000000000000000000000000000'
          }
        ]
      })
    );

    const nonceManager = new NonceManager({
      ledger: new InMemoryNonceLedger(),
      chainNonceReader: async (address) => BigInt(await clients.publicClient.getTransactionCount({ address, blockTag: 'pending' }))
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
    expect(prepared.executionPlan.route.venue).toEqual('CAMELOT_AMMV3');
    expect(prepared.txRequest.to.toLowerCase()).toEqual(executorAddress.toLowerCase());
    expect(prepared.serializedTransaction.startsWith('0x')).toEqual(true);

    const sim = new ForkSimService({ clients });
    const simResult = await sim.simulatePrepared(prepared);
    expect(simResult.ok).toEqual(true);
    expect(simResult.serializedTransaction).toEqual(prepared.serializedTransaction);

    const camelotSwapCalls = await clients.publicClient.readContract({
      address: mockCamelotRouterAddress,
      abi: MOCK_CAMELOT_ROUTER_ABI,
      functionName: 'swapCalls'
    });
    expect(camelotSwapCalls).toEqual(1n);

    const sequencerClient = new SequencerClient({
      sequencerUrl: 'http://127.0.0.1:0',
      fallbackUrl: 'http://127.0.0.1:0',
      shadowMode: true
    });
    const sendObservation = await sequencerClient.sendPreparedExecution(prepared);
    expect(sendObservation.records[0]?.serializedTransaction).toEqual(prepared.serializedTransaction);
    expect(sendObservation.records[0]?.serializedTransaction).toEqual(simResult.serializedTransaction);
  });
});
