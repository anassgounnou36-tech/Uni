import { describe, expect, it } from 'vitest';
import { deriveRejectedCandidateClass } from '../src/routing/rejectedCandidateTypes.js';

describe('deriveRejectedCandidateClass', () => {
  it('returns non-empty class for representative rejected summaries', () => {
    const results = [
      deriveRejectedCandidateClass({
        venue: 'UNISWAP_V3',
        status: 'CONSTRAINT_REJECTED',
        reason: 'PROFITABILITY_FLOOR',
        quotedAmountOut: 999n,
        constraintReason: 'PROFITABILITY_FLOOR',
        constraintBreakdown: {
          requiredOutput: 900n,
          quotedAmountOut: 999n,
          slippageBufferOut: 1n,
          gasCostOut: 1n,
          riskBufferOut: 0n,
          profitFloorOut: 0n,
          slippageFloorOut: 998n,
          profitabilityFloorOut: 1000n,
          minAmountOut: 1000n,
          requiredOutputShortfallOut: 0n,
          minAmountOutShortfallOut: 1n,
          bindingFloor: 'PROFITABILITY_FLOOR',
          nearMiss: true,
          nearMissBps: 25n
        },
        exactOutputViability: {
          status: 'SATISFIABLE',
          targetOutput: 900n,
          requiredInputForTargetOutput: 999n,
          availableInput: 1000n,
          inputDeficit: 0n,
          inputSlack: 1n,
          reason: 'satisfiable'
        }
      }),
      deriveRejectedCandidateClass({
        venue: 'UNISWAP_V3',
        status: 'CONSTRAINT_REJECTED',
        reason: 'REQUIRED_OUTPUT',
        quotedAmountOut: 890n,
        constraintReason: 'REQUIRED_OUTPUT',
        exactOutputViability: {
          status: 'UNSATISFIABLE',
          targetOutput: 900n,
          requiredInputForTargetOutput: 1001n,
          availableInput: 1000n,
          inputDeficit: 1n,
          inputSlack: 0n,
          reason: 'unsatisfiable'
        }
      }),
      deriveRejectedCandidateClass({
        venue: 'CAMELOT_AMMV3',
        status: 'NOT_ROUTEABLE',
        reason: 'POOL_MISSING'
      }),
      deriveRejectedCandidateClass({
        venue: 'CAMELOT_AMMV3',
        status: 'QUOTE_FAILED',
        reason: 'QUOTE_CALL_FAILED'
      }),
      deriveRejectedCandidateClass({
        venue: 'CAMELOT_AMMV3',
        status: 'GAS_NOT_PRICEABLE',
        reason: 'GAS_CONVERSION_FAILED'
      })
    ];

    for (const result of results) {
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toBe('UNKNOWN');
    }
  });
});
