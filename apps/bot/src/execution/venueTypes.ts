import type { HedgeVenue } from '../routing/venues.js';

export const EXECUTOR_VENUE_CODE = {
  UNISWAP_V3: 0,
  CAMELOT_AMMV3: 1
} as const;

export type ExecutorVenueCode = (typeof EXECUTOR_VENUE_CODE)[keyof typeof EXECUTOR_VENUE_CODE];

export function toExecutorVenueCode(venue: HedgeVenue): ExecutorVenueCode {
  return EXECUTOR_VENUE_CODE[venue];
}

export function fromExecutorVenueCode(code: number): HedgeVenue {
  if (code === EXECUTOR_VENUE_CODE.UNISWAP_V3) {
    return 'UNISWAP_V3';
  }
  if (code === EXECUTOR_VENUE_CODE.CAMELOT_AMMV3) {
    return 'CAMELOT_AMMV3';
  }
  throw new Error(`unknown executor venue code: ${code}`);
}
