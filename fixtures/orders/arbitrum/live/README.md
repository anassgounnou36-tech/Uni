# Arbitrum Dutch_V3 live fixtures

These fixtures store reactor-ready order payload fields from the Orders API response shape.

| Fixture | Capture timestamp | Chain ID | Endpoint | Returned `orderHash` | Signature note |
| --- | --- | --- | --- | --- | --- |
| `live-01.json` | `2026-03-13T00:00:00Z` | `42161` | `/v2/orders?chainId=42161&orderType=Dutch_V3&orderStatus=open` | `0x3efd647626a32590eff1daa3d028ebcbd9553dbe2a144c50980cdcffc60a9c92` | Structurally present (`bytes` payload). Not independently re-verified against remote cosigner state in this repo. |
| `live-02.json` | `2026-03-13T00:00:00Z` | `42161` | `/v2/orders?chainId=42161&orderType=Dutch_V3&orderStatus=open` | `0x3fc449bc56addd3be3315a4037d5432a656c5a2716469ba0ad3533ec3190b6c5` | Structurally present (`bytes` payload). Not independently re-verified against remote cosigner state in this repo. |
| `live-03.json` | `2026-03-13T00:00:00Z` | `42161` | `/v2/orders?chainId=42161&orderType=Dutch_V3&orderStatus=open` | `0x3efd647626a32590eff1daa3d028ebcbd9553dbe2a144c50980cdcffc60a9c92` | Structurally present (`bytes` payload). Not independently re-verified against remote cosigner state in this repo. |
