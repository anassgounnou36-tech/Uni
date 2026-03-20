# Bot runtime configuration

## Start command

```bash
pnpm bot:start
```

## Environment variables

### Connectivity
- `READ_RPC_URL` (required): read RPC endpoint for chain state.
- `FORK_RPC_URL` (optional): fork RPC endpoint for simulation/testing.
- `SEQUENCER_URL` (required): sequencer RPC endpoint used for send path.
- `DATABASE_URL` (optional but required outside shadow-dev): enables Postgres-backed runtime state components.
- `ALLOW_EPHEMERAL_STATE` (default `false`): permits in-memory state only for explicit shadow/dev runs.
- `SIGNER_PRIVATE_KEY` (optional): runtime signer key used by prepared execution builder (dev default is an anvil key).
- `EXECUTOR_ADDRESS` (default `0x3333...3333`): executor target for built execution plans.

### Ingress
- `POLL_CADENCE_MS` (default `1000`): polling interval for Orders API backstop.
- `ENABLE_WEBHOOK_INGRESS` (default `false`): enables webhook HTTP ingress.
- `WEBHOOK_HOST` (default `0.0.0.0`): webhook server bind host.
- `WEBHOOK_PORT` (default `8080`): webhook server bind port.
- `WEBHOOK_PATH` (default `/uniswapx/webhook`): POST endpoint path.
- `TRUST_PROXY` (default `false`): use `x-forwarded-for` when true; otherwise socket IP only.
- `ALLOWED_WEBHOOK_CIDRS` (default `3.14.56.90/32`): comma-separated source CIDRs.
- `MAX_WEBHOOK_BODY_BYTES` (default `1048576`): maximum webhook body bytes.

### Scheduling
- `SCHEDULER_CADENCE_MS` (default `500`): scheduler loop interval.
- `HOT_LANE_CADENCE_MS` (default `200`): hot-lane loop interval.
- `CANDIDATE_BLOCK_OFFSETS` (default `0,1,2`): candidate offsets applied to current resolve-env blockNumberish each scheduler tick (`blockNumberish` is the chain-native scheduling number, e.g. ArbSys block number on Arbitrum).
- `COMPETE_WINDOW_BLOCKS` (default `2`): compete window width in blocks.
- `THRESHOLD_OUT` (default `1`): minimum output-unit edge threshold.

`CANDIDATE_BLOCKS` is deprecated and now rejected at startup; use `CANDIDATE_BLOCK_OFFSETS`.

## Replay CLI

Use replay to reproduce dropped/scheduled decisions without scanning live logs:

```bash
pnpm --filter @uni/bot replay --order-hash <hash>
```

Optional fixture override:

```bash
pnpm --filter @uni/bot replay --order-hash <hash> --fixture fixtures/orders/arbitrum/live/live-01.json
```

The command emits one compact JSON summary including resolved input/output, decision path, and replay diagnostics.

### Mode and safety
- `SHADOW_MODE` (default `true`): all sends are shadowed; no broadcast.
- `CANARY_MODE` (default `false`): enables live send gating by pair/edge/notional/inflight.
- `CANARY_ALLOWLISTED_PAIRS` (default empty): `input:output,input:output` token pairs.
- `MAX_LIVE_NOTIONAL_IN` (default `0`): max allowed input notional for live.
- `MAX_LIVE_INFLIGHT` (default `0`): max inflight live sends.
- `MIN_LIVE_EDGE_OUT` (default `0`): min route edge required for live.

### Telemetry
- `ENABLE_METRICS_SERVER` (default `false`): expose Prometheus `/metrics` endpoint.
- `METRICS_HOST` (default `0.0.0.0`): metrics bind host.
- `METRICS_PORT` (default `9100`): metrics bind port.

## Safe defaults
- Keep `SHADOW_MODE=true` by default.
- Keep `CANARY_MODE=false` until pair-level guardrails are configured.
- Keep `ENABLE_WEBHOOK_INGRESS=false` until allowlist CIDRs and trust proxy are validated.
- Keep `ALLOW_EPHEMERAL_STATE=false` by default and set `DATABASE_URL` for any non-shadow operational runtime.

## Durable state boot policy
- Live/canary boot requires `DATABASE_URL`; startup fails fast with `databaseUrl is required for live/canary mode` when missing.
- In-memory journal/store are only allowed when `SHADOW_MODE=true` **and** `ALLOW_EPHEMERAL_STATE=true`.
- If shadow is enabled but ephemeral mode is not explicitly allowed and no `DATABASE_URL` is provided, startup fails fast with `ephemeral order store is not allowed outside shadow dev mode`.
- Durable mode now requires a real Postgres adapter probe (`SELECT 1`) at boot; startup fails with `failed to create Postgres adapter for durable runtime` when connection/probe fails.
- In live/canary mode, journal, order store, and nonce ledger must all be durable Postgres-backed components; there is no silent fallback to in-memory implementations.

## Execution modes
- **Shadow**: enabled when `SHADOW_MODE=true`; simulation and decisioning run, but no live broadcast.
- **Canary**: enabled when `SHADOW_MODE=false` and `CANARY_MODE=true`; live sends require allowlisted pair + min edge + notional + inflight checks.
- **Live**: enabled when `SHADOW_MODE=false` and `CANARY_MODE=false`; orders can proceed to live send path.
