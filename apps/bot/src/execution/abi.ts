import { parseAbi } from 'viem';

export const EXECUTOR_ABI = parseAbi(['function execute((bytes order, bytes sig) order, bytes callbackData)']);
