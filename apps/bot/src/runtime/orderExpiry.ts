import type { StoredOrderRecord } from '../store/types.js';
import { decodeExecutionError } from '../execution/errorDecode.js';

function nowEpochSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function isOrderExpiredForLifecycle(record: StoredOrderRecord, timestampSec: bigint = nowEpochSeconds()): boolean {
  const deadline = record.normalizedOrder?.decodedOrder.order.info.deadline;
  if (deadline === undefined) {
    return false;
  }
  return deadline <= timestampSec;
}

export function isDeadlineReachedError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message.includes('DeadlineReached') || error.message.toLowerCase().includes('deadline reached')) {
      return true;
    }
  }
  const decoded = decodeExecutionError(error);
  return decoded.decodedErrorName === 'DeadlineReached';
}
