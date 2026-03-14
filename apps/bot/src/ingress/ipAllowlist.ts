import type { IncomingMessage } from 'node:http';

function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) {
    return undefined;
  }
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }
  return trimmed;
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }
  return ((bytes[0] ?? 0) << 24) + ((bytes[1] ?? 0) << 16) + ((bytes[2] ?? 0) << 8) + (bytes[3] ?? 0);
}

function matchesCidr(ip: string, cidr: string): boolean {
  const [baseIp, maskRaw] = cidr.split('/');
  const maskBits = Number(maskRaw);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(baseIp ?? '');
  if (ipInt === undefined || baseInt === undefined || !Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) {
    return false;
  }
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipInt >>> 0 & mask) === (baseInt >>> 0 & mask);
}

export function resolveRemoteIp(request: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwardedFor = request.headers['x-forwarded-for'];
    const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    if (typeof raw === 'string' && raw.length > 0) {
      const first = raw.split(',')[0];
      const normalized = normalizeIp(first);
      if (normalized) {
        return normalized;
      }
    }
  }
  return normalizeIp(request.socket.remoteAddress ?? undefined);
}

export function isIpAllowlisted(ip: string | undefined, allowCidrs: readonly string[]): boolean {
  if (!ip) {
    return false;
  }
  return allowCidrs.some((cidr) => matchesCidr(ip, cidr));
}

export function isRequestAllowlisted(request: IncomingMessage, trustProxy: boolean, allowCidrs: readonly string[]) {
  const ip = resolveRemoteIp(request, trustProxy);
  return {
    ip,
    allowed: isIpAllowlisted(ip, allowCidrs)
  };
}
