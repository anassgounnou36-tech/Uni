# Webhook operations

## Endpoint

- Method: `POST`
- Path: configured by `WEBHOOK_PATH` (default `/uniswapx/webhook`)
- Response codes:
  - `202` accepted
  - `400` malformed payload/body
  - `403` IP not allowlisted
  - `500` internal error

## IP allowlist behavior

- Default allowlist: `3.14.56.90/32`.
- Requests are accepted only when the resolved client IP matches an allowlisted CIDR.

## `TRUST_PROXY` behavior

- `TRUST_PROXY=false` (default): resolve client IP from socket remote address only.
- `TRUST_PROXY=true`: use the left-most IP from `x-forwarded-for`, with fallback to socket remote address.

## Poller + webhook reconciliation

- Polling and webhook payloads both flow into a single `HybridIngressCoordinator`.
- Dedupe is by canonical verified `orderHash`.
- The first successful sighting sets first-seen metadata (time/source).
- Later sightings from the other source are stored as confirmations and journaled as deduped sightings.

## Backstop model

Polling remains enabled as the backstop source of truth even when webhook ingress is enabled.
