export const PREPARE_FAILURE_REASONS = [
  'PREPARE_PLAN_INVALID',
  'PREPARE_CALL_REVERTED',
  'PREPARE_ESTIMATE_GAS_FAILED',
  'PREPARE_STALE_PLAN',
  'PREPARE_TX_BUILD_FAILED',
  'PREPARE_SIGN_FAILED'
] as const;

export type PrepareFailureReason = (typeof PREPARE_FAILURE_REASONS)[number];

export type PrepareFailureContext = {
  reason: PrepareFailureReason;
  errorCategory: string;
  errorMessage: string;
  errorSelector?: `0x${string}`;
  decodedErrorName?: string;
  preflightStage?: 'validate' | 'call' | 'estimate_gas' | 'staleness' | 'tx_build' | 'sign';
  venue?: 'UNISWAP_V3' | 'CAMELOT_AMMV3' | 'LFJ_LB';
  pathKind?: 'DIRECT' | 'TWO_HOP';
  executionMode?: 'EXACT_INPUT' | 'EXACT_OUTPUT';
};

export class PrepareFailureError extends Error {
  readonly reason: PrepareFailureReason;
  readonly errorCategory: string;
  readonly errorMessage: string;
  readonly errorSelector?: `0x${string}`;
  readonly decodedErrorName?: string;
  readonly preflightStage?: 'validate' | 'call' | 'estimate_gas' | 'staleness' | 'tx_build' | 'sign';
  readonly venue?: 'UNISWAP_V3' | 'CAMELOT_AMMV3' | 'LFJ_LB';
  readonly pathKind?: 'DIRECT' | 'TWO_HOP';
  readonly executionMode?: 'EXACT_INPUT' | 'EXACT_OUTPUT';

  constructor(context: PrepareFailureContext) {
    super(context.errorMessage);
    this.name = 'PrepareFailureError';
    this.reason = context.reason;
    this.errorCategory = context.errorCategory;
    this.errorMessage = context.errorMessage;
    this.errorSelector = context.errorSelector;
    this.decodedErrorName = context.decodedErrorName;
    this.preflightStage = context.preflightStage;
    this.venue = context.venue;
    this.pathKind = context.pathKind;
    this.executionMode = context.executionMode;
  }
}
