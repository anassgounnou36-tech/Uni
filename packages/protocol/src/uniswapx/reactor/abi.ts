import { encodeFunctionData, parseAbi } from 'viem';
import type { Hex } from 'viem';
import type { ReactorSignedOrder } from './types.js';

export const REACTOR_ABI = parseAbi([
  'function execute((bytes order, bytes sig) order)',
  'function executeWithCallback((bytes order, bytes sig) order, bytes callbackData)',
  'function executeBatch((bytes order, bytes sig)[] orders)',
  'function executeBatchWithCallback((bytes order, bytes sig)[] orders, bytes callbackData)'
]);

export function toReactorSignedOrder(encodedOrder: Hex, signature: Hex): ReactorSignedOrder {
  return {
    order: encodedOrder as `0x${string}`,
    sig: signature as `0x${string}`
  };
}

export function encodeExecute(order: ReactorSignedOrder): Hex {
  return encodeFunctionData({
    abi: REACTOR_ABI,
    functionName: 'execute',
    args: [order]
  });
}

export function encodeExecuteWithCallback(order: ReactorSignedOrder, callbackData: Hex): Hex {
  return encodeFunctionData({
    abi: REACTOR_ABI,
    functionName: 'executeWithCallback',
    args: [order, callbackData]
  });
}

export function encodeExecuteBatchWithCallback(orders: ReactorSignedOrder[], callbackData: Hex): Hex {
  return encodeFunctionData({
    abi: REACTOR_ABI,
    functionName: 'executeBatchWithCallback',
    args: [orders, callbackData]
  });
}
