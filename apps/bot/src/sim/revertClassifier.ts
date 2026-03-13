import type { OrderReasonCode } from '../store/types.js';

const CLASSIFICATION_PATTERNS: Array<{ code: OrderReasonCode; pattern: RegExp }> = [
  { code: 'SIM_INVALID_ORDER', pattern: /invalid|malformed|bad order/i },
  { code: 'SIM_EXPIRED', pattern: /expired|deadline/i },
  { code: 'SIM_UNSUPPORTED_SHAPE', pattern: /unsupported shape|mismatch/i },
  { code: 'SIM_NO_ROUTE', pattern: /no route|pool not found/i },
  { code: 'SIM_SLIPPAGE', pattern: /slippage|too little received/i },
  { code: 'SIM_NOT_PROFITABLE', pattern: /not profitable|negative edge/i },
  { code: 'SIM_GAS_TOO_HIGH', pattern: /gas too high|out of gas/i },
  { code: 'SIM_NONCE_OR_SEND', pattern: /nonce|replacement underpriced|send/i },
  { code: 'SIM_RACE_OR_LOST', pattern: /already filled|race|lost/i }
];

export function classifyRevertReason(reason: unknown): OrderReasonCode {
  const text = String(reason ?? '').trim();
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
