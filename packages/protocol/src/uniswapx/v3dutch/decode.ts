import { decodeAbiParameters } from 'viem';
import type { SignedV3DutchOrder, V3DutchOrder } from './types.js';

const V3_DUTCH_ORDER_PARAMETER = [
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

export function decodeSignedOrder(encodedOrder: `0x${string}`, signature: `0x${string}`): SignedV3DutchOrder {
  const [order] = decodeAbiParameters(V3_DUTCH_ORDER_PARAMETER, encodedOrder);
  return {
    order: order as V3DutchOrder,
    signature,
    encodedOrder
  };
}
