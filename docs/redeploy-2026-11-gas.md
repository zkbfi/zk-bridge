# Redeploy plan: gas reverts up (testnet, November 2026)

Status: a plan. Nothing here has been sent. Every step that sends a transaction says so. The owner runs it.

Owner, 2026-11-01: "yes, build it test-first and show me the redeploy plan." The design is in
`docs/hardened-build-contract.md`, "Gas reverts up, and three layers", and `docs/superpowers/specs/2026-11-01-gas-revert-up.md`.

## In one paragraph

Layers 1 and 2 change: a new `MessageBridge` and a new `TokenMediator` (with its `TokenFactory`) on both chains. They
cannot be upgraded, so this redeploy sets them in stone for the testnet. Layer 3 changes too: a new `DeliveryRouter`
on both chains, because the old router talks to the old mediator and reads a four word director. Everything below the
message layer stays: the SP1 verifiers, the two light clients, the own-chain light client and the fork registry of chain
943, and the two deposit gates. None of them names a bridge, a mediator or a router (the gate's `admit` takes any
caller, and the light clients and the registry name only their verifier). The new contracts are deployed by
`script/hardened/RedeployLayers.s.sol`, which reads every kept value from the running contracts, so nothing that stays
can drift. The old contracts keep working until the bots, the indexer and the dapp switch, which is the rollback.

## What changes, what stays

| Contract | Chain A (Sepolia 11155111) now | Chain B (943) now | This redeploy |
|---|---|---|---|
| SP1 verifier | (config) | (config) | **Stays.** |
| `BeaconLightClient` (tracks the other chain) | `0x64ddc23f...e76e4e` | `0x1dbbcc0b...1fd958` | **Stays.** Its program key, its head and its committees do not depend on the bridge. |
| Own-chain light client, `ForkRegistry` | none | registry `0x0f094a96...ad063f` | **Stays.** |
| `BeaconForkGate` | `0x1782a38a...007e20` | `0x0e8586fb...be93` | **Stays.** `admit(bytes)` has no caller check, so the new bridges use the same gates. Confirmations of an epoch carry over. |
| `MessageBridge` (layer 1) | `0xb01856ab...afb21` | `0xf59dfaa7...031fd1` | **New.** Revert-up delivery, no `Failed` status, no gas guard or range, `localChainId` from `block.chainid`, storage layout moved (layout tables at slots 4 to 6). |
| `TokenMediator` (layer 2) | `0x1dbbcc0b...1fd958` | `0xb4ba2fd9...44ae` | **New.** No gas rules; `relayTokensAndCall(..., callbackGas)`; the `...AndCall` handlers carry `callbackGas`; `remoteChainId` read from the bridge. |
| `TokenFactory` (made by the mediator) | `0xfbf978a1...160237` | `0x94dadbde...eef71` | **New** (inside the mediator's constructor). Home chain name immutable. The copies of tokens get new addresses, because the factory address is in their salt. |
| `DeliveryRouter` (layer 3) | `0x759b764d...f6a329` | `0x988a6160...6538f` | **New.** Five word director with `callGas`; the follow-up call gets exactly `callGas`; the source entry points pass `callbackGas`. |
| Bridged copies of tokens | (minted by the old mediators) | | Old copies stay where they are and can only go back through the old contracts (see "Tokens in flight"). |
| Test tokens (`DeployTestTokens.s.sol`) | `deploy/deployments/sepolia-pls943.test-tokens.json` | | **Stay.** They are plain native tokens; the new mediators deploy new copies on first use. |

Bytecode changes, so every address of a new contract is new. The addresses depend only on the deployer and its nonce
on each chain; `RedeployLayers.plan(deployer, nonce)` prints them before anything is sent.

## Before the run (no transactions)

1. Merge `feat/gas-revert-up` and build the release from it (contracts, bots, indexer, backend, dapp, terminal), as
   for any release. `forge build`, `pnpm abis` (ABIs in `explorer/data/src/abis`), the TypeScript packages and the
   prover build from the same commit.
2. Drain or pause in-flight traffic on the old contracts (see "Tokens in flight"): stop the traffic bot (it sends
   through the old mediator), and let the runner deliver what is waiting.
3. Read the deployer nonces and write them into `script/testnet/redeploy.config.testnet.json` (the file refuses its
   placeholders by name):

   ```sh
   cast nonce 0x444b15380A4560555326158D6799914186937Ec2 --rpc-url sepolia
   cast nonce 0x444b15380A4560555326158D6799914186937Ec2 --rpc-url pulsechain_testnet_v4
   ```

   The script reads the running contracts from `previousBridge`, `previousMediator` and `previousRouter` (already
   filled from `deploy/deployments/sepolia-pls943.json`).
4. Dry run (no `--broadcast`, nothing reaches a chain). It connects to both chains, checks the chain identifiers and
   the nonces, reads the kept values, prints the plan, and runs the deployment and the read-back on forks:

   ```sh
   REDEPLOY_CONFIG=script/testnet/redeploy.config.testnet.json REDEPLOY_MODE=layers \
     forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
     --account "$KEYSTORE_NAME" --sender 0x444b15380A4560555326158D6799914186937Ec2
   ```

## The deployment (sends transactions)

Order: Sepolia first, then chain 943, three transactions on each, all from the deployer
`0x444b15380A4560555326158D6799914186937Ec2`. Both bridges and both mediators name their twins on the other chain by
predicted address, so the nonce of each chain must not move between the dry run and the run; nothing else may send
from the deployer meanwhile.

```sh
REDEPLOY_CONFIG=script/testnet/redeploy.config.testnet.json REDEPLOY_MODE=layers \
  forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
  --account "$KEYSTORE_NAME" --sender 0x444b15380A4560555326158D6799914186937Ec2 \
  --broadcast --slow --skip-simulation 2>&1 | redact | tee "$RUN_DIR/redeploy.log"
```

`--skip-simulation` and `--slow` for the reason of `docs/testnet-run.md` step 5: Sepolia charges about 7 times what
Foundry counts for new code, so Foundry must ask the node for each estimate. Chain 943 needs a priority fee above
0.001 gwei (memory: the default of 1 wei never gets included); add `--priority-gas-price 10000000` for its part, or run
the chains one at a time if one command cannot carry both fee settings.

The local figures are estimates from the code sizes (`forge build --sizes`) and the deploy of 2026-10-26, whose
contracts were within a few hundred bytes of these; the dry run prints the real local figures, and with
`--skip-simulation` the node gives the real estimate of each transaction when it is sent.

| # | Chain | Nonce | Transaction | Local gas, estimated | Estimate on the chain |
|---|---|---|---|---|---|
| 1 | Sepolia | n_A | create `MessageBridge` | about 5,000,000 (runtime 22,554 bytes; the old bridge, 22,465 bytes, used 5,006,027) | about 7 x local (old bridge: 5,006,027 local, 35,838,770 estimated) |
| 2 | Sepolia | n_A + 1 | create `TokenMediator` (creates `TokenFactory`) | about 5,700,000 (mediator 12,291 and factory 7,272 bytes of runtime; the old pair used 5,693,201) | about 7 x local (old: 5,693,201 local, 40,484,761 estimated) |
| 3 | Sepolia | n_A + 2 | create `DeliveryRouter` | about 1,400,000 (runtime 7,993 bytes; the old router used 1,396,348) | about 7 x local (old: 1,396,348 local, 9,824,883 estimated) |
| 4 | 943 | n_B | create `MessageBridge` | about 5,000,000 (runtime 22,554 bytes; the old bridge, 22,465 bytes, used 5,006,027) | about 1.2 x local |
| 5 | 943 | n_B + 1 | create `TokenMediator` | about 5,700,000 (mediator 12,291 and factory 7,272 bytes of runtime; the old pair used 5,693,201) | about 1.2 x local |
| 6 | 943 | n_B + 2 | create `DeliveryRouter` | about 1,400,000 (runtime 7,993 bytes; the old router used 1,396,348) | about 1.2 x local |

Sepolia's block gas limit (200,000,000) holds each transaction; EIP-7825 caps one transaction at 16,777,216 gas, and
the old Sepolia estimates of the bridge and the mediator were above that. Check, as `docs/testnet-run.md` step 5 asks,
that the Foundry version and the node accept such a transaction before the run; if they do not, this redeploy cannot
go to Sepolia until the cap question is settled for the first deployment too. Chain 943's block gas limit is about
30,000,000, so each transaction fits.

The script reads every value back from the new contracts and stops on the first mismatch
(`DeploymentMismatch(<field>)`), before the next chain. It prints the new addresses.

## After the deployment

These steps send transactions only where they say so. The runner does the on-chain ones by itself.

1. **Deployment file on the server.** Write the new `deployment.json` (mode 0600) with the prover's
   `deployment-file` command, as in `docs/testnet-run.md` step 5: the same light client, gate and registry addresses,
   the new `bridge`, `mediator`, `token_factory` and `delivery_router`, and `start_block` of each chain = the block
   before its first redeploy transaction. Commit `deploy/deployments/sepolia-pls943.json` with the new addresses
   (the old file goes to `deploy/deployments/archive/sepolia-pls943.2026-10.json`, so the old pair can still be read).
2. **Open the new bridges (sends transactions, automatic).** Both new bridges start locked. The runner opens each
   with `openDeposits` after an update of the light client of its own chain (`docs/testnet-run.md` step 8). **Reset the
   runner state first:** the state file of each direction keeps one `depositsOpen` flag, not keyed by bridge, and it is
   `true` for the old bridges, so the runner would never try to open the new ones. Start each direction with a fresh
   state file (or set `depositsOpen` to `false`); its spend records start over with it.
3. **Layout rows (sends transactions, automatic).** The new bridges have no `block_roots`, block hash or
   `historical_summaries` rows. The evidence of the first delivery lists them as prerequisites, and the runner sends
   them before `executeMessage` (`docs/hardened-build-contract.md`, step 7 of the launch sequence).
4. **Gate.** Nothing: the gates stay, and the traffic bot and the dapp confirm the epoch before a send from Sepolia as
   today (`ensureGateConfirmed`).
5. **Indexer: reindex.** The schema changed (no `gasLimit`, no `deliveredSuccess`, no `failed_call`), so the indexer
   needs a fresh database: new `start_block`s from the deployment file, the new bridge, mediator and router addresses,
   and a full reindex from there. The old pair's history is not carried over; if it must stay visible, run the old
   indexer read-only on its own database until it is no longer needed.
6. **Backend, runner, traffic.** Point `deploymentFile` at the new file; rename `proofCheckGas` to
   `deliveryGasFallback` in the runner configuration (the bots refuse the old name); the runner's `deliveryRouter`
   list is an operator allowlist and takes the new router addresses. The traffic bot's `newCopyGasLimit` is ignored now
   and can be deleted from its configuration.
7. **Dapp and terminal.** The release carries the new deployment (pair `sepolia-pls943` in
   `explorer/shared/src/pairs.ts` reads the deployment file) and the new ABIs; a relay with a call now passes
   `callbackGas` from `routerCallbackGas`.
8. **Test tokens.** Keep them. Their first relay through a new mediator deploys a new copy (no gas number is needed:
   the executor brings the gas). The traffic bot's token list names native tokens, so it needs no change.
9. **Smoke test (sends transactions).** One relay each way through the router, as `docs/testnet-run.md` step 11:
   check `TokensBridged` on the destination, `AffirmationCompleted(..., true)`, and that a delivery with too little gas
   reverts and leaves the message waiting.

## Layer 3 later, alone

A new router needs no change to layers 1 and 2. On one chain:

```sh
REDEPLOY_CONFIG=<file whose previousRouter is the router to replace> REDEPLOY_MODE=router REDEPLOY_CHAIN=chainA \
  forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers --account "$KEYSTORE_NAME" --sender <deployer> \
  --broadcast --slow --skip-simulation
```

One transaction (create `DeliveryRouter`, about 1,400,000 local gas) for the running mediator, with the kept wrapped
token, reward address and failed delivery address. Then add it to the runner's router allowlist and to the frontends
(`isKnownDeliveryRouter` is the frontend's own list). Messages already sent to the old router are still delivered to
it: a router is the receiver named in each message, so the old router keeps working for them.

## Tokens in flight

- A message sent through the old mediator can only be delivered by the old bridge on the other chain, and the old
  bridge keeps working (it is not paused and has no owner). Keep the runner on the old deployment until it has nothing
  to deliver, or run a second runner on the old file for a while.
- Native tokens locked in an old mediator come back only through the old contracts: a holder of an old copy relays it
  back through the old mediator on its chain. Copies made by the old mediators are not copies of the new ones.
- On the testnet the amounts are test tokens. Drain them with the traffic bot stopped, or accept that the old copies
  stay old.

## Rollback

Nothing on chain needs undoing: the old contracts keep working, untouched. Roll back by pointing the deployment file,
the bots, the indexer and the release back at the old addresses (the archived deployment file), with the previous
release of the off-chain code (the new off-chain code reads the new ABIs and the five word director). Tokens sent
through the new contracts meanwhile stay in the new contracts and are delivered by them.
