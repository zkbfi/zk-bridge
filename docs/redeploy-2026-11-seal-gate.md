# Redeploy plan: seal-only gate and fork proof per message (testnet, November 2026)

Status: plan, 2026-11-11. Nothing sent. Owner: "plan the testnet redeploy".

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
2. **`RedeployLayers` deploys a new gate.** Today it reads the gate from the old bridge and keeps it. Add a mode
   (`layers-and-gate`) that creates a `BeaconForkGate` first, with the mode and beacon settings from
   `script/testnet/bridge.config.testnet.json`, the registry read from the old gate on 943, then the eight creations as
   before, naming the new gate. Read-back: the gate's mode, its registry, its beacon settings, and
   `bridge.depositGate()` equal to it. A creation gas test entry for the gate (7,701 bytes, under the cap).
3. **Dry run on forks** of both chains (no `--broadcast`): the plan prints eighteen addresses, and every read-back
   passes.

## Before the run (no transactions)

1. Build from the release commit: `forge build`, `pnpm abis`, the TypeScript packages and the prover, one commit. Check
   `light-client/scripts/program-keys.sh --print-source-hash` prints `d10d86db…`.
2. **Drain the old route.** Stop the traffic bot. Let the runner deliver everything waiting on the old contracts
   (`/api/counts` in flight: zero both ways). The new runner cannot deliver old messages (the proof format changed).
3. Deployer `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc` (1Password "testnet deployer wallet"): read both nonces into
   `script/testnet/redeploy.config.testnet.json`; check the balance (about 110,000,000 gas on Sepolia, about
   19,000,000 on 943, measured in the dry run). Nothing else sends from it until the run ends.
4. **Seal signer:** an address with a little gas on each chain for the backend's seal module (the owner provides it).
   A seal costs about 67,000 gas; an observation post more (measured in the auto-seal branch).

## The run (sends transactions)

Sepolia first, then 943, nine creations each, from the deployer, `--broadcast --slow --skip-simulation`; 943 with
`--priority-gas-price 10000000` (its 1 wei default never lands). The script stops on the first read-back mismatch,
before the next chain.

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
