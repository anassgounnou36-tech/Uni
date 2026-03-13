# V3Dutch mirror parity notes

This mirror follows the upstream `V3DutchOrderReactor` execution order and math from UniswapX (`src/reactors/V3DutchOrderReactor.sol` and linked libs).

## Stage mapping

1. **Decode** (`decodeSignedOrder`)
   - ABI decode `V3DutchOrder` from encoded order bytes.
2. **Hash before overrides** (`computeOrderHash`)
   - Uses `V3DutchOrderLib.hash` shape and type hashes.
   - Hash is always computed from the base order, before cosigner or gas adjustments.
3. **Validate** (`validateOrder`)
   - Deadline check: `deadline < timestamp` reverts.
   - Cosigner check: digest is `keccak256(orderHash || chainId || abi.encode(cosignerData))`.
4. **Cosigner overrides** (`applyCosignerOverrides`)
   - `inputAmount == 0` keeps base input.
   - `inputAmount > baseInput.startAmount` is invalid.
   - `outputAmounts.length` must equal `baseOutputs.length`.
   - Any non-zero output override must be `>= baseOutputs[i].startAmount`.
5. **Gas adjustment** (`applyGasAdjustment`)
   - `gasDeltaWei = basefee - startingBaseFee`.
   - Delta rounding mirrors reactor:
     - gas increase (`>= 0`): `mulDivDown`
     - gas decrease (`< 0`): `mulDivUp`, then negated
   - Input uses bounded add into `[0, maxAmount]`.
   - Output uses bounded sub into `[minAmount, uint256.max]`.
6. **Decay resolution** (`decayInput` / `decayOutputs`)
   - Uses nonlinear curve interpolation and the same swapper-favoring rounding behavior as `NonlinearDutchDecayLib`.
7. **Exclusivity override** (`resolveAt`)
   - Applied after resolution.
   - If caller lacks filling rights and override bps is zero, it fails.
   - Otherwise each output is scaled with `mulDivUp(amount, 10_000 + bps, 10_000)`.

## `BlockNumberish` semantics (important)

The upstream contract does **not** always use the raw `block.number` opcode:

- On Arbitrum One (`chainid == 42161`), it uses `ArbSys(0x64).arbBlockNumber()`.
- On other chains, it uses `block.number`.

Mirror implication:

- `resolveAt` accepts `env.blockNumberish` directly.
- Callers must pass the chain-correct block-like value (Arbitrum syscall number on 42161).
- Tests include explicit `blockNumberish` scenarios to guarantee parity logic is keyed off this value instead of naive block number assumptions.

## Integer rounding summary

- Gas adjustment delta:
  - positive gas delta -> floor division
  - negative gas delta -> ceil division, then negate
- Decay interpolation:
  - input path rounds to reduce swapper cost
  - output path rounds to improve swapper receive amount
- Exclusivity override uses ceil division.
