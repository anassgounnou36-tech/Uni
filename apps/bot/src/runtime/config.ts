import { z } from 'zod';

const HEX_ADDR = /^0x[a-fA-F0-9]{40}$/;

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
    .map((entry) => parseBigInt(entry, 'candidateBlocks'));
}

function parseCanaryPairs(value: string): Array<{ inputToken: `0x${string}`; outputToken: `0x${string}` }> {
  if (!value.trim()) {
    return [];
  }
  return value.split(',').map((entry) => {
    const [inputToken, outputToken] = entry.split(':').map((part) => part.trim());
    if (!inputToken || !outputToken || !HEX_ADDR.test(inputToken) || !HEX_ADDR.test(outputToken)) {
      throw new Error('Invalid CANARY_ALLOWLISTED_PAIRS format');
    }
    return {
      inputToken: inputToken as `0x${string}`,
      outputToken: outputToken as `0x${string}`
    };
  });
}

const baseSchema = z.object({
  READ_RPC_URL: z.string().url(),
  FORK_RPC_URL: z.string().url().optional(),
  SEQUENCER_URL: z.string().url(),

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
  CANDIDATE_BLOCKS: z.string().default('1000,1001,1002'),
  COMPETE_WINDOW_BLOCKS: z.string().default('2'),
  THRESHOLD_OUT: z.string().default('1'),

  SHADOW_MODE: z.string().optional(),
  CANARY_MODE: z.string().optional(),
  CANARY_ALLOWLISTED_PAIRS: z.string().default(''),
  MAX_LIVE_NOTIONAL_IN: z.string().default('0'),
  MAX_LIVE_INFLIGHT: z.coerce.number().int().nonnegative().default(0),
  MIN_LIVE_EDGE_OUT: z.string().default('0'),

  ENABLE_METRICS_SERVER: z.string().optional(),
  METRICS_HOST: z.string().default('0.0.0.0'),
  METRICS_PORT: z.coerce.number().int().positive().default(9100)
});

export type RuntimeConfig = {
  readRpcUrl: string;
  forkRpcUrl?: string;
  sequencerUrl: string;

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
  candidateBlocks: bigint[];
  competeWindowBlocks: bigint;
  thresholdOut: bigint;

  shadowMode: boolean;
  canaryMode: boolean;
  canaryAllowlistedPairs: Array<{ inputToken: `0x${string}`; outputToken: `0x${string}` }>;
  maxLiveNotionalIn: bigint;
  maxLiveInflight: number;
  minLiveEdgeOut: bigint;

  enableMetricsServer: boolean;
  metricsHost: string;
  metricsPort: number;
};

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = baseSchema.parse(env);
  return {
    readRpcUrl: parsed.READ_RPC_URL,
    forkRpcUrl: parsed.FORK_RPC_URL,
    sequencerUrl: parsed.SEQUENCER_URL,

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
    candidateBlocks: parseBigIntList(parsed.CANDIDATE_BLOCKS),
    competeWindowBlocks: parseBigInt(parsed.COMPETE_WINDOW_BLOCKS, 'COMPETE_WINDOW_BLOCKS'),
    thresholdOut: parseBigInt(parsed.THRESHOLD_OUT, 'THRESHOLD_OUT'),

    shadowMode: parseBoolean(parsed.SHADOW_MODE, true),
    canaryMode: parseBoolean(parsed.CANARY_MODE, false),
    canaryAllowlistedPairs: parseCanaryPairs(parsed.CANARY_ALLOWLISTED_PAIRS),
    maxLiveNotionalIn: parseBigInt(parsed.MAX_LIVE_NOTIONAL_IN, 'MAX_LIVE_NOTIONAL_IN'),
    maxLiveInflight: parsed.MAX_LIVE_INFLIGHT,
    minLiveEdgeOut: parseBigInt(parsed.MIN_LIVE_EDGE_OUT, 'MIN_LIVE_EDGE_OUT'),

    enableMetricsServer: parseBoolean(parsed.ENABLE_METRICS_SERVER, false),
    metricsHost: parsed.METRICS_HOST,
    metricsPort: parsed.METRICS_PORT
  };
}
