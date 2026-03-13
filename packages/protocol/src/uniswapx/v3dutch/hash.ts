import { concatHex, encodeAbiParameters, encodePacked, keccak256, padHex, toHex } from 'viem';
import type { CosignerData, NonlinearDutchDecay, OrderInfo, V3DutchInput, V3DutchOrder, V3DutchOutput } from './types.js';

const ORDER_INFO_TYPE =
  'OrderInfo(address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData)';
const NON_LINEAR_DECAY_TYPE = 'NonlinearDutchDecay(uint256 relativeBlocks,int256[] relativeAmounts)';
const V3_DUTCH_INPUT_TYPE =
  'V3DutchInput(address token,uint256 startAmount,NonlinearDutchDecay curve,uint256 maxAmount,uint256 adjustmentPerGweiBaseFee)';
const V3_DUTCH_OUTPUT_TYPE =
  'V3DutchOutput(address token,uint256 startAmount,NonlinearDutchDecay curve,address recipient,uint256 minAmount,uint256 adjustmentPerGweiBaseFee)';
const V3_DUTCH_ORDER_TYPE =
  'V3DutchOrder(OrderInfo info,address cosigner,uint256 startingBaseFee,V3DutchInput baseInput,V3DutchOutput[] baseOutputs)';

const ORDER_TYPE = `${V3_DUTCH_ORDER_TYPE}${NON_LINEAR_DECAY_TYPE}${ORDER_INFO_TYPE}${V3_DUTCH_INPUT_TYPE}${V3_DUTCH_OUTPUT_TYPE}`;

const ORDER_INFO_TYPE_HASH = keccak256(toHex(ORDER_INFO_TYPE));
const NON_LINEAR_DECAY_TYPE_HASH = keccak256(toHex(NON_LINEAR_DECAY_TYPE));
const V3_DUTCH_INPUT_TYPE_HASH = keccak256(toHex(`${V3_DUTCH_INPUT_TYPE}${NON_LINEAR_DECAY_TYPE}`));
const V3_DUTCH_OUTPUT_TYPE_HASH = keccak256(toHex(`${V3_DUTCH_OUTPUT_TYPE}${NON_LINEAR_DECAY_TYPE}`));
const ORDER_TYPE_HASH = keccak256(toHex(ORDER_TYPE));

function packInt256(value: bigint): `0x${string}` {
  const wrapped = value >= 0n ? value : (1n << 256n) + value;
  return padHex(`0x${wrapped.toString(16)}`, { size: 32 });
}

function packInt256Array(values: bigint[]): `0x${string}` {
  if (values.length === 0) {
    return '0x';
  }
  return concatHex(values.map((value) => packInt256(value)));
}

export function hashOrderInfo(info: OrderInfo): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' }
      ],
      [
        ORDER_INFO_TYPE_HASH,
        info.reactor,
        info.swapper,
        info.nonce,
        info.deadline,
        info.additionalValidationContract,
        keccak256(info.additionalValidationData)
      ]
    )
  );
}

export function hashNonlinearDutchDecay(curve: NonlinearDutchDecay): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
      [NON_LINEAR_DECAY_TYPE_HASH, curve.relativeBlocks, keccak256(packInt256Array(curve.relativeAmounts))]
    )
  );
}

export function hashV3DutchInput(input: V3DutchInput): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' }
      ],
      [
        V3_DUTCH_INPUT_TYPE_HASH,
        input.token,
        input.startAmount,
        hashNonlinearDutchDecay(input.curve),
        input.maxAmount,
        input.adjustmentPerGweiBaseFee
      ]
    )
  );
}

export function hashV3DutchOutput(output: V3DutchOutput): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' }
      ],
      [
        V3_DUTCH_OUTPUT_TYPE_HASH,
        output.token,
        output.startAmount,
        hashNonlinearDutchDecay(output.curve),
        output.recipient,
        output.minAmount,
        output.adjustmentPerGweiBaseFee
      ]
    )
  );
}

export function hashV3DutchOutputs(outputs: V3DutchOutput[]): `0x${string}` {
  if (outputs.length === 0) {
    return keccak256('0x');
  }
  return keccak256(concatHex(outputs.map((output) => hashV3DutchOutput(output))));
}

export function computeOrderHash(order: V3DutchOrder): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' }
      ],
      [
        ORDER_TYPE_HASH,
        hashOrderInfo(order.info),
        order.cosigner,
        order.startingBaseFee,
        hashV3DutchInput(order.baseInput),
        hashV3DutchOutputs(order.baseOutputs)
      ]
    )
  );
}

export function encodeCosignerData(cosignerData: CosignerData): `0x${string}` {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'decayStartBlock', type: 'uint256' },
          { name: 'exclusiveFiller', type: 'address' },
          { name: 'exclusivityOverrideBps', type: 'uint256' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'outputAmounts', type: 'uint256[]' }
        ]
      }
    ],
    [cosignerData]
  );
}

export function computeCosignerDigest(orderHash: `0x${string}`, chainId: bigint, cosignerData: CosignerData): `0x${string}` {
  return keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [orderHash, chainId, encodeCosignerData(cosignerData)]));
}
