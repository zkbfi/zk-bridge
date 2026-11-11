# Redeploy plan: seal-only gate and fork proof per message (testnet, November 2026)

Status: plan, 2026-11-11. Script built and dry-run on forks of both chains (see "Dry run of 2026-11-11"). Nothing
sent. Owner: "plan the testnet redeploy", then "deploy deploy deploy".

## In one paragraph

Main now holds four changes that the running testnet contracts do not accept: the bridge reads a per-message fork
proof (no Gloas slot), the gate has the seal-only modes, the fork proof is saved by the watcher, and the backend seals
gates by itself. The bridge and the gate are immutable, so both chains get a new gate, a new bridge and, because each
layer names the one below it immutably, a new mediator, token factory and router: nine creations per chain. The SP1
verifiers, the two light clients and the fork registry of chain 943 stay (the program keys did not change: source hash
`d10d86db…`), so the GPU image stays too. The old contracts keep working, untouched, which is the rollback.

## What changes, what stays

| Contract | Sepolia (11155111) now | 943 now | This redeploy |
|---|---|---|---|
| SP1 verifier | (config) | (config) | Stays |
| `BeaconLightClient` | `0x64ddc23f…e76e4e` | `0x1dbbcc0b…1fd958` | Stays (program key unchanged) |
| `ForkRegistry` (943 only) | none | `0x0f094a96…ad063f` | Stays |
| `BeaconForkGate` | `0x1782a38a…007e20` (`Enforcing`) | `0x0e8586fb…be93` (`DetectBeaconRootsAndRegistry`) | **New**: `SealOnly` on Sepolia, `SealOnlyWithRegistry` on 943 (reads the kept registry) |
| `ReceiptProofLib`, `OpeningProofLib`, `BeaconLayoutLib` | | | **New** (`BeaconLayoutLib` changed; all three relinked) |
| `MessageBridge` (layer 1) | `0xd4b1ecc1…4c66` | `0x3846e483…aba4` | **New**: fork proof per message, no `gloasForkSlot`, names the new gate |
| `MediatorPayloads`, `TokenFactory`, `TokenMediator` (layer 2) | `0x2c006750…fa86` (mediator) | `0x8eef4098…7e62` | **New**: the code is unchanged, but the mediator names its bridge immutably |
| `DeliveryRouter` (layer 3) | `0x1c4627d7…ce8a` | `0x6e017804…fce3` | **New**: names its mediator immutably; send entries unchanged |
| Bridged copies | | | New addresses (the factory is in their salt). Old copies go back only through the old contracts |

## Code to finish before the run

1. **PulseChain auto-seal** (branch `feat/pulsechain-auto-seal`, in progress): the backend proves the fork
   observation on the GPU, posts it to the registry, then seals. Merge before the release.
2. **`RedeployLayers` deploys a new gate.** Done (branch `feat/redeploy-gates`). `REDEPLOY_MODE=layers-and-gate`
   creates a `BeaconForkGate` at the deployer nonce `n`, with the mode and beacon settings of the `gate` section of the
   file that `gateConfig` names (`script/testnet/bridge.config.testnet.json`), and the fork registry read from the old
   gate in a registry mode (943); then the eight creations of the `layers` mode at `n + 1` to `n + 8`, the bridge naming
   the new gate. Before anything is sent it requires: the section's `chainId` equals the chain; the beacon settings
   equal those of the old gate; the root and the clock equal those of the light client on the other chain that tracks
   this beacon chain; the kept registry's light client follows the same root; `SealOnly` finds the EIP-4788 contract.
   Read-back: mode, enforcing from deployment, not sealed, beacon settings, registry, allowed shapes, the compiled code
   (immutables aside), and `bridge.depositGate()` equal to the new gate, then everything the `layers` read-back checks.
   Tests: `test/hardened/RedeployLayers.t.sol`, `RedeployLayersAndGateTest` (five tests on the two chain world).
   `test/hardened/CreationGasCap.t.sol` already covers `BeaconForkGate` (7,701 bytes of runtime code).
3. **Dry run on forks** of both chains (no `--broadcast`): done, see "Dry run of 2026-11-11". The plan prints eighteen
   addresses, and every read-back passes.

## Before the run (no transactions)

1. Build from the release commit: `forge build`, `pnpm abis`, the TypeScript packages and the prover, one commit. Check
   `light-client/scripts/program-keys.sh --print-source-hash` prints `d10d86db…`.
2. **Drain the old route.** Stop the traffic bot. Let the runner deliver everything waiting on the old contracts
   (`/api/counts` in flight: zero both ways). The new runner cannot deliver old messages (the proof format changed).
3. Deployer `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc` (1Password "testnet deployer wallet"): read both nonces into
   `script/testnet/redeploy.config.testnet.json` (on 2026-11-11: 23 on Sepolia, 27 on 943, already written); check the
   balance (the run needs about 112,000,000 gas on Sepolia and about 19,000,000 on 943, measured in the dry run). Nothing
   else sends from it until the run ends. If either nonce moved, write the new one and dry-run again: every address
   below moves with it.
4. **Seal signer:** an address with a little gas on each chain for the backend's seal module (the owner provides it).
   A seal costs about 67,000 gas; an observation post more (measured in the auto-seal branch).

## Dry run of 2026-11-11

From the head of `feat/redeploy-gates` (forge 1.8.5), public RPCs, `--sender` only, no keystore, nothing sent:

```sh
export FOUNDRY_RPC_ENDPOINTS='{sepolia="https://ethereum-sepolia-rpc.publicnode.com",pulsechain_testnet_v4="https://rpc.v4.testnet.pulsechain.com"}'
REDEPLOY_CONFIG=script/testnet/redeploy.config.testnet.json REDEPLOY_MODE=layers-and-gate \
  forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
  --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc
```

It ran through `deployed on chain 11155111` and `deployed on chain 943`, so every pre-check and every read-back passed
on both forks. Read on 2026-11-11 before the run: deployer nonce 23 and 3.412 ETH on Sepolia, nonce 27 and about
44,999,000 PLS on 943; base fee 18 wei on Sepolia, 7 wei on 943. The old gates' beacon settings equal the file
(Sepolia: genesis 1655733600, 12 s, 32 slots, root `0xd8ea171f…9b8078`; 943: genesis 1681356369, 10 s, 32 slots, root
`0xd81664ba…4e64`), neither is sealed, and the 943 registry `0x0F094A96…AD063f` (kept) has observed nothing yet.

Planned addresses (they hold only at nonces 23 and 27):

| Nonce | Contract | Sepolia 11155111 (n = 23) | 943 (n = 27) |
|---|---|---|---|
| n | `BeaconForkGate` | `0xDcD7165D9941099B6657101C42CfcEb3B958557c` (`SealOnly`, no registry) | `0x8821D6bb9B4ff9CA03272ff28f4Ff39B86F2dedb` (`SealOnlyWithRegistry`, registry `0x0F094A965f280599B41f57a5182955F4afAD063f`) |
| n + 1 | `ReceiptProofLib` | `0x8eeF4098D3726955F7D227C4D1D92487C99F7e62` | `0x7929Ce878CFE538Ff9E6eE2003De2860D3f2C013` |
| n + 2 | `OpeningProofLib` | `0xBEa5F0fd3712B02c25Bda32C7719fB9373C0fA20` | `0x8D44AA6D68c29815E0A05A3c96D4608e56d80bc6` |
| n + 3 | `BeaconLayoutLib` | `0x6e0178049277442d5BF58963f9a1E0469B46Fce3` | `0xe9685cE4360a61908B563B97C6D23EF156e87883` |
| n + 4 | `MessageBridge` | `0x8821D6bb9B4ff9CA03272ff28f4Ff39B86F2dedb` | `0x1E5cE684E51EE04374171fDDEaACFFf9bF7915f5` |
| n + 5 | `MediatorPayloads` | `0x7929Ce878CFE538Ff9E6eE2003De2860D3f2C013` | `0xcE57F6f4811fDE29eecA6AC06675cF62d322D809` |
| n + 6 | `TokenFactory` | `0x8D44AA6D68c29815E0A05A3c96D4608e56d80bc6` | `0xb9bD141510036Ed0914E79d42BaB033c75b0e82C` |
| n + 7 | `TokenMediator` | `0xe9685cE4360a61908B563B97C6D23EF156e87883` | `0xd99916b2797083f9F1839Ad834BBf20e4c9749a1` |
| n + 8 | `DeliveryRouter` | `0x1E5cE684E51EE04374171fDDEaACFFf9bF7915f5` | `0xbD21879c5aE40d133cB72AfC8F4f4BAb937B4937` |

One deployer with overlapping nonce ranges puts different contracts at the same address on the two chains (the Sepolia
bridge and the 943 gate share `0x8821…dedb`; several old addresses come back in new roles, for example
`0x8eeF…7e62`, the old 943 mediator, is the new Sepolia `ReceiptProofLib`). Each address is checked on its own chain;
the deployment file names the chain of each. Forge 1.8.5 labels some dry-run transactions with the wrong
`contractName` for the same reason; the nonce order above and the read-back are what count.

Gas per creation. "Local" is Foundry's gas of the dry-run transaction (Sepolia fork); "node" is `eth_estimateGas` of the
same creation code from the deployer on the live chain. The mediator cannot be estimated before its bridge and factory
exist (its constructor reads them: the node reverts with `NoCode("bridge")`), so its figure is the estimate of its
runtime code alone plus its constructor (the local gap, 266,864 gas).

| # | Nonce | Creation | Runtime bytes | Local gas | Sepolia, node | Share of the 16,777,216 cap | 943, node |
|---|---|---|---|---|---|---|---|
| 1 | n | `BeaconForkGate` (and its probe) | 7,701 | 2,351,801 | 12,655,661 | 75.4% | 2,174,362 |
| 2 | n + 1 | `ReceiptProofLib` | 8,697 | 2,514,067 | 13,766,697 | 82.1% | 2,320,677 |
| 3 | n + 2 | `OpeningProofLib` | 6,210 | 1,814,818 | 9,890,117 | 58.9% | 1,675,216 |
| 4 | n + 3 | `BeaconLayoutLib` | 7,688 | 2,230,057 | 12,193,686 | 72.7% | 2,058,514 |
| 5 | n + 4 | `MessageBridge` (linked to 2 to 4, names 1) | 9,370 | 2,716,548 | 14,826,009 | 88.4% | 2,507,598 |
| 6 | n + 5 | `MediatorPayloads` | 6,102 | 1,784,953 | 9,722,157 | 57.9% | 1,647,649 |
| 7 | n + 6 | `TokenFactory` (names the mediator of n + 7) | 7,272 | 2,120,354 | 11,550,880 | 68.8% | 1,957,092 |
| 8 | n + 7 | `TokenMediator` | 8,536 | 2,538,450 | about 13,776,000 (runtime alone 13,509,604) | about 82.1% | about 2,538,000 (local) |
| 9 | n + 8 | `DeliveryRouter` | 8,638 | 2,526,244 | 13,785,652 | 82.2% | 2,331,932 |

Sums: about 112,200,000 gas on Sepolia (block gas limit 200,000,000), about 19,200,000 on 943; local 20,597,292 and
20,600,911. At a priority fee of 0.01 gwei over base fees of a few wei: about 0.0011 ETH and 0.0002 PLS. The balances
cover it many times over.

The previous broadcast (2026-11-08) set gas limits at 130% of the node estimate (Foundry's default multiplier): its
bridge had a limit of 19,116,259, above the EIP-7825 cap, and Sepolia mined it anyway. This run passes
`--gas-estimate-multiplier 110`, so every limit stays under the cap (the largest: 14,826,009 × 1.1 = 16,308,610) in
case Sepolia enforces it by now; the receipts of 2026-11-08 were within 1% of the node estimates.

## The run (sends transactions)

Sepolia first, then 943, nine creations each, from the deployer, in one command (the bridges and mediators name their
twins on the other chain by predicted address, so both chains belong to one run). The script stops on the first
read-back mismatch, before the next chain. Fees for both chains in the same command: a maximum fee of 1 gwei and a
priority fee of 0.01 gwei (943 never includes Foundry's 1 wei default, and on 2026-11-08 a maximum fee below the
priority fee stalled the 943 part; the Sepolia part of that run paid 0.01 gwei per gas with a 1 gwei maximum).

```sh
export FOUNDRY_RPC_ENDPOINTS='{sepolia="<sepolia url>",pulsechain_testnet_v4="<943 url>"}'
cast wallet address --account "$KEYSTORE_NAME"   # must print 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc
cast nonce 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc --rpc-url sepolia                 # must be 23
cast nonce 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc --rpc-url pulsechain_testnet_v4   # must be 27
REDEPLOY_CONFIG=script/testnet/redeploy.config.testnet.json REDEPLOY_MODE=layers-and-gate \
  forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
  --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc \
  --broadcast --slow --skip-simulation --gas-estimate-multiplier 110 \
  --with-gas-price 1000000000 --priority-gas-price 10000000 2>&1 | redact | tee "$RUN_DIR/redeploy-gates.log"
```

If the 943 part stalls, resume it with the same flags plus `--resume --multi`; never rerun without `--resume` (the
nonces have moved, and the script refuses them).

## After the run

1. **Deployment file** on the server (prover `deployment-file`, mode 0600): new `gate`, `bridge`, `mediator`,
   `token_factory`, `delivery_router`; `start_block` = the block before the first creation on each chain; the
   `light_client`, `fork_registry` and `light_client_start_block` unchanged. Commit
   `deploy/deployments/sepolia-pls943.json`; archive the old one under `deploy/deployments/archive/`.
2. **Runner state reset** (the `depositsOpen` flag is not keyed by bridge): fresh state file per direction. The proof
   cache is keyed by the light client and stays. The runner then opens both bridges after a light-client update and
   sends the layout rows before the first delivery (both automatic).
3. **Indexer: blue/green reindex** from the new start blocks (`deploy/ansible/indexer.yml` green, switch, finish). The
   old pair's history is not carried over.
4. **Backend, runner, traffic bot, status:** point at the new deployment file; turn on the seal module with the seal
   signer; the status page's gate checks read the new gates.
5. **Dapp and terminal: release `next`** with the new deployment and ABIs, after the bridges are open. Only on the
   owner's word.
6. **Smoke test (sends transactions):** one router relay each way, delivered; the seal module simulates a seal on
   both chains and gets "shape is allowed" (no seal: both chains are on supported forks); the fork pause shows the next
   scheduled fork on Explore.

## Rollback

Nothing on chain needs undoing. Point the deployment file, the bots, the indexer and the release back at the archived
addresses with the previous release of the off-chain code (it reads the old proof format).

## Open

- Drain or a second runner: on testnet, drain (step 2) is enough; the old copies of test tokens stay old.
- Release timing: the dapp release waits for the owner.
