# Recorded chain specification answers

Each file is the body of one real answer to `GET /eth/v1/config/spec` from a beacon node. The tests of
`src/fork_schedule.rs` read them, so the fork rules run against what real nodes publish, placeholder rows included.

Fetched on 2026-10-27. The file contents are public chain configuration only: fork versions and epochs, preset values,
the deposit contract address and similar constants. They hold no key, no token and no personal data. A scan of every
key and value found only configuration names and numbers.

| File | Chain | Client | What it shows |
|---|---|---|---|
| `pulsechain-testnet-v4.json` | PulseChain testnet v4 | not published by the host (rpc-testnet-pulsechain.g4mm4.io/beacon-api) | Deneb at the far future epoch with the placeholder version `0xffffffff` |
| `sepolia.json` | Sepolia | Lodestar (lodestar-sepolia.chainsafe.io) | Gloas at epoch 353024. Heze at the far future epoch with the version `0x08000000` |
| `ethereum-mainnet-lodestar.json` | Ethereum mainnet | Lodestar (lodestar-mainnet.chainsafe.io) | Fulu at epoch 411392. Gloas and Heze at the far future epoch |
| `ethereum-mainnet-publicnode.json` | Ethereum mainnet | not published by the host (ethereum-beacon-api.publicnode.com) | The same fork rows as the Lodestar file, with fewer keys |

The host of each file is in the Client column. All four are public keyless endpoints.
