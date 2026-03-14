import { z } from 'zod';
import type { UniswapWebhookPayload } from './types.js';

const HEX_RE = /^0x[0-9a-fA-F]+$/;

export const uniswapWebhookPayloadSchema = z.object({
  orderHash: z.string().regex(HEX_RE),
  createdAt: z.union([z.string().min(1), z.number().finite()]),
  signature: z.string().regex(HEX_RE),
  orderStatus: z.literal('open'),
  encodedOrder: z.string().regex(HEX_RE),
  chainId: z.literal(42161),
  filler: z.string().regex(HEX_RE).optional()
});

export function parseWebhookPayload(input: unknown): { success: true; data: UniswapWebhookPayload } | { success: false } {
  const result = uniswapWebhookPayloadSchema.safeParse(input);
  if (!result.success) {
    return { success: false };
  }
  return {
    success: true,
    data: result.data as UniswapWebhookPayload
  };
}
