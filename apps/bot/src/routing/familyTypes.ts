import type { Address } from 'viem';
import type { RoutePathKind } from './pathTypes.js';
import type { HedgeVenue } from './venues.js';

export type RouteFamilyKind = 'DIRECT' | 'TWO_HOP';

export type RouteFamily = {
  venue: HedgeVenue;
  familyKind: RouteFamilyKind;
  tokenIn: Address;
  tokenOut: Address;
  bridgeToken?: Address;
  feeTier?: number;
  secondFeeTier?: number;
  pathKind: RoutePathKind;
  hopCount: 1 | 2;
  pathDescriptor: string;
  discovery: 'DIRECT_FEE_TIER' | 'DIRECT_PAIR' | 'TWO_HOP_BRIDGE_FEE';
  probePriority: number;
  familyKey: string;
};

export type RouteFamilyProbeResult = {
  family: RouteFamily;
  discoveryOk: boolean;
  quoteInputTried: boolean;
  quoteOutputTried: boolean;
  candidateCount: number;
  revertedProbeCount: number;
  blocked: boolean;
  blockedReason?: string;
};
