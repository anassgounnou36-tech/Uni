export type RouteEvalRpcErrorCategory = 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED';

export type NormalizedRouteEvalRpcError = {
  category: RouteEvalRpcErrorCategory;
  message: string;
};

function asMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function normalizeRouteEvalRpcError(error: unknown): NormalizedRouteEvalRpcError {
  const message = asMessage(error);
  const lower = message.toLowerCase();
  if (
    lower.includes('execution reverted')
    || lower.includes('transaction reverted')
    || lower.includes('error code 3')
    || lower.includes('reverted with reason string')
  ) {
    return { category: 'QUOTE_REVERTED', message };
  }

  if (
    lower.includes('429')
    || lower.includes('rate limit')
    || lower.includes('rate-limit')
    || lower.includes('compute units per second')
    || lower.includes('capacity')
    || lower.includes('too many requests')
  ) {
    return { category: 'RATE_LIMITED', message };
  }

  if (
    lower.includes('timeout')
    || lower.includes('timed out')
    || lower.includes('network')
    || lower.includes('connection')
    || lower.includes('connect')
    || lower.includes('unavailable')
    || lower.includes('econnrefused')
    || lower.includes('ehostunreach')
    || lower.includes('enotfound')
    || lower.includes('fetch failed')
  ) {
    return { category: 'RPC_UNAVAILABLE', message };
  }

  return { category: 'RPC_FAILED', message };
}
