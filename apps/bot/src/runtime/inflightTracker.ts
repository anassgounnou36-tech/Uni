export class InflightTracker {
  private readonly inflight = new Map<`0x${string}`, string | undefined>();

  markAttempted(orderHash: `0x${string}`, txHashOrSerializedTx?: string): void {
    this.inflight.set(orderHash, txHashOrSerializedTx);
  }

  markResolved(orderHash: `0x${string}`): void {
    this.inflight.delete(orderHash);
  }

  getInflightCount(): number {
    return this.inflight.size;
  }

  has(orderHash: `0x${string}`): boolean {
    return this.inflight.has(orderHash);
  }
}
