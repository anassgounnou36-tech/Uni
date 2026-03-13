import { ReplacementPolicy, type ReplacementIntent } from './replacementPolicy.js';

export type NonceLease = {
  account: `0x${string}`;
  nonce: bigint;
  orderId: string;
  leasedAtMs: number;
};

export type NonceLedgerEvent = 'LEASED' | 'LANDED' | 'REPLACED' | 'CANCELED' | 'RELEASED';

export interface NonceLedger {
  readNextNonce(account: `0x${string}`): Promise<bigint | undefined>;
  writeNextNonce(account: `0x${string}`, nonce: bigint, event: NonceLedgerEvent, orderId: string): Promise<void>;
}

export type NonceSqlWriter = (statement: string, params: readonly unknown[]) => Promise<void>;

const NOOP_NONCE_SQL_WRITER: NonceSqlWriter = async () => {
  return;
};

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
  private readonly memory = new InMemoryNonceLedger();

  constructor(private readonly sqlWriter: NonceSqlWriter = NOOP_NONCE_SQL_WRITER) {}

  async readNextNonce(account: `0x${string}`): Promise<bigint | undefined> {
    return this.memory.readNextNonce(account);
  }

  async writeNextNonce(account: `0x${string}`, nonce: bigint, event: NonceLedgerEvent, orderId: string): Promise<void> {
    await this.memory.writeNextNonce(account, nonce, event, orderId);
    await this.sqlWriter(
      'insert into nonce_ledger(account, next_nonce, event, order_id) values ($1, $2, $3, $4)',
      [account, nonce.toString(), event, orderId]
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

  async lease(
    account: `0x${string}`,
    orderId: string,
    intent: ReplacementIntent = 'new',
    nowMs: number = Date.now()
  ): Promise<NonceLease> {
    const accountKey = account.toLowerCase();
    const inflight = this.inflightByAccount.get(accountKey);
    if (inflight && inflight.orderId !== orderId) {
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

  async markLanded(lease: NonceLease): Promise<void> {
    this.inflightByAccount.delete(lease.account.toLowerCase());
    this.replacementPolicy.settle(lease.orderId);
    await this.config.ledger.writeNextNonce(lease.account, lease.nonce + 1n, 'LANDED', lease.orderId);
  }

  async release(lease: NonceLease, event: 'RELEASED' | 'REPLACED' | 'CANCELED' = 'RELEASED'): Promise<void> {
    this.inflightByAccount.delete(lease.account.toLowerCase());
    const nextNonce = event === 'REPLACED' ? lease.nonce + 1n : lease.nonce;
    await this.config.ledger.writeNextNonce(lease.account, nextNonce, event, lease.orderId);
    if (event === 'REPLACED') {
      return;
    }
    this.replacementPolicy.settle(lease.orderId);
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
