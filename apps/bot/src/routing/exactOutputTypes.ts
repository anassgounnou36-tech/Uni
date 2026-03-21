import type { Address } from 'viem';
import type { RoutePathKind } from './pathTypes.js';

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
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: Address;
  pathDescriptor?: string;
  reason: string;
};
