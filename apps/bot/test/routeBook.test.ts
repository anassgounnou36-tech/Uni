import { describe, expect, it } from 'vitest';
import { RouteBook } from '../src/routing/routeBook.js';
import type { HedgeRoutePlan } from '../src/routing/venues.js';

function makeRoute(venue: 'UNISWAP_V3' | 'CAMELOT_AMMV3', overrides: Partial<HedgeRoutePlan> = {}): HedgeRoutePlan {
  return {
    venue,
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

describe('RouteBook', () => {
  it('routeBookChoosesHigherNetEdgeVenue', async () => {
    const routeBook = new RouteBook({
      uniswapV3: { planBestRoute: async () => ({ ok: true as const, route: makeRoute('UNISWAP_V3', { netEdgeOut: 10n }) }) },
      camelotAmmv3: { planBestRoute: async () => ({ ok: true as const, route: makeRoute('CAMELOT_AMMV3', { netEdgeOut: 20n }) }) },
      enableCamelotAmmv3: true
    });
    const selected = await routeBook.selectBestRoute({
      resolvedOrder: { input: { token: makeRoute('UNISWAP_V3').tokenIn, amount: 1_000n }, outputs: [{ token: makeRoute('UNISWAP_V3').tokenOut, amount: 900n }] } as never
    });

    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.chosenRoute.venue).toBe('CAMELOT_AMMV3');
    }
  });

  it('routeBookTieBreaksDeterministically', async () => {
    const tieRoute = makeRoute('UNISWAP_V3', { netEdgeOut: 10n, quotedAmountOut: 100n, minAmountOut: 50n, gasCostOut: 5n });
    const routeBook = new RouteBook({
      uniswapV3: { planBestRoute: async () => ({ ok: true as const, route: tieRoute }) },
      camelotAmmv3: {
        planBestRoute: async () =>
          ({
            ok: true as const,
            route: makeRoute('CAMELOT_AMMV3', { netEdgeOut: 10n, quotedAmountOut: 100n, minAmountOut: 50n, gasCostOut: 5n })
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
      uniswapV3: { planBestRoute: async () => ({ ok: true as const, route: makeRoute('UNISWAP_V3') }) },
      camelotAmmv3: {
        planBestRoute: async () => ({ ok: true as const, route: makeRoute('CAMELOT_AMMV3', { netEdgeOut: 999n }) })
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
});
