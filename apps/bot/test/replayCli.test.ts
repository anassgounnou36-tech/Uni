import { describe, expect, it } from 'vitest';
import { formatReplayOutput, resolveInput } from '../src/replay/cli.js';

describe('replay cli input resolution', () => {
  it('prefers DB lookup before fixture fallback', async () => {
    const fromDb = await resolveInput(
      { orderHash: '0x1111111111111111111111111111111111111111111111111111111111111111' },
      'postgres://example',
      {
        findFromDatabase: async () => ({
          source: 'DB_ORDER',
          fixture: {
            encodedOrder: '0x12',
            signature: '0x34'
          }
        })
      }
    );
    expect(fromDb.source).toBe('DB_ORDER');

    const fromFixture = await resolveInput(
      { fixture: 'fixtures/orders/arbitrum/live/live-01.json' },
      'postgres://example',
      {
        findFromDatabase: async () => {
          throw new Error('db lookup should not run for direct fixture argument');
        }
      }
    );
    expect(fromFixture.source).toBe('FIXTURE');
  });

  it('formats replay output with truthfulness fields', () => {
    const output = formatReplayOutput({
      source: 'DB_ORDER',
      orderHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      replayRecord: {
        orderHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        decision: 'NO_SEND',
        reason: 'NOT_PROFITABLE',
        predictedEdgeOut: 0n,
        simResult: 'SIM_FAIL',
        chosenVenue: 'UNISWAP_V3',
        rejectedVenueSummaries: [
          {
            venue: 'UNISWAP_V3',
            pathKind: 'TWO_HOP',
            bridgeToken: '0x000000000000000000000000000000000000000b',
            eligible: false,
            reason: 'CONSTRAINT_REJECTED',
            candidateClass: 'LIQUIDITY_BLOCKED',
            constraintReason: 'REQUIRED_OUTPUT',
            exactOutputViability: { status: 'UNSATISFIABLE' },
            hedgeGap: { gapClass: 'MEDIUM' }
          }
        ] as never
      }
    });

    expect(output.orderHash).toBeDefined();
    expect(output.routeBookReason).toBe('NOT_PROFITABLE');
    expect(output.candidateClass).toBe('LIQUIDITY_BLOCKED');
    expect(output.constraintReason).toBe('REQUIRED_OUTPUT');
    expect(output.exactOutputStatus).toBe('UNSATISFIABLE');
    expect(output.gapClass).toBe('MEDIUM');
    expect(output.bestRejectedVenue).toBe('UNISWAP_V3');
    expect(output.bestRejectedPathKind).toBe('TWO_HOP');
    expect(output.bestRejectedBridgeToken).toBe('0x000000000000000000000000000000000000000b');
    expect(output.bestRejectedReason).toBe('CONSTRAINT_REJECTED');
  });

  it('replay_by_journal_id_uses_stored_snapshot_and_does_not_fail_immediately_with_DeadlineReached', async () => {
    const resolved = await resolveInput(
      { journalId: '123' },
      'postgres://example',
      {
        findFromJournalId: async () => ({
          source: 'DB_JOURNAL',
          fixture: {
            encodedOrder: '0x12',
            signature: '0x34',
            orderHash: '0x1111111111111111111111111111111111111111111111111111111111111111'
          },
          resolveSnapshot: {
            chainId: 42161n,
            blockNumber: 1000n,
            blockNumberish: 1000n,
            timestamp: 1_900_000_000n,
            baseFeePerGas: 1n,
            sampledAtMs: 123
          }
        })
      }
    );
    expect(resolved.source).toBe('DB_JOURNAL');
    expect(resolved.resolveSnapshot?.timestamp).toBe(1_900_000_000n);
    expect(resolved.resolveSnapshot?.blockNumberish).toBe(1000n);
  });
});
