import type { ResolvedV3DutchOrder } from '@uni/protocol';

export type RoutePair = {
  inputToken: `0x${string}`;
  outputToken: `0x${string}`;
};

function normalize(address: `0x${string}`): string {
  return address.toLowerCase();
}

export class Univ3QuoteModel {
  constructor(
    private readonly routeablePairs: ReadonlyArray<RoutePair>,
    private readonly inputToOutputBps: bigint = 19_000n,
    private readonly quoteHaircutBps: bigint = 15n
  ) {}

  isRouteable(inputToken: `0x${string}`, outputToken: `0x${string}`): boolean {
    return this.routeablePairs.some(
      (pair) => normalize(pair.inputToken) === normalize(inputToken) && normalize(pair.outputToken) === normalize(outputToken)
    );
  }

  estimateHedgeOutput(order: ResolvedV3DutchOrder): bigint {
    const gross = (order.input.amount * this.inputToOutputBps) / 10_000n;
    return gross - (gross * this.quoteHaircutBps) / 10_000n;
  }
}

export function hasSameOutputTokenShape(order: ResolvedV3DutchOrder): boolean {
  const firstToken = order.outputs[0]?.token;
  if (!firstToken) {
    return false;
  }
  return order.outputs.every((output) => normalize(output.token) === normalize(firstToken));
}
