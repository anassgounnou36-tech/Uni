export const ORDER_STATES = [
  'DISCOVERED',
  'DECODED',
  'SUPPORTED',
  'DROPPED',
  'UNSUPPORTED',
  'SCHEDULED',
  'SIM_OK',
  'SIM_FAIL',
  'SUBMITTING',
  'LANDED',
  'LOST',
  'EXPIRED',
  'CANCELED',
  'REVERTED'
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export type OrderTerminalState = Extract<OrderState, 'DROPPED' | 'UNSUPPORTED' | 'LANDED' | 'LOST' | 'EXPIRED' | 'CANCELED' | 'REVERTED'>;

const LEGAL_TRANSITIONS: Record<OrderState, ReadonlySet<OrderState>> = {
  DISCOVERED: new Set(['DECODED', 'UNSUPPORTED', 'EXPIRED', 'CANCELED']),
  DECODED: new Set(['SUPPORTED', 'UNSUPPORTED', 'EXPIRED', 'CANCELED']),
  SUPPORTED: new Set(['SCHEDULED', 'DROPPED', 'UNSUPPORTED', 'EXPIRED', 'CANCELED']),
  DROPPED: new Set([]),
  UNSUPPORTED: new Set([]),
  SCHEDULED: new Set(['SIM_OK', 'SIM_FAIL', 'DROPPED', 'EXPIRED', 'CANCELED', 'LOST']),
  SIM_OK: new Set(['SUBMITTING', 'SCHEDULED', 'DROPPED', 'EXPIRED', 'LOST']),
  SIM_FAIL: new Set(['SCHEDULED', 'DROPPED', 'EXPIRED', 'CANCELED']),
  SUBMITTING: new Set(['LANDED', 'LOST', 'REVERTED']),
  LANDED: new Set([]),
  LOST: new Set([]),
  EXPIRED: new Set([]),
  CANCELED: new Set([]),
  REVERTED: new Set([])
};

export function canTransitionOrderState(from: OrderState, to: OrderState): boolean {
  return from === to || LEGAL_TRANSITIONS[from].has(to);
}

export function assertLegalOrderTransition(from: OrderState, to: OrderState): void {
  if (!canTransitionOrderState(from, to)) {
    throw new Error(`Illegal order transition: ${from} -> ${to}`);
  }
}
