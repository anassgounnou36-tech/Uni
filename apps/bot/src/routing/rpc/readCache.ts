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

export class RouteEvalReadCache {
  private readonly entries = new Map<string, Promise<CacheValue>>();

  async getOrSet<T>(
    params: ReadCacheParams,
    loader: () => Promise<T>,
    onAccess?: (hit: boolean) => void
  ): Promise<{ value: T; hit: boolean }> {
    const key = buildCacheKey(params);
    const cached = this.entries.get(key);
    if (cached) {
      onAccess?.(true);
      return { value: (await cached) as T, hit: true };
    }

    const promise = loader().catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, promise);
    onAccess?.(false);
    return { value: (await promise) as T, hit: false };
  }
}
