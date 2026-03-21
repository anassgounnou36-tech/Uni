import { describe, expect, it } from 'vitest';
import { deriveRejectedCandidateClass, ensureRejectedCandidateClass } from '../src/routing/rejectedCandidateTypes.js';

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

  it('never labels quote-failed or huge-gap required-output as POLICY_BLOCKED', () => {
    expect(
      deriveRejectedCandidateClass({
        venue: 'CAMELOT_AMMV3',
        status: 'CONSTRAINT_REJECTED',
        reason: 'REQUIRED_OUTPUT',
        quotedAmountOut: 500n,
        constraintReason: 'REQUIRED_OUTPUT',
        exactOutputViability: {
          status: 'QUOTE_FAILED',
          targetOutput: 900n,
          requiredInputForTargetOutput: 0n,
          availableInput: 1_000n,
          reason: 'exact-output quote failed'
        },
        hedgeGap: {
          requiredOutput: 900n,
          quotedAmountOut: 500n,
          outputCoverageBps: 5_555n,
          requiredOutputShortfallOut: 400n,
          inputDeficit: 0n,
          inputSlack: 0n,
          gapClass: 'HUGE',
          nearMiss: false,
          nearMissBps: 25n
        }
      })
    ).toBe('QUOTE_FAILED');

    expect(
      deriveRejectedCandidateClass({
        venue: 'CAMELOT_AMMV3',
        status: 'CONSTRAINT_REJECTED',
        reason: 'REQUIRED_OUTPUT',
        quotedAmountOut: 500n,
        constraintReason: 'REQUIRED_OUTPUT',
        exactOutputViability: {
          status: 'UNSATISFIABLE',
          targetOutput: 900n,
          requiredInputForTargetOutput: 1_200n,
          availableInput: 1_000n,
          inputDeficit: 200n,
          inputSlack: 0n,
          reason: 'required output unsatisfiable'
        },
        hedgeGap: {
          requiredOutput: 900n,
          quotedAmountOut: 500n,
          outputCoverageBps: 5_555n,
          requiredOutputShortfallOut: 400n,
          inputDeficit: 200n,
          inputSlack: 0n,
          gapClass: 'HUGE',
          nearMiss: false,
          nearMissBps: 25n
        }
      })
    ).toBe('LIQUIDITY_BLOCKED');
  });

  it('ensureRejectedCandidateClass always fills class for rejected summary', () => {
    const withClass = ensureRejectedCandidateClass({
      venue: 'UNISWAP_V3',
      status: 'CONSTRAINT_REJECTED',
      reason: 'REQUIRED_OUTPUT',
      constraintReason: 'REQUIRED_OUTPUT',
      candidateClass: undefined
    });
    expect(withClass.candidateClass).toBeDefined();
    expect(withClass.candidateClass.length).toBeGreaterThan(0);
  });

  it('exact_output_satisfiable_but_unprofitable_candidates_are_policy_blocked_not_liquidity_blocked', () => {
    const candidateClass = deriveRejectedCandidateClass({
      venue: 'UNISWAP_V3',
      status: 'CONSTRAINT_REJECTED',
      reason: 'PROFITABILITY_FLOOR',
      quotedAmountOut: 998n,
      constraintReason: 'REQUIRED_OUTPUT',
      constraintBreakdown: {
        requiredOutput: 999n,
        quotedAmountOut: 998n,
        slippageBufferOut: 0n,
        gasCostOut: 1n,
        riskBufferOut: 1n,
        profitFloorOut: 1n,
        slippageFloorOut: 998n,
        profitabilityFloorOut: 1001n,
        minAmountOut: 1001n,
        requiredOutputShortfallOut: 1n,
        minAmountOutShortfallOut: 3n,
        bindingFloor: 'PROFITABILITY_FLOOR',
        nearMiss: true,
        nearMissBps: 25n
      },
      exactOutputViability: {
        status: 'SATISFIABLE',
        targetOutput: 999n,
        requiredInputForTargetOutput: 1000n,
        availableInput: 1000n,
        inputDeficit: 0n,
        inputSlack: 0n,
        reason: 'required output satisfiable with available input'
      }
    });
    expect(candidateClass).toBe('POLICY_BLOCKED');
  });
});
