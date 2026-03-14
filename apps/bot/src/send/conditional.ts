export type KnownAccountState = {
  address: `0x${string}`;
  nonce?: bigint;
  balance?: bigint;
};

export type ConditionalEnvelope = {
  TimestampMin?: bigint;
  TimestampMax?: bigint;
  BlockNumberMin?: bigint;
  BlockNumberMax?: bigint;
  knownAccounts?: ReadonlyArray<KnownAccountState>;
};

export type ConditionalEnvelopeOptions = {
  enableKnownAccounts?: boolean;
};

export type TimestampMaxDerivationParams = {
  currentL2TimestampSec: bigint;
  scheduledWindowBlocks: bigint;
  avgBlockTimeSec: bigint;
  maxStalenessSec: bigint;
};

export function assertTimestampMaxFresh(envelope: ConditionalEnvelope, currentL2TimestampSec: bigint): void {
  if (envelope.TimestampMax !== undefined && envelope.TimestampMax < currentL2TimestampSec) {
    throw new Error(`TimestampMax ${envelope.TimestampMax} is stale (current: ${currentL2TimestampSec})`);
  }
}

function assertRange(min: bigint | undefined, max: bigint | undefined, label: string): void {
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`${label} min cannot exceed max`);
  }
}

export function deriveTimestampMax(params: TimestampMaxDerivationParams): bigint {
  const windowSeconds = params.scheduledWindowBlocks * params.avgBlockTimeSec;
  return params.currentL2TimestampSec + windowSeconds + params.maxStalenessSec;
}

export function normalizeConditionalEnvelope(
  envelope: ConditionalEnvelope,
  options: ConditionalEnvelopeOptions = {}
): ConditionalEnvelope {
  assertRange(envelope.TimestampMin, envelope.TimestampMax, 'timestamp');
  assertRange(envelope.BlockNumberMin, envelope.BlockNumberMax, 'block number');

  if (!options.enableKnownAccounts && envelope.knownAccounts && envelope.knownAccounts.length > 0) {
    return {
      ...envelope,
      knownAccounts: undefined
    };
  }

  return envelope;
}

export function buildFreshnessGuard(timestampMax: bigint, blockNumberMax?: bigint): ConditionalEnvelope {
  return {
    TimestampMax: timestampMax,
    ...(blockNumberMax !== undefined ? { BlockNumberMax: blockNumberMax } : {})
  };
}
