import { ReplacementPolicy, type ReplacementIntent } from './replacementPolicy.js';
import type { SqlAdapter } from '../db/types.js';

export type NonceLease = {
  account: `0x${string}`;
  nonce: bigint;
  orderId: string;
  leasedAtMs: number;
};

export type NonceLedgerEvent = 'LEASED' | 'BROADCAST' | 'LANDED' | 'REPLACED' | 'CANCELED' | 'RELEASED';

export interface NonceLedger {
  readNextNonce(account: `0x${string}`): Promise<bigint | undefined>;
  writeNextNonce(account: `0x${string}`, nonce: bigint, event: NonceLedgerEvent, orderId: string): Promise<void>;
}

export class InMemoryNonceLedger implements NonceLedger {
  private readonly nextNonces = new Map<string, bigint>();
  private readonly events: Array<{ account: `0x${string}`; nonce: bigint; event: NonceLedgerEvent; orderId: string }> = [];

  async readNextNonce(account: `0x${string}`): Promise<bigint | undefined> {
    return this.nextNonces.get(account.toLowerCase());
  }

  async writeNextNonce(account: `0x${string}`, nonce: bigint, event: NonceLedgerEvent, orderId: string): Promise<void> {
    this.nextNonces.set(account.toLowerCase(), nonce);
    this.events.push({ account, nonce, event, orderId });
  }

  getEvents(): ReadonlyArray<{ account: `0x${string}`; nonce: bigint; event: NonceLedgerEvent; orderId: string }> {
    return this.events;
  }
}

export class PostgresNonceLedger implements NonceLedger {
  constructor(private readonly sqlAdapter: SqlAdapter) {}

  async ensureSchema(): Promise<void> {
    await this.sqlAdapter.query(
      `create table if not exists nonce_ledger (
        address text primary key,
        next_nonce bigint not null,
        updated_at_ms bigint not null
      )`
    );
  }

  async readNextNonce(account: `0x${string}`): Promise<bigint | undefined> {
    const result = await this.sqlAdapter.query<{ next_nonce: string | number }>(
      'select next_nonce from nonce_ledger where lower(address) = lower($1) limit 1',
      [account]
    );
    const row = result.rows[0];
    if (!row?.next_nonce) {
      return undefined;
    }
    return BigInt(row.next_nonce);
  }

  async writeNextNonce(account: `0x${string}`, nonce: bigint, _event: NonceLedgerEvent, _orderId: string): Promise<void> {
    await this.sqlAdapter.query(
      `insert into nonce_ledger(address, next_nonce, updated_at_ms)
       values ($1, $2, $3)
       on conflict (address)
       do update set next_nonce = excluded.next_nonce, updated_at_ms = excluded.updated_at_ms`,
      [account, nonce.toString(), Date.now()]
    );
  }
}

export type NonceManagerConfig = {
  ledger: NonceLedger;
  chainNonceReader: (account: `0x${string}`) => Promise<bigint>;
};

export class NonceManager {
  private readonly replacementPolicy = new ReplacementPolicy();
  private readonly inflightByAccount = new Map<string, NonceLease>();

  constructor(private readonly config: NonceManagerConfig) {}

  private canLeaseForOrder(inflight: NonceLease | undefined, orderId: string, intent: ReplacementIntent): boolean {
    if (!inflight) {
      return true;
    }
    if (inflight.orderId === orderId) {
      return true;
    }
    return intent !== 'new';
  }

  async lease(
    account: `0x${string}`,
    orderId: string,
    intent: ReplacementIntent = 'new',
    nowMs: number = Date.now()
  ): Promise<NonceLease> {
    const accountKey = account.toLowerCase();
    const inflight = this.inflightByAccount.get(accountKey);
    if (!this.canLeaseForOrder(inflight, orderId, intent)) {
      throw new Error('NONCE_LEASE_IN_FLIGHT');
    }

    const nextNonce = await this.allocateNonce(account);
    const replacement = this.replacementPolicy.reserve(orderId, account, nextNonce, intent, nowMs);
    if (!replacement.allowed) {
      throw new Error(replacement.reason);
    }

    const lease: NonceLease = { account, nonce: nextNonce, orderId, leasedAtMs: nowMs };
    this.inflightByAccount.set(accountKey, lease);
    await this.config.ledger.writeNextNonce(account, nextNonce, 'LEASED', orderId);
    return lease;
  }

  async markBroadcastAccepted(lease: NonceLease): Promise<void> {
    await this.config.ledger.writeNextNonce(lease.account, lease.nonce + 1n, 'BROADCAST', lease.orderId);
  }

  async markLanded(lease: NonceLease): Promise<void> {
    this.inflightByAccount.delete(lease.account.toLowerCase());
    this.replacementPolicy.settle(lease.orderId);
    await this.config.ledger.writeNextNonce(lease.account, lease.nonce + 1n, 'LANDED', lease.orderId);
  }

  async release(lease: NonceLease, event: 'RELEASED' | 'REPLACED' | 'CANCELED' = 'RELEASED'): Promise<void> {
    this.inflightByAccount.delete(lease.account.toLowerCase());
    const nextNonce = event === 'REPLACED' ? lease.nonce + 1n : lease.nonce;
    await this.config.ledger.writeNextNonce(lease.account, nextNonce, event, lease.orderId);
    if (event !== 'REPLACED') {
      this.replacementPolicy.settle(lease.orderId);
    }
  }

  getReplacementHistory() {
    return this.replacementPolicy.getHistory();
  }

  private async allocateNonce(account: `0x${string}`): Promise<bigint> {
    const fromLedger = await this.config.ledger.readNextNonce(account);
    if (fromLedger !== undefined) {
      return fromLedger;
    }
    return this.config.chainNonceReader(account);
  }
}
