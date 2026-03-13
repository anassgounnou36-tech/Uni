export type ReplacementIntent = 'new' | 'replace' | 'cancel';

export type ReplacementRecord = {
  orderId: string;
  account: `0x${string}`;
  nonce: bigint;
  intent: ReplacementIntent;
  at: number;
};

export type ReplacementDecision =
  | { allowed: true; duplicatePrevented: boolean; record: ReplacementRecord }
  | { allowed: false; reason: 'DUPLICATE_ORDER_SEND' | 'NONCE_IN_USE_REQUIRES_REPLACEMENT' | 'UNKNOWN_ORDER_FOR_REPLACEMENT' };

function nonceKey(account: `0x${string}`, nonce: bigint): string {
  return `${account.toLowerCase()}:${nonce.toString()}`;
}

export class ReplacementPolicy {
  private readonly activeByOrder = new Map<string, ReplacementRecord>();
  private readonly activeByNonce = new Map<string, ReplacementRecord>();
  private readonly history: ReplacementRecord[] = [];

  reserve(orderId: string, account: `0x${string}`, nonce: bigint, intent: ReplacementIntent, atMs?: number): ReplacementDecision {
    const existingForOrder = this.activeByOrder.get(orderId);
    if (existingForOrder && intent === 'new') {
      return { allowed: false, reason: 'DUPLICATE_ORDER_SEND' };
    }

    if ((intent === 'replace' || intent === 'cancel') && !existingForOrder) {
      return { allowed: false, reason: 'UNKNOWN_ORDER_FOR_REPLACEMENT' };
    }

    const key = nonceKey(account, nonce);
    const existingForNonce = this.activeByNonce.get(key);
    if (existingForNonce && existingForNonce.orderId !== orderId && intent === 'new') {
      return { allowed: false, reason: 'NONCE_IN_USE_REQUIRES_REPLACEMENT' };
    }

    const record: ReplacementRecord = {
      orderId,
      account,
      nonce,
      intent,
      at: atMs ?? Date.now()
    };
    this.activeByOrder.set(orderId, record);
    this.activeByNonce.set(key, record);
    this.history.push(record);
    return {
      allowed: true,
      duplicatePrevented: Boolean(existingForOrder && intent === 'replace'),
      record
    };
  }

  settle(orderId: string): void {
    const active = this.activeByOrder.get(orderId);
    if (!active) {
      return;
    }
    this.activeByOrder.delete(orderId);
    this.activeByNonce.delete(nonceKey(active.account, active.nonce));
  }

  getHistory(): ReplacementRecord[] {
    return [...this.history];
  }
}
