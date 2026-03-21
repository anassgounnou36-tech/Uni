import { z } from 'zod';
import { getAddress, isAddress } from 'viem';

const HEX_KEY = /^0x[a-fA-F0-9]{64}$/;

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

function parseBigInt(value: string, name: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid bigint for ${name}`);
  }
}

function parseBigIntList(value: string): bigint[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseBigInt(entry, 'CANDIDATE_BLOCK_OFFSETS'));
}

function normalizeAddress(value: string, name: string): `0x${string}` {
  const trimmed = value.trim();
  if (!isAddress(trimmed)) {
    throw new Error(`Invalid ${name} address: ${value}`);
  }
  return getAddress(trimmed);
}

function normalizeAddressList(value: string, name: string): Array<`0x${string}`> {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeAddress(entry, name));
}

function parseCanaryPairs(value: string): Array<{ inputToken: `0x${string}`; outputToken: `0x${string}` }> {
  if (!value.trim()) {
    return [];
  }
  return value.split(',').map((entry) => {
    const [inputToken, outputToken] = entry.split(':').map((part) => part.trim());
    if (!inputToken || !outputToken) {
      throw new Error('Invalid CANARY_ALLOWLISTED_PAIRS format');
    }
    return {
      inputToken: normalizeAddress(inputToken, 'CANARY_ALLOWLISTED_PAIRS input'),
      outputToken: normalizeAddress(outputToken, 'CANARY_ALLOWLISTED_PAIRS output')
    };
  });
}

const baseSchema = z.object({
  READ_RPC_URL: z.string().url(),
  FORK_RPC_URL: z.string().url().optional(),
  SEQUENCER_URL: z.string().url(),
  DATABASE_URL: z.string().url().optional(),
  ALLOW_EPHEMERAL_STATE: z.string().optional(),
  SIGNER_PRIVATE_KEY: z.string().regex(HEX_KEY).optional(),
  EXECUTOR_ADDRESS: z.string().default('0x3333333333333333333333333333333333333333'),

  POLL_CADENCE_MS: z.coerce.number().int().positive().default(1_000),
  ENABLE_WEBHOOK_INGRESS: z.string().optional(),
  WEBHOOK_HOST: z.string().default('0.0.0.0'),
  WEBHOOK_PORT: z.coerce.number().int().positive().default(8080),
  WEBHOOK_PATH: z.string().default('/uniswapx/webhook'),
  TRUST_PROXY: z.string().optional(),
  ALLOWED_WEBHOOK_CIDRS: z.string().default('3.14.56.90/32'),
  MAX_WEBHOOK_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),

  SCHEDULER_CADENCE_MS: z.coerce.number().int().positive().default(500),
  HOT_LANE_CADENCE_MS: z.coerce.number().int().positive().default(200),
  CANDIDATE_BLOCKS: z.string().optional(),
  CANDIDATE_BLOCK_OFFSETS: z.string().default('0,1,2'),
  COMPETE_WINDOW_BLOCKS: z.string().default('2'),
  THRESHOLD_OUT: z.string().default('1'),

  SHADOW_MODE: z.string().optional(),
  CANARY_MODE: z.string().optional(),
  CANARY_ALLOWLISTED_PAIRS: z.string().default(''),
  MAX_LIVE_NOTIONAL_IN: z.string().default('0'),
  MAX_LIVE_INFLIGHT: z.coerce.number().int().nonnegative().default(0),
  MIN_LIVE_EDGE_OUT: z.string().default('0'),
  ENABLE_CAMELOT_AMMV3: z.string().optional(),
  BRIDGE_TOKENS: z.string().default(
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8,0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCBB9'
  ),

  ENABLE_METRICS_SERVER: z.string().optional(),
  METRICS_HOST: z.string().default('0.0.0.0'),
  METRICS_PORT: z.coerce.number().int().positive().default(9100)
});

export type RuntimeConfig = {
  readRpcUrl: string;
  forkRpcUrl?: string;
  sequencerUrl: string;
  databaseUrl?: string;
  allowEphemeralState: boolean;
  signerPrivateKey?: `0x${string}`;
  executorAddress: `0x${string}`;

  pollCadenceMs: number;
  enableWebhookIngress: boolean;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
  trustProxy: boolean;
  allowedWebhookCidrs: string[];
  maxWebhookBodyBytes: number;

  schedulerCadenceMs: number;
  hotLaneCadenceMs: number;
  candidateBlockOffsets: bigint[];
  competeWindowBlocks: bigint;
  thresholdOut: bigint;

  shadowMode: boolean;
  canaryMode: boolean;
  canaryAllowlistedPairs: Array<{ inputToken: `0x${string}`; outputToken: `0x${string}` }>;
  maxLiveNotionalIn: bigint;
  maxLiveInflight: number;
  minLiveEdgeOut: bigint;
  enableCamelotAmmv3: boolean;
  bridgeTokens: Array<`0x${string}`>;

  enableMetricsServer: boolean;
  metricsHost: string;
  metricsPort: number;
};

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = baseSchema.parse(env);
  if (parsed.CANDIDATE_BLOCKS !== undefined) {
    throw new Error('CANDIDATE_BLOCKS is deprecated; use CANDIDATE_BLOCK_OFFSETS');
  }
  return {
    readRpcUrl: parsed.READ_RPC_URL,
    forkRpcUrl: parsed.FORK_RPC_URL,
    sequencerUrl: parsed.SEQUENCER_URL,
    databaseUrl: parsed.DATABASE_URL,
    allowEphemeralState: parseBoolean(parsed.ALLOW_EPHEMERAL_STATE, false),
    signerPrivateKey: parsed.SIGNER_PRIVATE_KEY as `0x${string}` | undefined,
    executorAddress: normalizeAddress(parsed.EXECUTOR_ADDRESS, 'EXECUTOR_ADDRESS'),

    pollCadenceMs: parsed.POLL_CADENCE_MS,
    enableWebhookIngress: parseBoolean(parsed.ENABLE_WEBHOOK_INGRESS, false),
    webhookHost: parsed.WEBHOOK_HOST,
    webhookPort: parsed.WEBHOOK_PORT,
    webhookPath: parsed.WEBHOOK_PATH,
    trustProxy: parseBoolean(parsed.TRUST_PROXY, false),
    allowedWebhookCidrs: parsed.ALLOWED_WEBHOOK_CIDRS.split(',').map((entry) => entry.trim()).filter(Boolean),
    maxWebhookBodyBytes: parsed.MAX_WEBHOOK_BODY_BYTES,

    schedulerCadenceMs: parsed.SCHEDULER_CADENCE_MS,
    hotLaneCadenceMs: parsed.HOT_LANE_CADENCE_MS,
    candidateBlockOffsets: parseBigIntList(parsed.CANDIDATE_BLOCK_OFFSETS),
    competeWindowBlocks: parseBigInt(parsed.COMPETE_WINDOW_BLOCKS, 'COMPETE_WINDOW_BLOCKS'),
    thresholdOut: parseBigInt(parsed.THRESHOLD_OUT, 'THRESHOLD_OUT'),

    shadowMode: parseBoolean(parsed.SHADOW_MODE, true),
    canaryMode: parseBoolean(parsed.CANARY_MODE, false),
    canaryAllowlistedPairs: parseCanaryPairs(parsed.CANARY_ALLOWLISTED_PAIRS),
    maxLiveNotionalIn: parseBigInt(parsed.MAX_LIVE_NOTIONAL_IN, 'MAX_LIVE_NOTIONAL_IN'),
    maxLiveInflight: parsed.MAX_LIVE_INFLIGHT,
    minLiveEdgeOut: parseBigInt(parsed.MIN_LIVE_EDGE_OUT, 'MIN_LIVE_EDGE_OUT'),
    enableCamelotAmmv3: parseBoolean(parsed.ENABLE_CAMELOT_AMMV3, false),
    bridgeTokens: normalizeAddressList(parsed.BRIDGE_TOKENS, 'BRIDGE_TOKENS'),

    enableMetricsServer: parseBoolean(parsed.ENABLE_METRICS_SERVER, false),
    metricsHost: parsed.METRICS_HOST,
    metricsPort: parsed.METRICS_PORT
  };
}
