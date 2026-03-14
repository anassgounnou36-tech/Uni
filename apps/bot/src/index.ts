import { ARB1_SEQUENCER_ENDPOINT } from '@uni/config';

export const runtimeConfig = {
  chain: 'arbitrum',
  rpcUrl: ARB1_SEQUENCER_ENDPOINT,
  enableConditionalBlockBounds: false
} as const;
