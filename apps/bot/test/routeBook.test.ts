import { describe, expect, it } from 'vitest';
import { RouteBook } from '../src/routing/routeBook.js';
import type { HedgeRoutePlan } from '../src/routing/venues.js';
import type { VenueRouteAttemptSummary } from '../src/routing/attemptTypes.js';
import type { ConstraintBreakdown } from '../src/routing/constraintTypes.js';

function makeRoute(venue: 'UNISWAP_V3' | 'CAMELOT_AMMV3', overrides: Partial<HedgeRoutePlan> = {}): HedgeRoutePlan {
  return {
    venue,
    executionMode: 'EXACT_INPUT',
    pathKind: 'DIRECT',
    hopCount: 1,
    pathDirection: 'FORWARD',
    tokenIn: '0x0000000000000000000000000000000000000001',
    tokenOut: '0x0000000000000000000000000000000000000002',
    amountIn: 1_000n,
    requiredOutput: 900n,
    quotedAmountOut: 1_000n,
    minAmountOut: 950n,
    limitSqrtPriceX96: 0n,
    grossEdgeOut: 100n,
    slippageBufferOut: 5n,
    gasCostOut: 10n,
    riskBufferOut: 1n,
    profitFloorOut: 1n,
    netEdgeOut: 83n,
    quoteMetadata:
      venue === 'UNISWAP_V3'
        ? { venue: 'UNISWAP_V3', poolFee: 500 }
        : { venue: 'CAMELOT_AMMV3', observedFee: 30 },
    ...overrides
  };
}

function venueSummary(
  venue: 'UNISWAP_V3' | 'CAMELOT_AMMV3',
  status: VenueRouteAttemptSummary['status'],
  overrides: Partial<VenueRouteAttemptSummary> = {}
): VenueRouteAttemptSummary {
  return {
    venue,
    status,
    reason: status,
    ...overrides
  };
}

function constraintBreakdown(overrides: Partial<ConstraintBreakdown> = {}): ConstraintBreakdown {
  return {
    requiredOutput: 900n,
    quotedAmountOut: 890n,
    slippageBufferOut: 1n,
    gasCostOut: 1n,
    riskBufferOut: 0n,
    profitFloorOut: 0n,
    slippageFloorOut: 889n,
    profitabilityFloorOut: 901n,
    minAmountOut: 901n,
    requiredOutputShortfallOut: 10n,
    minAmountOutShortfallOut: 11n,
    bindingFloor: 'PROFITABILITY_FLOOR',
    nearMiss: false,
    nearMissBps: 25n,
    ...overrides
  };
}

describe('RouteBook', () => {
  it('routebook_can_choose_two_hop_over_direct_when_better', async () => {
    const twoHop = makeRoute('UNISWAP_V3', {
      pathKind: 'TWO_HOP',
      hopCount: 2,
      bridgeToken: '0x000000000000000000000000000000000000000b',
      encodedPath: '0x01',
      netEdgeOut: 25n
    });
    const direct = makeRoute('CAMELOT_AMMV3', { pathKind: 'DIRECT', hopCount: 1, netEdgeOut: 10n });
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: twoHop,
          summary: venueSummary('UNISWAP_V3', 'ROUTEABLE', { netEdgeOut: 25n, pathKind: 'TWO_HOP', hopCount: 2 })
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: direct,
          summary: venueSummary('CAMELOT_AMMV3', 'ROUTEABLE', { netEdgeOut: 10n, pathKind: 'DIRECT', hopCount: 1 })
        })
      },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: { input: { token: twoHop.tokenIn, amount: 1_000n }, outputs: [{ token: twoHop.tokenOut, amount: 900n }] } as never
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.chosenRoute.pathKind).toBe('TWO_HOP');
    expect(selected.chosenRoute.hopCount).toBe(2);
  });

  it('routebook_can_choose_exact_output_candidate_over_rejected_exact_input_near_miss', async () => {
    const exactOutputRoute = makeRoute('UNISWAP_V3', {
      executionMode: 'EXACT_OUTPUT',
      quotedAmountOut: 1_020n,
      netEdgeOut: 20n,
      grossEdgeOut: 30n
    });
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: exactOutputRoute,
          summary: venueSummary('UNISWAP_V3', 'ROUTEABLE', {
            executionMode: 'EXACT_OUTPUT',
            netEdgeOut: 20n
          })
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'CONSTRAINT_REJECTED', {
              executionMode: 'EXACT_INPUT',
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ nearMiss: true }),
              exactOutputViability: {
                status: 'SATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 999n,
                availableInput: 1_000n,
                inputDeficit: 0n,
                inputSlack: 1n,
                reason: 'required output satisfiable with available input'
              }
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: { input: { token: exactOutputRoute.tokenIn, amount: 1_000n }, outputs: [{ token: exactOutputRoute.tokenOut, amount: 900n }] } as never
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.chosenRoute.executionMode).toBe('EXACT_OUTPUT');
  });

  it('routeBookChoosesHigherNetEdgeVenue', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: makeRoute('UNISWAP_V3', { netEdgeOut: 10n }),
          summary: venueSummary('UNISWAP_V3', 'ROUTEABLE', { netEdgeOut: 10n })
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: makeRoute('CAMELOT_AMMV3', { netEdgeOut: 20n }),
          summary: venueSummary('CAMELOT_AMMV3', 'ROUTEABLE', { netEdgeOut: 20n })
        })
      },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: { input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n }, outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }] } as never
    });

    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.chosenRoute.venue).toBe('CAMELOT_AMMV3');
      expect(selected.chosenSummary.venue).toBe('CAMELOT_AMMV3');
      expect(selected.venueAttempts).toHaveLength(2);
    }
  });

  it('routeBookTieBreaksDeterministically', async () => {
    const tieRoute = makeRoute('UNISWAP_V3', { netEdgeOut: 10n, quotedAmountOut: 100n, minAmountOut: 50n, gasCostOut: 5n });
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: tieRoute,
          summary: venueSummary('UNISWAP_V3', 'ROUTEABLE', { netEdgeOut: 10n })
        })
      },
      camelotAmmv3: {
        planBestRoute: async () =>
          ({
            ok: true as const,
            route: makeRoute('CAMELOT_AMMV3', { netEdgeOut: 10n, quotedAmountOut: 100n, minAmountOut: 50n, gasCostOut: 5n }),
            summary: venueSummary('CAMELOT_AMMV3', 'ROUTEABLE', { netEdgeOut: 10n })
          })
      },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: { input: { token: tieRoute.tokenIn, amount: 1_000n }, outputs: [{ token: tieRoute.tokenOut, amount: 900n }] } as never
    });

    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.chosenRoute.venue).toBe('UNISWAP_V3');
    }
  });

  it('camelotDisabledSkipsVenue', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: makeRoute('UNISWAP_V3'),
          summary: venueSummary('UNISWAP_V3', 'ROUTEABLE')
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: true as const,
          route: makeRoute('CAMELOT_AMMV3', { netEdgeOut: 999n }),
          summary: venueSummary('CAMELOT_AMMV3', 'ROUTEABLE')
        })
      },
      enableCamelotAmmv3: false
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.chosenRoute.venue).toBe('UNISWAP_V3');
      expect(selected.alternativeRoutes.find((summary) => summary.venue === 'CAMELOT_AMMV3')?.reason).toBe('CAMELOT_DISABLED');
    }
  });

  it('routeBookFailureReasonSeparatesRouteabilityFromProfitability', async () => {
    const noPoolRouteBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_ROUTEABLE' as const,
            details: 'no quote',
            summary: venueSummary('UNISWAP_V3', 'NOT_ROUTEABLE', { reason: 'POOL_MISSING' })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_ROUTEABLE' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'NOT_ROUTEABLE', { reason: 'POOL_MISSING' })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const unprofitableRouteBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_PROFITABLE' as const,
            details: 'negative edge',
            summary: venueSummary('UNISWAP_V3', 'NOT_PROFITABLE', {
              reason: 'NET_EDGE_NON_POSITIVE',
              quotedAmountOut: 1000n,
              minAmountOut: 900n,
              netEdgeOut: -1n
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_PROFITABLE' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'NOT_PROFITABLE', {
              reason: 'NET_EDGE_NON_POSITIVE',
              quotedAmountOut: 999n,
              minAmountOut: 900n,
              netEdgeOut: -2n
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const input = {
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    };

    const noPool = await noPoolRouteBook.selectBestRoute(input);
    const unprofitable = await unprofitableRouteBook.selectBestRoute(input);

    expect(noPool.ok).toBe(false);
    if (!noPool.ok) {
      expect(noPool.reason).toBe('NOT_ROUTEABLE');
    }
    expect(unprofitable.ok).toBe(false);
    if (!unprofitable.ok) {
      expect(unprofitable.reason).toBe('NOT_PROFITABLE');
    }
  });

  it('routeBookKeepsNotRouteableWhenOnlyQuoteFailuresAndMissingPools', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_ROUTEABLE' as const,
            details: 'no successful quote',
            summary: venueSummary('UNISWAP_V3', 'NOT_ROUTEABLE', {
              reason: 'POOL_OR_QUOTE_UNAVAILABLE',
              quoteCount: 0,
              feeTierAttempts: [
                {
                  feeTier: 500,
                  poolExists: false,
                  quoteSucceeded: false,
                  status: 'NOT_ROUTEABLE',
                  reason: 'POOL_MISSING'
                },
                {
                  feeTier: 3000,
                  poolExists: true,
                  quoteSucceeded: false,
                  status: 'QUOTE_FAILED',
                  reason: 'READ_ERROR'
                },
                {
                  feeTier: 10000,
                  poolExists: false,
                  quoteSucceeded: false,
                  status: 'NOT_ROUTEABLE',
                  reason: 'POOL_MISSING'
                }
              ]
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'QUOTE_FAILED' as const,
            details: 'call failed',
            summary: venueSummary('CAMELOT_AMMV3', 'QUOTE_FAILED', { reason: 'QUOTE_CALL_FAILED' })
          }
        })
      },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.reason).toBe('NOT_ROUTEABLE');
    }
  });

  it('routeBook can fail with CONSTRAINT_REJECTED and preserve breakdown', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            details: 'below required output',
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 890n,
              minAmountOut: 901n,
              grossEdgeOut: -10n,
              netEdgeOut: -12n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown()
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_ROUTEABLE' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'NOT_ROUTEABLE', { reason: 'POOL_MISSING' })
          }
        })
      },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.reason).toBe('CONSTRAINT_REJECTED');
    const uniSummary = selected.alternativeRoutes.find((route) => route.venue === 'UNISWAP_V3');
    expect(uniSummary?.reason).toBe('CONSTRAINT_REJECTED');
    expect(uniSummary?.reason).not.toBe('NOT_PROFITABLE');
    expect(selected.bestRejectedSummary?.constraintReason).toBe('REQUIRED_OUTPUT');
    expect(selected.bestRejectedSummary?.constraintBreakdown?.requiredOutputShortfallOut).toBeGreaterThan(0n);
    expect(selected.bestRejectedSummary?.constraintBreakdown?.minAmountOutShortfallOut).toBeGreaterThan(0n);
  });

  it('selects REQUIRED_OUTPUT best rejected with smallest input deficit', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 890n,
              minAmountOut: 901n,
              netEdgeOut: -1n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ requiredOutputShortfallOut: 10n }),
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_010n,
                availableInput: 1_000n,
                inputDeficit: 10n,
                inputSlack: 0n,
                reason: 'required output unsatisfiable'
              },
              hedgeGap: {
                requiredOutput: 900n,
                quotedAmountOut: 890n,
                outputCoverageBps: 9_888n,
                requiredOutputShortfallOut: 10n,
                minAmountOutShortfallOut: 11n,
                inputDeficit: 10n,
                inputSlack: 0n,
                gapClass: 'MEDIUM',
                nearMiss: false,
                nearMissBps: 25n
              }
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 895n,
              minAmountOut: 901n,
              netEdgeOut: -2n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ quotedAmountOut: 895n, requiredOutputShortfallOut: 5n }),
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_002n,
                availableInput: 1_000n,
                inputDeficit: 2n,
                inputSlack: 0n,
                reason: 'required output unsatisfiable'
              },
              hedgeGap: {
                requiredOutput: 900n,
                quotedAmountOut: 895n,
                outputCoverageBps: 9_944n,
                requiredOutputShortfallOut: 5n,
                minAmountOutShortfallOut: 6n,
                inputDeficit: 2n,
                inputSlack: 0n,
                gapClass: 'MEDIUM',
                nearMiss: true,
                nearMissBps: 25n
              }
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.venue).toBe('CAMELOT_AMMV3');
    expect(selected.bestRejectedSummary?.hedgeGap?.inputDeficit).toBe(2n);
  });

  it('prefers REQUIRED_OUTPUT SATISFIABLE over UNSATISFIABLE for best rejected', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 899n,
              netEdgeOut: -1n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ quotedAmountOut: 899n, requiredOutputShortfallOut: 1n }),
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_001n,
                availableInput: 1_000n,
                inputDeficit: 1n,
                inputSlack: 0n,
                reason: 'required output unsatisfiable'
              }
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 898n,
              netEdgeOut: -2n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ quotedAmountOut: 898n, requiredOutputShortfallOut: 2n }),
              exactOutputViability: {
                status: 'SATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 999n,
                availableInput: 1_000n,
                inputDeficit: 0n,
                inputSlack: 1n,
                reason: 'required output satisfiable'
              }
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.venue).toBe('CAMELOT_AMMV3');
    expect(selected.bestRejectedSummary?.exactOutputViability?.status).toBe('SATISFIABLE');
  });

  it('prefers REQUIRED_OUTPUT SATISFIABLE venue regardless of quoted amount ordering', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 898n,
              netEdgeOut: -2n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ quotedAmountOut: 898n, requiredOutputShortfallOut: 2n }),
              exactOutputViability: {
                status: 'SATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 999n,
                availableInput: 1_000n,
                inputDeficit: 0n,
                inputSlack: 1n,
                reason: 'required output satisfiable'
              }
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 899n,
              netEdgeOut: -1n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ quotedAmountOut: 899n, requiredOutputShortfallOut: 1n }),
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_001n,
                availableInput: 1_000n,
                inputDeficit: 1n,
                inputSlack: 0n,
                reason: 'required output unsatisfiable'
              }
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.venue).toBe('UNISWAP_V3');
    expect(selected.bestRejectedSummary?.exactOutputViability?.status).toBe('SATISFIABLE');
  });

  it('bestRejected_prefers_policy_blocked_near_miss_over_liquidity_blocked_unsatisfiable', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'PROFITABILITY_FLOOR',
              candidateClass: 'POLICY_BLOCKED',
              quotedAmountOut: 899n,
              netEdgeOut: -1n,
              constraintReason: 'PROFITABILITY_FLOOR',
              constraintBreakdown: constraintBreakdown({
                bindingFloor: 'PROFITABILITY_FLOOR',
                nearMiss: true,
                minAmountOutShortfallOut: 1n
              })
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              candidateClass: 'LIQUIDITY_BLOCKED',
              quotedAmountOut: 890n,
              netEdgeOut: -2n,
              constraintReason: 'REQUIRED_OUTPUT',
              constraintBreakdown: constraintBreakdown({ requiredOutputShortfallOut: 10n, minAmountOutShortfallOut: 10n }),
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1001n,
                availableInput: 1000n,
                inputDeficit: 1n,
                inputSlack: 0n,
                reason: 'required output unsatisfiable'
              }
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.candidateClass).toBe('POLICY_BLOCKED');
    expect(selected.bestRejectedSummary?.venue).toBe('UNISWAP_V3');
  });

  it('routeBook_preserves_candidateClass', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'QUOTE_FAILED' as const,
            summary: venueSummary('UNISWAP_V3', 'QUOTE_FAILED', {
              reason: 'READ_ERROR',
              candidateClass: 'QUOTE_FAILED'
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_ROUTEABLE' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'NOT_ROUTEABLE', {
              reason: 'POOL_MISSING',
              candidateClass: 'ROUTE_MISSING'
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.candidateClass).toBeDefined();
  });

  it('routeBook_ensures_bestRejectedSummary_candidateClass_when_missing', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              constraintReason: 'REQUIRED_OUTPUT',
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_001n,
                availableInput: 1_000n,
                inputDeficit: 1n,
                inputSlack: 0n,
                reason: 'required output unsatisfiable'
              },
              candidateClass: undefined
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'NOT_ROUTEABLE' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'NOT_ROUTEABLE', { reason: 'POOL_MISSING' })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.candidateClass).toBe('LIQUIDITY_BLOCKED');
  });

  it('bestRejected_prefers_actionable_policy_near_miss_over_quote_failed_huge_gap', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'QUOTE_FAILED' as const,
            summary: venueSummary('UNISWAP_V3', 'QUOTE_FAILED', {
              reason: 'QUOTE_CALL_FAILED',
              quotedAmountOut: 500n,
              constraintReason: 'REQUIRED_OUTPUT',
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
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'CONSTRAINT_REJECTED', {
              reason: 'PROFITABILITY_FLOOR',
              quotedAmountOut: 899n,
              constraintReason: 'PROFITABILITY_FLOOR',
              constraintBreakdown: constraintBreakdown({
                bindingFloor: 'PROFITABILITY_FLOOR',
                nearMiss: true,
                minAmountOutShortfallOut: 1n
              }),
              exactOutputViability: {
                status: 'SATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 999n,
                availableInput: 1_000n,
                inputDeficit: 0n,
                inputSlack: 1n,
                reason: 'required output satisfiable'
              }
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.venue).toBe('CAMELOT_AMMV3');
    expect(selected.bestRejectedSummary?.candidateClass).toBe('POLICY_BLOCKED');
  });

  it('bestRejected_prefers_near_miss_uniswap_liquidity_blocked_over_quote_failed_huge_gap_camelot', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              constraintReason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 896n,
              hedgeGap: {
                requiredOutput: 900n,
                quotedAmountOut: 896n,
                outputCoverageBps: 9_955n,
                requiredOutputShortfallOut: 4n,
                minAmountOutShortfallOut: 5n,
                inputDeficit: 1n,
                inputSlack: 0n,
                gapClass: 'SMALL',
                nearMiss: true,
                nearMissBps: 25n
              },
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_001n,
                availableInput: 1_000n,
                inputDeficit: 1n,
                inputSlack: 0n,
                reason: 'required output unsatisfiable'
              }
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'QUOTE_FAILED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'QUOTE_FAILED', {
              reason: 'QUOTE_CALL_FAILED',
              constraintReason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 500n,
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
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.venue).toBe('UNISWAP_V3');
    expect(selected.bestRejectedSummary?.candidateClass).toBe('LIQUIDITY_BLOCKED');
  });

  it('bestRejected_liquidity_blocked_prefers_smaller_input_deficit', async () => {
    const routeBook = new RouteBook({
      uniswapV3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('UNISWAP_V3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 895n,
              constraintReason: 'REQUIRED_OUTPUT',
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_003n,
                availableInput: 1_000n,
                inputDeficit: 3n,
                inputSlack: 0n,
                reason: 'unsatisfiable'
              },
              hedgeGap: {
                requiredOutput: 900n,
                quotedAmountOut: 895n,
                outputCoverageBps: 9_944n,
                requiredOutputShortfallOut: 5n,
                minAmountOutShortfallOut: 6n,
                inputDeficit: 3n,
                inputSlack: 0n,
                gapClass: 'MEDIUM',
                nearMiss: false,
                nearMissBps: 25n
              }
            })
          }
        })
      },
      camelotAmmv3: {
        planBestRoute: async () => ({
          ok: false as const,
          failure: {
            reason: 'CONSTRAINT_REJECTED' as const,
            summary: venueSummary('CAMELOT_AMMV3', 'CONSTRAINT_REJECTED', {
              reason: 'REQUIRED_OUTPUT',
              quotedAmountOut: 894n,
              constraintReason: 'REQUIRED_OUTPUT',
              exactOutputViability: {
                status: 'UNSATISFIABLE',
                targetOutput: 900n,
                requiredInputForTargetOutput: 1_001n,
                availableInput: 1_000n,
                inputDeficit: 1n,
                inputSlack: 0n,
                reason: 'unsatisfiable'
              },
              hedgeGap: {
                requiredOutput: 900n,
                quotedAmountOut: 894n,
                outputCoverageBps: 9_933n,
                requiredOutputShortfallOut: 6n,
                minAmountOutShortfallOut: 7n,
                inputDeficit: 1n,
                inputSlack: 0n,
                gapClass: 'MEDIUM',
                nearMiss: false,
                nearMissBps: 25n
              }
            })
          }
        })
      },
      enableCamelotAmmv3: true
    });

    const selected = await routeBook.selectBestRoute({
      resolvedOrder: {
        input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n },
        outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }]
      } as never
    });

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.bestRejectedSummary?.venue).toBe('CAMELOT_AMMV3');
    expect(selected.bestRejectedSummary?.candidateClass).toBe('LIQUIDITY_BLOCKED');
    expect(selected.bestRejectedSummary?.hedgeGap?.inputDeficit).toBe(1n);
  });
});
