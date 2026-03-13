import type { SupportClassification, SupportPolicyV1, V3DutchOrder } from './types.js';

function normalize(address: string): string {
  return address.toLowerCase();
}

export function classifySupport(order: V3DutchOrder, policy: SupportPolicyV1): SupportClassification {
  if (policy.orderType !== 'Dutch_V3') {
    return { supported: false, reason: 'NOT_DUTCH_V3' };
  }

  if (order.baseOutputs.length === 0) {
    return { supported: false, reason: 'EXOTIC_OUTPUT_SHAPE' };
  }

  const outputToken = normalize(order.baseOutputs[0].token);
  const outputRecipient = normalize(order.baseOutputs[0].recipient);
  const hasMixedOutputToken = order.baseOutputs.some((output) => normalize(output.token) !== outputToken);
  if (hasMixedOutputToken) {
    return { supported: false, reason: 'OUTPUT_TOKEN_MISMATCH' };
  }

  const exoticShape = order.baseOutputs.some((output) => normalize(output.recipient) !== outputRecipient);
  if (exoticShape) {
    return { supported: false, reason: 'EXOTIC_OUTPUT_SHAPE' };
  }

  const inputToken = normalize(order.baseInput.token);
  const allowlisted = policy.allowlistedPairs.some(
    (pair) => normalize(pair.inputToken) === inputToken && normalize(pair.outputToken) === outputToken
  );

  if (!allowlisted) {
    return { supported: false, reason: 'TOKEN_PAIR_NOT_ALLOWLISTED' };
  }

  return { supported: true, reason: 'SUPPORTED' };
}
