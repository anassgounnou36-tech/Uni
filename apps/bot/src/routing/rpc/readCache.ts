type CacheValue = unknown;
type ReadCacheParams = {
  chainId: bigint | number;
  blockNumberish: bigint | number | string;
  target: string;
  fn: string;
  args?: readonly unknown[];
  extraKey?: unknown;
};

function toStableString(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => toStableString(item)).join(',')}]`;
  }
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${key}:${toStableString(val)}`).join(',')}}`;
  }
  if (value === undefined) return 'undefined';
  return String(value);
}

function buildCacheKey(params: ReadCacheParams): string {
  return [
    `chain:${toStableString(params.chainId)}`,
    `block:${toStableString(params.blockNumberish)}`,
    `target:${params.target.toLowerCase()}`,
    `fn:${params.fn}`,
    `args:${(params.args ?? []).map((arg) => toStableString(arg)).join('|')}`,
    params.extraKey === undefined ? undefined : `extra:${toStableString(params.extraKey)}`
  ]
    .filter((part): part is string => part !== undefined)
    .join('::');
}

type RouteEvalReadCacheOptions = {
  maxEntries?: number;
  maxNegativeEntries?: number;
  maxSnapshots?: number;
};

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_NEGATIVE_ENTRIES = 2_048;
const DEFAULT_MAX_SNAPSHOTS = 6;

export class RouteEvalReadCache {
  private readonly maxEntries: number;
  private readonly maxNegativeEntries: number;
  private readonly maxSnapshots: number;
  private readonly entries = new Map<string, Promise<CacheValue>>();
  private readonly negativeEntries = new Map<string, Promise<never>>();
  private readonly snapshotEntries = new Map<string, Set<string>>();
  private readonly snapshotNegativeEntries = new Map<string, Set<string>>();
  private readonly keySnapshot = new Map<string, string>();
  private readonly negativeKeySnapshot = new Map<string, string>();

  constructor(options?: RouteEvalReadCacheOptions) {
    this.maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxNegativeEntries = Math.max(1, options?.maxNegativeEntries ?? DEFAULT_MAX_NEGATIVE_ENTRIES);
    this.maxSnapshots = Math.max(1, options?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  }

  getEntryCount(): number {
    return this.entries.size;
  }

  getNegativeEntryCount(): number {
    return this.negativeEntries.size;
  }

  getSnapshotCount(): number {
    return this.snapshotEntries.size;
  }

  sweep(): void {
    this.pruneSnapshots();
    this.pruneEntries();
    this.pruneNegativeEntries();
  }

  private snapshotKey(params: ReadCacheParams): string {
    return `${toStableString(params.chainId)}::${toStableString(params.blockNumberish)}`;
  }

  private ensureSnapshotSet(index: Map<string, Set<string>>, snapshot: string): Set<string> {
    let set = index.get(snapshot);
    if (!set) {
      set = new Set<string>();
      index.set(snapshot, set);
    }
    return set;
  }

  private addEntryToSnapshot(key: string, snapshot: string): void {
    this.keySnapshot.set(key, snapshot);
    this.ensureSnapshotSet(this.snapshotEntries, snapshot).add(key);
  }

  private addNegativeEntryToSnapshot(key: string, snapshot: string): void {
    this.negativeKeySnapshot.set(key, snapshot);
    this.ensureSnapshotSet(this.snapshotNegativeEntries, snapshot).add(key);
  }

  private pruneSnapshots(): void {
    while (this.snapshotEntries.size > this.maxSnapshots) {
      const oldestSnapshot = this.snapshotEntries.keys().next().value as string | undefined;
      if (!oldestSnapshot) {
        break;
      }
      const keys = this.snapshotEntries.get(oldestSnapshot);
      if (keys) {
        for (const key of keys) {
          this.entries.delete(key);
          this.keySnapshot.delete(key);
        }
      }
      this.snapshotEntries.delete(oldestSnapshot);
      const negativeKeys = this.snapshotNegativeEntries.get(oldestSnapshot);
      if (negativeKeys) {
        for (const key of negativeKeys) {
          this.negativeEntries.delete(key);
          this.negativeKeySnapshot.delete(key);
        }
      }
      this.snapshotNegativeEntries.delete(oldestSnapshot);
    }
  }

  private removeEntryFromSnapshot(key: string): void {
    const snapshot = this.keySnapshot.get(key);
    if (!snapshot) return;
    this.keySnapshot.delete(key);
    const set = this.snapshotEntries.get(snapshot);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) {
      this.snapshotEntries.delete(snapshot);
    }
  }

  private removeNegativeEntryFromSnapshot(key: string): void {
    const snapshot = this.negativeKeySnapshot.get(key);
    if (!snapshot) return;
    this.negativeKeySnapshot.delete(key);
    const set = this.snapshotNegativeEntries.get(snapshot);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) {
      this.snapshotNegativeEntries.delete(snapshot);
    }
  }

  private pruneEntries(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
      this.removeEntryFromSnapshot(oldest);
    }
  }

  private pruneNegativeEntries(): void {
    while (this.negativeEntries.size > this.maxNegativeEntries) {
      const oldest = this.negativeEntries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.negativeEntries.delete(oldest);
      this.removeNegativeEntryFromSnapshot(oldest);
    }
  }

  async getOrSet<T>(
    params: ReadCacheParams,
    loader: () => Promise<T>,
    onAccess?: (hit: boolean) => void
  ): Promise<{ value: T; hit: boolean }> {
    const key = buildCacheKey(params);
    const snapshot = this.snapshotKey(params);
    const cached = this.entries.get(key);
    if (cached) {
      onAccess?.(true);
      return { value: (await cached) as T, hit: true };
    }

    const promise = loader().catch((error) => {
      this.entries.delete(key);
      this.removeEntryFromSnapshot(key);
      throw error;
    });
    this.entries.set(key, promise);
    this.addEntryToSnapshot(key, snapshot);
    this.pruneSnapshots();
    this.pruneEntries();
    onAccess?.(false);
    return { value: (await promise) as T, hit: false };
  }

  async getOrSetNegative<T>(
    params: ReadCacheParams,
    loader: () => Promise<T>,
    shouldMemoizeNegative: (error: unknown) => boolean,
    onAccess?: (hit: boolean) => void,
    onNegativeAccess?: (hit: boolean) => void
  ): Promise<{ value: T; hit: boolean }> {
    const key = buildCacheKey(params);
    const snapshot = this.snapshotKey(params);
    const cachedNegative = this.negativeEntries.get(key);
    if (cachedNegative) {
      onNegativeAccess?.(true);
      return { value: (await cachedNegative) as never, hit: true };
    }
    try {
      return await this.getOrSet(params, loader, onAccess);
    } catch (error) {
      if (!shouldMemoizeNegative(error)) {
        throw error;
      }
      const rejection = Promise.reject(error) as Promise<never>;
      rejection.catch(() => undefined);
      this.negativeEntries.set(key, rejection);
      this.addNegativeEntryToSnapshot(key, snapshot);
      this.pruneSnapshots();
      this.pruneNegativeEntries();
      onNegativeAccess?.(false);
      throw error;
    }
  }
}
