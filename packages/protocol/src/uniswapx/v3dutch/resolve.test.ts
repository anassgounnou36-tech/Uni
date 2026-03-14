import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { REACTOR_ABI, encodeExecuteWithCallback, toReactorSignedOrder } from '../reactor/abi.js';
import { applyCosignerOverrides } from './cosigner.js';
import { decodeSignedOrder } from './decode.js';
import { DeadlineReachedError, InvalidCosignerInputError, InvalidCosignerOutputError, NoExclusiveOverrideError } from './errors.js';
import { computeCosignerDigest, computeOrderHash } from './hash.js';
import { applyGasAdjustment } from './gasAdjustment.js';
import { resolveAt, resolveSignedOrder, validateOrder } from './resolve.js';
import { classifySupport } from './supportPolicy.js';
import type { SignedV3DutchOrder, SupportPolicyV1, V3DutchOrder } from './types.js';

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../fixtures/orders/arbitrum'
);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const COSIGNER_PK = '0x59c6995e998f97a5a0044966f094538e6f5f4f2f7e4e2af23f0f3fbe7d2f4f0a' as const;

const ORDER_ABI = [
  {
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
      { name: 'cosigner', type: 'address' },
      { name: 'startingBaseFee', type: 'uint256' },
      {
        name: 'baseInput',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'startAmount', type: 'uint256' },
          {
            name: 'curve',
            type: 'tuple',
            components: [
              { name: 'relativeBlocks', type: 'uint256' },
              { name: 'relativeAmounts', type: 'int256[]' }
            ]
          },
          { name: 'maxAmount', type: 'uint256' },
          { name: 'adjustmentPerGweiBaseFee', type: 'uint256' }
        ]
      },
      {
        name: 'baseOutputs',
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'startAmount', type: 'uint256' },
          {
            name: 'curve',
            type: 'tuple',
            components: [
              { name: 'relativeBlocks', type: 'uint256' },
              { name: 'relativeAmounts', type: 'int256[]' }
            ]
          },
          { name: 'recipient', type: 'address' },
          { name: 'minAmount', type: 'uint256' },
          { name: 'adjustmentPerGweiBaseFee', type: 'uint256' }
        ]
      },
      {
        name: 'cosignerData',
        type: 'tuple',
        components: [
          { name: 'decayStartBlock', type: 'uint256' },
          { name: 'exclusiveFiller', type: 'address' },
          { name: 'exclusivityOverrideBps', type: 'uint256' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'outputAmounts', type: 'uint256[]' }
        ]
      },
      { name: 'cosignature', type: 'bytes' }
    ]
  }
] as const;

function fixturePaths(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort();
}

function loadSignedFixture(filePath: string): SignedV3DutchOrder {
  const fixture = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    orderHash?: `0x${string}`;
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
    orderType?: string;
  };

  return decodeSignedOrder(fixture.encodedOrder, fixture.signature);
}

function loadApiFixture(filePath: string): {
  orderHash: `0x${string}`;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  orderType: string;
} {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    orderHash: `0x${string}`;
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
    orderType: string;
  };
}

async function signCosignature(order: V3DutchOrder): Promise<V3DutchOrder> {
  const account = privateKeyToAccount(COSIGNER_PK);
  const orderWithCosigner = { ...order, cosigner: account.address };
  const digest = computeCosignerDigest(computeOrderHash(orderWithCosigner), 42161n, orderWithCosigner.cosignerData);
  const cosignature = await account.sign({ hash: digest });
  return { ...orderWithCosigner, cosignature };
}

async function makeTestOrder(overrides: Partial<V3DutchOrder> = {}): Promise<V3DutchOrder> {
  const base: V3DutchOrder = {
    info: {
      reactor: '0xB274d5F4b833b61B340b654d600A864fB604a87c',
      swapper: '0x1111111111111111111111111111111111111111',
      nonce: 999n,
      deadline: 2_000_000_000n,
      additionalValidationContract: ZERO_ADDRESS,
      additionalValidationData: '0x'
    },
    cosigner: ZERO_ADDRESS,
    startingBaseFee: 100_000_000n,
    baseInput: {
      token: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
      startAmount: 1_000_000n,
      curve: { relativeBlocks: 500n, relativeAmounts: [100_000n] },
      maxAmount: 1_300_000n,
      adjustmentPerGweiBaseFee: 1_000n
    },
    baseOutputs: [
      {
        token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        startAmount: 1_800_000n,
        curve: { relativeBlocks: 500n, relativeAmounts: [200_000n] },
        recipient: '0x1111111111111111111111111111111111111111',
        minAmount: 1_500_000n,
        adjustmentPerGweiBaseFee: 2_000n
      }
    ],
    cosignerData: {
      decayStartBlock: 1_000n,
      exclusiveFiller: ZERO_ADDRESS,
      exclusivityOverrideBps: 0n,
      inputAmount: 0n,
      outputAmounts: [0n]
    },
    cosignature: '0x'
  };

  const order: V3DutchOrder = {
    ...base,
    ...overrides,
    baseInput: { ...base.baseInput, ...(overrides.baseInput ?? {}) },
    baseOutputs: overrides.baseOutputs ?? base.baseOutputs,
    cosignerData: { ...base.cosignerData, ...(overrides.cosignerData ?? {}) }
  };

  return signCosignature(order);
}

function encodeOrder(order: V3DutchOrder): `0x${string}` {
  return encodeAbiParameters(ORDER_ABI, [order]);
}

describe('v3dutch parity mirror', () => {
  it('keeps hash computed before cosigner overrides', async () => {
    const order = await makeTestOrder({
      cosignerData: {
        decayStartBlock: 1_000n,
        exclusiveFiller: ZERO_ADDRESS,
        exclusivityOverrideBps: 0n,
        inputAmount: 900_000n,
        outputAmounts: [1_900_000n]
      }
    });
    const hashBefore = computeOrderHash(order);
    const hashAfterOverride = computeOrderHash(applyCosignerOverrides(order));

    expect(hashBefore).not.toEqual(hashAfterOverride);

    const resolved = await resolveAt(order, {
      blockNumberish: 1_100n,
      timestamp: 1_900_000_000n,
      basefee: 100_000_000n,
      chainId: 42161n
    });
    expect(resolved.hash).toEqual(hashBefore);
  });

  it('enforces cosigner override edge cases', async () => {
    const invalidInput = await makeTestOrder({
      cosignerData: {
        decayStartBlock: 1_000n,
        exclusiveFiller: ZERO_ADDRESS,
        exclusivityOverrideBps: 0n,
        inputAmount: 1_000_001n,
        outputAmounts: [0n]
      }
    });
    expect(() => applyCosignerOverrides(invalidInput)).toThrow(InvalidCosignerInputError);

    const invalidOutputLength = await makeTestOrder({
      cosignerData: {
        decayStartBlock: 1_000n,
        exclusiveFiller: ZERO_ADDRESS,
        exclusivityOverrideBps: 0n,
        inputAmount: 0n,
        outputAmounts: [0n, 0n]
      }
    });
    expect(() => applyCosignerOverrides(invalidOutputLength)).toThrow(InvalidCosignerOutputError);

    const invalidOutputAmount = await makeTestOrder({
      cosignerData: {
        decayStartBlock: 1_000n,
        exclusiveFiller: ZERO_ADDRESS,
        exclusivityOverrideBps: 0n,
        inputAmount: 0n,
        outputAmounts: [1_700_000n]
      }
    });
    expect(() => applyCosignerOverrides(invalidOutputAmount)).toThrow(InvalidCosignerOutputError);
  });

  it('matches gas adjustment bounded and rounding behavior', async () => {
    const order = await makeTestOrder();

    const higherBaseFee = applyGasAdjustment(order, 1_100_000_000n);
    expect(higherBaseFee.baseInput.startAmount).toEqual(1_001_000n);
    expect(higherBaseFee.baseOutputs[0]?.startAmount).toEqual(1_798_000n);

    const lowerBaseFee = applyGasAdjustment(order, 99_000_000n);
    expect(lowerBaseFee.baseInput.startAmount).toEqual(999_999n);
    expect(lowerBaseFee.baseOutputs[0]?.startAmount).toEqual(1_800_002n);
  });

  it('validates deadline and cosigner signature', async () => {
    const order = await makeTestOrder();
    const orderHash = computeOrderHash(order);

    await expect(
      validateOrder(orderHash, order, {
        blockNumberish: 1_000n,
        timestamp: 2_000_000_001n,
        basefee: 100_000_000n,
        chainId: 42161n
      })
    ).rejects.toThrow(DeadlineReachedError);
  });

  it('handles exclusivity override path', async () => {
    const strictExclusive = await makeTestOrder({
      cosignerData: {
        decayStartBlock: 1_200n,
        exclusiveFiller: '0x2222222222222222222222222222222222222222',
        exclusivityOverrideBps: 0n,
        inputAmount: 0n,
        outputAmounts: [0n]
      }
    });

    await expect(
      resolveAt(strictExclusive, {
        blockNumberish: 1_100n,
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n,
        filler: '0x9999999999999999999999999999999999999999'
      })
    ).rejects.toThrow(NoExclusiveOverrideError);

    const overrideOrder = await makeTestOrder({
      cosignerData: {
        decayStartBlock: 1_200n,
        exclusiveFiller: '0x2222222222222222222222222222222222222222',
        exclusivityOverrideBps: 50n,
        inputAmount: 0n,
        outputAmounts: [0n]
      }
    });

    const resolved = await resolveAt(overrideOrder, {
      blockNumberish: 1_100n,
      timestamp: 1_900_000_000n,
      basefee: 100_000_000n,
      chainId: 42161n,
      filler: '0x9999999999999999999999999999999999999999'
    });

    expect(resolved.outputs[0]?.amount).toEqual(1_809_000n);
  });

  it('uses explicit blockNumberish for decay parity', async () => {
    const order = await makeTestOrder();

    const atDecayStart = await resolveAt(order, {
      blockNumberish: 1_000n,
      timestamp: 1_900_000_000n,
      basefee: 100_000_000n,
      chainId: 42161n
    });

    const afterDecay = await resolveAt(order, {
      blockNumberish: 1_250n,
      timestamp: 1_900_000_000n,
      basefee: 100_000_000n,
      chainId: 42161n
    });

    expect(atDecayStart.input.amount).toEqual(1_000_000n);
    expect(afterDecay.input.amount).toBeLessThan(atDecayStart.input.amount);
    expect(afterDecay.outputs[0]?.amount).toBeLessThanOrEqual(atDecayStart.outputs[0]?.amount ?? 0n);
  });

  it('classifies support policy and unsupported exotic shape explicitly', async () => {
    const order = await makeTestOrder();
    const policy: SupportPolicyV1 = {
      kind: 'v1',
      orderType: 'Dutch_V3',
      allowlistedPairs: [
        {
          inputToken: order.baseInput.token,
          outputToken: order.baseOutputs[0]!.token
        }
      ]
    };

    expect(classifySupport(order, policy)).toEqual({ supported: true, reason: 'SUPPORTED' });

    const mixedShape: V3DutchOrder = {
      ...order,
      baseOutputs: [
        order.baseOutputs[0]!,
        {
          ...order.baseOutputs[0]!,
          token: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8'
        }
      ],
      cosignerData: { ...order.cosignerData, outputAmounts: [0n, 0n] }
    };

    expect(classifySupport(mixedShape, policy)).toEqual({
      supported: false,
      reason: 'OUTPUT_TOKEN_MISMATCH'
    });
  });

  it('resolves live fixture corpus with canonical hash reconciliation and synthetic edge fixtures', async () => {
    const liveFixtures = fixturePaths(path.join(FIXTURES_ROOT, 'live'));
    const syntheticFixtures = fixturePaths(path.join(FIXTURES_ROOT, 'synthetic'));

    for (const fixturePath of liveFixtures) {
      const fixture = loadApiFixture(fixturePath);
      const signed = decodeSignedOrder(fixture.encodedOrder, fixture.signature);
      expect(computeOrderHash(signed.order)).toEqual(fixture.orderHash);
      const resolved = await resolveSignedOrder(signed.encodedOrder, signed.signature, {
        blockNumberish: 1_150n,
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n,
        filler: '0x9999999999999999999999999999999999999999'
      });
      expect(resolved.hash).toEqual(fixture.orderHash);
    }

    const invalidLengthFixture = loadSignedFixture(
      syntheticFixtures.find((filePath) => filePath.includes('invalid-output-length'))!
    );
    await expect(
      resolveSignedOrder(invalidLengthFixture.encodedOrder, invalidLengthFixture.signature, {
        blockNumberish: 1_150n,
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      })
    ).rejects.toThrow(InvalidCosignerOutputError);

    const mixedShapeFixture = loadSignedFixture(
      syntheticFixtures.find((filePath) => filePath.includes('mixed-output-token-shape'))!
    );
    const policy: SupportPolicyV1 = {
      kind: 'v1',
      orderType: 'Dutch_V3',
      allowlistedPairs: [
        {
          inputToken: mixedShapeFixture.order.baseInput.token,
          outputToken: mixedShapeFixture.order.baseOutputs[0]!.token
        }
      ]
    };

    expect(classifySupport(mixedShapeFixture.order, policy)).toEqual({
      supported: false,
      reason: 'OUTPUT_TOKEN_MISMATCH'
    });
  });

  it('encodes executeWithCallback using exact reactor SignedOrder envelope', () => {
    const fixture = loadApiFixture(path.join(FIXTURES_ROOT, 'live/live-01.json'));
    const signedOrder = toReactorSignedOrder(fixture.encodedOrder, fixture.signature);
    const calldata = encodeExecuteWithCallback(signedOrder, '0x1234');
    const decoded = decodeFunctionData({
      abi: REACTOR_ABI,
      data: calldata
    });

    expect(decoded.functionName).toEqual('executeWithCallback');
    expect(decoded.args).toEqual([signedOrder, '0x1234']);
  });

  it('snapshots resolved outputs across blockNumberish/basefee combinations', async () => {
    const fixture = loadSignedFixture(path.join(FIXTURES_ROOT, 'live/live-01.json'));

    const resolvedA = await resolveSignedOrder(fixture.encodedOrder, fixture.signature, {
      blockNumberish: 1_000n,
      timestamp: 1_900_000_000n,
      basefee: 100_000_000n,
      chainId: 42161n
    });
    const resolvedB = await resolveSignedOrder(fixture.encodedOrder, fixture.signature, {
      blockNumberish: 1_250n,
      timestamp: 1_900_000_000n,
      basefee: 1_100_000_000n,
      chainId: 42161n
    });
    const resolvedC = await resolveSignedOrder(fixture.encodedOrder, fixture.signature, {
      blockNumberish: 1_500n,
      timestamp: 1_900_000_000n,
      basefee: 99_000_000n,
      chainId: 42161n
    });

    expect({
      a: {
        input: resolvedA.input.amount.toString(),
        output: resolvedA.outputs[0]!.amount.toString()
      },
      b: {
        input: resolvedB.input.amount.toString(),
        output: resolvedB.outputs[0]!.amount.toString()
      },
      c: {
        input: resolvedC.input.amount.toString(),
        output: resolvedC.outputs[0]!.amount.toString()
      }
    }).toMatchInlineSnapshot(`
      {
        "a": {
          "input": "1000000",
          "output": "1800000",
        },
        "b": {
          "input": "951000",
          "output": "1698000",
        },
        "c": {
          "input": "899999",
          "output": "1600002",
        },
      }
    `);
  });

  it('keeps TS mirror aligned with harness-style vector', async () => {
    const order = await makeTestOrder();
    const encodedOrder = encodeOrder(order);

    const resolved = await resolveSignedOrder(encodedOrder, '0x', {
      blockNumberish: 1_250n,
      timestamp: 1_900_000_000n,
      basefee: 100_000_000n,
      chainId: 42161n,
      filler: ZERO_ADDRESS
    });

    expect(resolved.input.amount).toEqual(950000n);
    expect(resolved.outputs[0]!.amount).toEqual(1700000n);
  });
});
