import type { Address, Hex } from 'viem';
import type { HedgeVenue } from './venues.js';

export const ROUTE_PATH_KINDS = ['DIRECT', 'TWO_HOP'] as const;
export type RoutePathKind = (typeof ROUTE_PATH_KINDS)[number];

export const PATH_ENCODING_DIRECTIONS = ['FORWARD', 'REVERSE'] as const;
export type PathEncodingDirection = (typeof PATH_ENCODING_DIRECTIONS)[number];

export type HedgePathLeg = {
  tokenIn: Address;
  tokenOut: Address;
  venue: HedgeVenue;
  poolFee?: number;
  bridgeToken?: Address;
};

export type LfjLbPath = {
  tokenPath: Address[];
  binSteps: number[];
  versions: number[];
};

export type EncodedSwapPath = {
  kind: RoutePathKind;
  venue: HedgeVenue;
  tokenIn: Address;
  tokenOut: Address;
  bridgeToken?: Address;
  encodedPath: Hex;
  hopCount: 1 | 2;
  pathDirection: PathEncodingDirection;
};

export function assertValidEncodedSwapPath(path: EncodedSwapPath): void {
  if (path.hopCount !== 1 && path.hopCount !== 2) {
    throw new Error('encoded swap path hopCount must be 1 or 2');
  }
  if (path.kind === 'DIRECT' && path.hopCount !== 1) {
    throw new Error('DIRECT path must have hopCount=1');
  }
  if (path.kind === 'TWO_HOP' && path.hopCount !== 2) {
    throw new Error('TWO_HOP path must have hopCount=2');
  }
}
