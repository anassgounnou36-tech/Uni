export type IngressSource = 'POLL' | 'WEBHOOK';

export type IngressEnvelope<TPayload = unknown> = {
  source: IngressSource;
  receivedAtMs: number;
  payload: TPayload;
  remoteIp?: string;
  createdAtMs?: number;
  orderHashHint?: `0x${string}`;
};

export type UniswapWebhookPayload = {
  orderHash: `0x${string}`;
  createdAt: string | number;
  signature: `0x${string}`;
  orderStatus: 'open';
  encodedOrder: `0x${string}`;
  chainId: 42161;
  filler?: `0x${string}`;
};
