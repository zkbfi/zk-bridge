# Harness notes

## Anvil flags

Both chains run with exactly the flags the build contract fixes:

```
anvil --port 18545 --chain-id 1   --hardfork prague --silent
anvil --port 18546 --chain-id 369 --hardfork prague --silent
```

No extra flags were needed. A full `updateSyncState` call carries 342 signatures (65 bytes
each) and 342 Merkle proofs (9 hashes of 32 bytes each), near 320 kilobytes of calldata.
Anvil's defaults, including the request size limit, accepted it without `--no-request-size-
limit`, `--code-size-limit`, or `--disable-block-gas-limit`. Those flags were never needed.

One real gotcha did surface, and it is about gas, not calldata size. Anvil reserves a
transaction's requested gas LIMIT, not its gas used, when it decides what else fits in the same
block. A test that asked for `gas: 30_000_000n` on two transactions (the whole block limit,
each) could only ever get one of them mined per block. That broke the mempool front-run in
H-01, until the request was lowered to `8_000_000n` per transaction.

## Gas measured (H-15)

A single `updateSyncState` call with 342 signatures and 342 Merkle proofs used
**5,446,230 gas** (measured in `test/h15-update-gas-cost.test.ts`). The specification calls the
bridge "0% fee", so nobody is paid to cover this cost; whoever needs the next withdrawal pays it.

## `eth_getBlockReceipts` and the header RLP

Anvil 1.6.0-nightly has no `debug_getRawHeader` or `debug_getRawReceipts`. The host
(`src/prover/host.ts`) rebuilds the header RLP from `eth_getBlockByNumber` fields in Prague
fork order and checks that its keccak256 equals the block hash before trusting it; it rebuilds
each receipt's consensus encoding from `eth_getBlockReceipts` the same way. Both checks are
proven against real Anvil blocks, including a block with a type-2 (EIP-1559) transaction, in
`test/receipts.test.ts`.

## Deviations from the build contract

None of substance. One naming choice: `BuildUpdateOptions.nextCommitteeRoot` defaults to the
all-zero hash (`ZERO_HASH`) rather than an empty string, matching `LightClientSync`'s own
check (`nextCommitteeRoot != bytes32(0)`) for "keep the current committee."

## Open problems

None. All 17 tests pass across 11 files (`pnpm --dir harness test`), and
`pnpm --dir harness exec tsc --noEmit` reports no errors.
