export type ExactOutputViabilityStatus =
  | 'SATISFIABLE'
  | 'UNSATISFIABLE'
  | 'QUOTE_FAILED'
  | 'POOL_MISSING'
  | 'NOT_CHECKED';

export type ExactOutputViability = {
  status: ExactOutputViabilityStatus;
  targetOutput: bigint;
  requiredInputForTargetOutput: bigint;
  availableInput: bigint;
  inputDeficit?: bigint;
  inputSlack?: bigint;
  checkedFeeTier?: number;
  reason: string;
};
