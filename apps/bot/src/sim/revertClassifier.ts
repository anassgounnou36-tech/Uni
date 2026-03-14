import type { OrderReasonCode } from '../store/types.js';

type ClassificationSignal = {
  viemName?: string;
  rpcCode?: number;
  message?: string;
  revertData?: `0x${string}`;
  receiptStatus?: 'success' | 'reverted';
};

const CLASSIFICATION_PATTERNS: Array<{ code: OrderReasonCode; pattern: RegExp }> = [
  { code: 'SIM_INVALID_ORDER', pattern: /(invalid order|malformed order|bad order|order validation failed)/i },
  { code: 'SIM_EXPIRED', pattern: /expired|deadline|stale|timestamp/i },
  { code: 'SIM_UNSUPPORTED_SHAPE', pattern: /unsupported shape|mismatch|token mismatch/i },
  { code: 'SIM_NO_ROUTE', pattern: /no route|pool not found|routeable/i },
  { code: 'SIM_SLIPPAGE', pattern: /slippage|too little received|min amount/i },
  { code: 'SIM_GAS_TOO_HIGH', pattern: /gas too high|out of gas|intrinsic gas/i },
  { code: 'SIM_NONCE_OR_SEND', pattern: /nonce|replacement underpriced|already known|sendrawtransaction/i },
  { code: 'SIM_RACE_OR_LOST', pattern: /already filled|race|lost|conflict/i }
];

export function classifyRevertReason(reason: unknown): OrderReasonCode {
  const signal = normalizeSignal(reason);
  if (signal.receiptStatus === 'success') {
    return 'SUPPORTED';
  }

  if (signal.receiptStatus === 'reverted' && !signal.message) {
    return 'UNKNOWN';
  }

  const text = `${signal.viemName ?? ''} ${signal.rpcCode ?? ''} ${signal.message ?? ''} ${signal.revertData ?? ''}`.trim();
  if (!text) {
    return 'UNKNOWN';
  }

  for (const { code, pattern } of CLASSIFICATION_PATTERNS) {
    if (pattern.test(text)) {
      return code;
    }
  }

  return 'UNKNOWN';
}

function normalizeSignal(reason: unknown): ClassificationSignal {
  if (!reason) {
    return {};
  }
  if (typeof reason === 'string') {
    return { message: reason };
  }
  if (reason instanceof Error) {
    const maybe = reason as Error & { code?: number; details?: string; data?: `0x${string}` };
    return {
      viemName: reason.name,
      message: `${reason.message} ${maybe.details ?? ''}`.trim(),
      rpcCode: maybe.code,
      revertData: maybe.data
    };
  }

  const objectReason = reason as {
    name?: string;
    code?: number;
    message?: string;
    details?: string;
    data?: `0x${string}`;
    receipt?: { status?: 'success' | 'reverted' };
  };

  return {
    viemName: objectReason.name,
    rpcCode: objectReason.code,
    message: `${objectReason.message ?? ''} ${objectReason.details ?? ''}`.trim(),
    revertData: objectReason.data,
    receiptStatus: objectReason.receipt?.status
  };
}
