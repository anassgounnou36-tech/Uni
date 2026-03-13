import type { SignedV3DutchOrder } from '@uni/protocol';
import type { OrderState } from '../domain/orderState.js';

export type OrderReasonCode =
  | 'SUPPORTED'
  | 'NOT_DUTCH_V3'
  | 'EXOTIC_OUTPUT_SHAPE'
  | 'OUTPUT_TOKEN_MISMATCH'
  | 'TOKEN_PAIR_NOT_ALLOWLISTED'
  | 'NOT_ROUTEABLE'
  | 'NOT_PROFITABLE'
  | 'DECODE_FAILED'
  | 'MISSING_ORDER_HASH'
  | 'SCHEDULER_NO_EDGE'
  | 'SIM_INVALID_ORDER'
  | 'SIM_EXPIRED'
  | 'SIM_UNSUPPORTED_SHAPE'
  | 'SIM_NO_ROUTE'
  | 'SIM_SLIPPAGE'
  | 'SIM_NOT_PROFITABLE'
  | 'SIM_GAS_TOO_HIGH'
  | 'SIM_NONCE_OR_SEND'
  | 'SIM_RACE_OR_LOST'
  | 'SHADOW_MODE'
  | 'UNKNOWN';

export type NormalizedOrder = {
  orderHash: `0x${string}`;
  orderType: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  decodedOrder: SignedV3DutchOrder;
};

export type StoredTransition = {
  state: OrderState;
  at: number;
  reason?: OrderReasonCode;
};

export type StoredOrderRecord = {
  orderHash: `0x${string}`;
  rawPayload: unknown;
  normalizedOrder?: NormalizedOrder;
  state: OrderState;
  reason?: OrderReasonCode;
  transitions: StoredTransition[];
  createdAt: number;
  updatedAt: number;
};

export type UpsertResult = {
  created: boolean;
  record: StoredOrderRecord;
};

export interface OrderStore {
  upsertDiscovered(rawPayload: unknown, normalizedOrder: NormalizedOrder | undefined, nowMs?: number): UpsertResult;
  transition(orderHash: `0x${string}`, nextState: OrderState, reason?: OrderReasonCode, nowMs?: number): StoredOrderRecord;
  get(orderHash: `0x${string}`): StoredOrderRecord | undefined;
  list(): StoredOrderRecord[];
}
