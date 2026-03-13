export type RiskConfig = {
  globalPause: boolean;
  tokenAllowlist?: ReadonlySet<string>;
  tokenDenylist?: ReadonlySet<string>;
  maxNotionalPerTrade: bigint;
  maxGas: bigint;
  maxConcurrentInflight: number;
  maxAttemptsPerOrder: number;
  orderTtlMs: number;
  minProfit: bigint;
  minConfidence: number;
  maxRiskBufferBps: number;
};

export type RiskInput = {
  inputToken: `0x${string}`;
  outputToken: `0x${string}`;
  notional: bigint;
  gas: bigint;
  concurrentInflight: number;
  attempts: number;
  createdAtMs: number;
  nowMs: number;
  expectedProfit: bigint;
  confidence: number;
  riskBufferBps: number;
};

export type RiskDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'GLOBAL_PAUSE'
        | 'TOKEN_DENYLISTED'
        | 'TOKEN_NOT_ALLOWLISTED'
        | 'MAX_NOTIONAL_EXCEEDED'
        | 'MAX_GAS_EXCEEDED'
        | 'MAX_INFLIGHT_EXCEEDED'
        | 'MAX_ATTEMPTS_EXCEEDED'
        | 'ORDER_TTL_EXPIRED'
        | 'MIN_PROFIT_NOT_MET'
        | 'MIN_CONFIDENCE_NOT_MET'
        | 'MAX_RISK_BUFFER_EXCEEDED';
    };

function normalize(address: `0x${string}`): string {
  return address.toLowerCase();
}

export class RiskEngine {
  constructor(private readonly config: RiskConfig) {}

  evaluate(input: RiskInput): RiskDecision {
    if (this.config.globalPause) {
      return { allowed: false, reason: 'GLOBAL_PAUSE' };
    }
    if (this.config.tokenDenylist?.has(normalize(input.inputToken)) || this.config.tokenDenylist?.has(normalize(input.outputToken))) {
      return { allowed: false, reason: 'TOKEN_DENYLISTED' };
    }
    if (
      this.config.tokenAllowlist &&
      (!this.config.tokenAllowlist.has(normalize(input.inputToken)) || !this.config.tokenAllowlist.has(normalize(input.outputToken)))
    ) {
      return { allowed: false, reason: 'TOKEN_NOT_ALLOWLISTED' };
    }
    if (input.notional > this.config.maxNotionalPerTrade) {
      return { allowed: false, reason: 'MAX_NOTIONAL_EXCEEDED' };
    }
    if (input.gas > this.config.maxGas) {
      return { allowed: false, reason: 'MAX_GAS_EXCEEDED' };
    }
    if (input.concurrentInflight >= this.config.maxConcurrentInflight) {
      return { allowed: false, reason: 'MAX_INFLIGHT_EXCEEDED' };
    }
    if (input.attempts >= this.config.maxAttemptsPerOrder) {
      return { allowed: false, reason: 'MAX_ATTEMPTS_EXCEEDED' };
    }
    if (input.nowMs - input.createdAtMs > this.config.orderTtlMs) {
      return { allowed: false, reason: 'ORDER_TTL_EXPIRED' };
    }
    if (input.expectedProfit < this.config.minProfit) {
      return { allowed: false, reason: 'MIN_PROFIT_NOT_MET' };
    }
    if (input.confidence < this.config.minConfidence) {
      return { allowed: false, reason: 'MIN_CONFIDENCE_NOT_MET' };
    }
    if (input.riskBufferBps > this.config.maxRiskBufferBps) {
      return { allowed: false, reason: 'MAX_RISK_BUFFER_EXCEEDED' };
    }
    return { allowed: true };
  }
}
