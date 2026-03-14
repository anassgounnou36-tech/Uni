import type { ResolvedV3DutchOrder } from '@uni/protocol';

function normalize(address: `0x${string}`): string {
  return address.toLowerCase();
}

export function hasSameOutputTokenShape(order: ResolvedV3DutchOrder): boolean {
  const firstToken = order.outputs[0]?.token;
  if (!firstToken) {
    return false;
  }
  return order.outputs.every((output) => normalize(output.token) === normalize(firstToken));
}
