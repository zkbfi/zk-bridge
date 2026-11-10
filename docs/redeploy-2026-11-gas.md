# Redeploy plan: gas reverts up (testnet, November 2026)

Status: **done on 2026-11-08.** The new layers are deployed on both chains and the services run on them; see "What
happened on 2026-11-08" for the record. The rest of this page is the plan as it was run, kept for the next redeploy.

Owner, 2026-11-01: "yes, build it test-first and show me the redeploy plan." The design is in
`docs/hardened-build-contract.md`, "Gas reverts up, and three layers", and `docs/superpowers/specs/2026-11-01-gas-revert-up.md`.

Owner, 2026-11-07, verbatim, in order: "do it all now", "wait, wtf? gas-revert-up? why was this held back?", "lets just
split them now".

## In one paragraph

Layers 1 and 2 change: a new `MessageBridge` and a new `TokenMediator` (with its `TokenFactory`) on both chains. They
cannot be upgraded, so this redeploy sets them in stone for the testnet. Layer 3 changes too: a new `DeliveryRouter`
on both chains, because the old router talks to the old mediator and reads a four word director. Since 2026-11-07 the
bridge and the mediator are split so that every creation stays under the per-transaction gas cap of EIP-7825: four
external libraries (`ReceiptProofLib`, `OpeningProofLib`, `BeaconLayoutLib` for the bridge, `MediatorPayloads` for the
mediator) and the token factory are transactions of their own, eight creations on each chain. Everything below the
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
| `ReceiptProofLib`, `OpeningProofLib`, `BeaconLayoutLib` | none | none | **New.** External libraries linked into the bridge (the split for the gas cap). No owner, no storage. |
| `MessageBridge` (layer 1) | `0xb01856ab...afb21` | `0xf59dfaa7...031fd1` | **New.** Revert-up delivery, no `Failed` status, no gas guard or range, `localChainId` from `block.chainid`, storage layout moved (layout tables at slots 4 to 6). |
| `MediatorPayloads` | none | none | **New.** External library linked into the mediator: the sending side, the payloads, the copy deployment. |
| `TokenFactory` | `0xfbf978a1...160237` | `0x94dadbde...eef71` | **New**, deployed on its own just before the mediator, naming the predicted mediator. Home chain name immutable. The copies of tokens get new addresses, because the factory address is in their salt. |
| `TokenMediator` (layer 2) | `0x1dbbcc0b...1fd958` | `0xb4ba2fd9...44ae` | **New.** No gas rules; `relayTokensAndCall(..., callbackGas)`; the `...AndCall` handlers carry `callbackGas`; `remoteChainId` read from the bridge; takes the factory as a term (`MediatorTerms.tokenFactory`) and refuses a factory that names another mediator. |
| `DeliveryRouter` (layer 3) | `0x759b764d...f6a329` | `0x988a6160...6538f` | **New.** Five word director with `callGas`; the follow-up call gets exactly `callGas`; the source entry points pass `callbackGas`. |
| Bridged copies of tokens | (minted by the old mediators) | | Old copies stay where they are and can only go back through the old contracts (see "Tokens in flight"). |
| Test tokens (`DeployTestTokens.s.sol`) | `deploy/deployments/sepolia-pls943.test-tokens.json` | | **Stay.** They are plain native tokens; the new mediators deploy new copies on first use. |

The "now" addresses were checked on 2026-11-07: `previousBridge`, `previousMediator` and `previousRouter` in
`script/testnet/redeploy.config.testnet.json` equal `bridge`, `mediator` and `delivery_router` of
`deploy/deployments/sepolia-pls943.json`, and each holds code on its chain (22,850, 12,861 and 8,248 bytes on both).

Bytecode changes, so every address of a new contract is new. The addresses depend only on the deployer and its nonce
on each chain; `RedeployLayers.plan(deployer, nonce)` prints them before anything is sent.

## The per-transaction gas cap (EIP-7825): checked 2026-11-07

**Verdict: the cap does not bind on Sepolia today, and the split is built anyway** (owner: "lets just split them now"),
so the run does not depend on it. With the split, the largest creation is estimated by the Sepolia node at 14,704,815
gas (87.6% of 16,777,216).

Evidence, read with public RPCs only (nothing sent):

- Sepolia latest block (12,087,092 at 2026-11-08 00:02 UTC): `gasLimit` 200,000,000.
- Sepolia mined transactions above the cap that hour: within the last 31 blocks, 18 transactions had a gas limit above
  16,777,216 (the largest 30,898,609); receipts in blocks 12,087,052 to 12,087,090 show `gasUsed` of 21,246,168 to
  37,136,717 with status 1.
- `eth_estimateGas` of a creation is not refused above the cap: a dummy init code that returns 22,000 bytes of runtime
  code is estimated at 34,144,823 gas, 12,000 bytes at 18,719,900, 10,000 bytes at 15,634,968 (about 1,542 gas per
  byte for zero bytes; about 1,580 to 1,600 per byte for real code).
- `eth_estimateGas` of the actual creations of this build (the transactions of the dry run, deployer
  `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`): see the table below. All are under the cap.
- Chain 943: block `gasLimit` 37,748,179; it charges the standard 200 gas per byte, so each creation needs 1.6 to 2.5
  million gas.

## Before the run (no transactions)

1. **Build the release from the merged commit** (branch `feat/gas-revert-up-2`, main of 2026-11-07 with
   `feat/gas-revert-up` merged and the split): `forge build`, `pnpm abis` (ABIs in `explorer/data/src/abis`, now with
   the errors and events of the linked libraries appended), the TypeScript packages and the prover, from the same commit.
2. **Drain or pause in-flight traffic on the old contracts** (see "Tokens in flight"): stop the traffic bot (it sends
   through the old mediator), and let the runner deliver what is waiting.
3. **The deployer.** The testnet deployer is `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`, the key of the item "testnet deployer wallet" in the 1Password
   vault zkb.fi. It deployed the running contracts of 2026-10-26 (the broadcast receipts of that day; it is also the
   `minter` of the test tokens) and this redeploy. `0x444b15380A4560555326158D6799914186937Ec2`, an earlier key that
   older notes name, deployed nothing that runs. Owner, 2026-11-08: "ok, keep 0xF71c and fix the docs".
   `script/testnet/redeploy.config.testnet.json` names it as `deployer`; the script refuses any other signer, so the
   keystore named by `$KEYSTORE_NAME` must hold this key (`cast wallet address --account "$KEYSTORE_NAME"` prints
   `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`). On 2026-11-07 it had nonce 14 and 3.41 ETH on Sepolia, nonce 18 and about 45,000,000 PLS on 943. The
   whole run needs about 99,000,000 gas on Sepolia (under 0.01 ETH at the fees of 2026-11-07: a base fee of 14 wei, and
   Foundry estimated 0.03 gwei per gas) and about 17,000,000 gas on 943 (under 0.001 PLS at a priority fee of
   0.01 gwei).
4. **Read the deployer nonces** and write them into the configuration (the file refuses its placeholders by name):

   ```sh
   cast nonce 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc --rpc-url sepolia
   cast nonce 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc --rpc-url pulsechain_testnet_v4
   ```

   The script reads the running contracts from `previousBridge`, `previousMediator` and `previousRouter` (filled from
   `deploy/deployments/sepolia-pls943.json`, checked above).
5. **Dry run** (no `--broadcast`, nothing reaches a chain). It connects to both chains, checks the chain identifiers and
   the nonces, reads the kept values, prints the plan (eight addresses per chain), and runs the deployment and the full
   read-back on forks:

   ```sh
   REDEPLOY_CONFIG=script/testnet/redeploy.config.testnet.json REDEPLOY_MODE=layers \
     forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
     --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc 2>&1 | redact | tee "$RUN_DIR/redeploy-dry-run.log"
   ```

   Done on 2026-11-07 (with the current nonces, public RPCs as `rpcAlias`, no keystore; it was also run for the
   unused earlier key `0x444b...7Ec2`): both ran through `deployed on chain 11155111` and `deployed on chain 943`, so
   every read-back passed on the forks.
   Foundry names some transactions of the dry run with a wrong `contractName` (`None`, or the name of another contract
   at the same address on the other chain): it cannot match linked code, and one deployer with overlapping nonce ranges
   creates different roles at the same address on the two chains. The printed plan and the read-back are what count.

## The deployment (sends transactions)

Order: Sepolia first, then chain 943, eight transactions on each, all from the deployer
`0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`. Both bridges and both mediators name their twins on the other chain by
predicted address, so the nonce of each chain must not move between the dry run and the run; nothing else may send from
the deployer meanwhile.

```sh
REDEPLOY_CONFIG=script/testnet/redeploy.config.testnet.json REDEPLOY_MODE=layers \
  forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
  --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc \
  --broadcast --slow --skip-simulation 2>&1 | redact | tee "$RUN_DIR/redeploy.log"
```

`--skip-simulation` and `--slow` for the reason of `docs/testnet-run.md` step 5: Sepolia charges far more than Foundry
counts for new code, so Foundry must ask the node for each estimate. Chain 943 needs a priority fee above 0.001 gwei
(the default of 1 wei never gets included; the dry run printed 1 wei for 943); add `--priority-gas-price 10000000` for
its part, or run the chains one at a time if one command cannot carry both fee settings.

The libraries are deployed and linked by the script itself (`script/hardened/LinkedCode.sol`), from the deployer's own
nonces: it reads the creation code of the bridge, the mediator, the factory and the router from `out/`, so run `forge build` from the
release commit first and do not rebuild between the dry run and the run.

Measured on 2026-11-07 from the dry run (deployer `0xF71c...5eAc`, Sepolia nonce n = 14, chain 943 nonce n = 18).
"Local" is Foundry's gas of the transaction in the dry run; "node" is `eth_estimateGas` of the same transaction on the
chain. The mediator cannot be estimated before the bridge and the factory exist (its constructor reads them); its
Sepolia figure is the estimate of its runtime code alone (`eth_estimateGas` of a creation that returns that code) plus
its constructor.

| # | Nonce | Transaction | Runtime bytes | Local gas | Sepolia, node | Share of the cap | 943, node |
|---|---|---|---|---|---|---|---|
| 1 | n | create `ReceiptProofLib` | 8,697 | 2,514,067 | 13,766,697 | 82.1% | 2,320,677 |
| 2 | n + 1 | create `OpeningProofLib` | 6,210 | 1,814,818 | 9,890,117 | 58.9% | 1,675,216 |
| 3 | n + 2 | create `BeaconLayoutLib` | 8,231 | 2,382,793 | 13,040,132 | 77.7% | 2,199,501 |
| 4 | n + 3 | create `MessageBridge` (linked to 1 to 3) | 9,292 | 2,695,114 | 14,704,815 | 87.6% | 2,487,668 |
| 5 | n + 4 | create `MediatorPayloads` | 6,102 | 1,784,953 | 9,722,157 | 57.9% | 1,647,649 |
| 6 | n + 5 | create `TokenFactory` (names the mediator of n + 6) | 7,272 | 2,120,339 | 11,550,868 | 68.8% | 1,957,092 |
| 7 | n + 6 | create `TokenMediator` (linked to 5, takes 6) | 8,536 | 2,538,478 | about 13,600,000 (runtime alone: 13,488,000 at 1,580 per byte) | about 81% | about 2,350,000 (local) |
| 8 | n + 7 | create `DeliveryRouter` | 7,993 | 2,345,272 | 12,780,558 | 76.2% | 2,164,896 |

The sum is about 99,000,000 gas on Sepolia (block gas limit 200,000,000) and about 16,800,000 on 943.
`test/hardened/CreationGasCap.t.sol` keeps every creation of the deploy scripts under 90% of the cap at 1,600 gas per
byte, so a contract that grows past the budget fails the build before it fails a deployment.

The script reads every value back from the new contracts and stops on the first mismatch, before the next chain:
`DeploymentMismatch(<field>)` for a value; then `LibraryCodeMismatch` (a library is not the compiled library),
`LinkMismatch` (a link site of the bridge or the mediator does not hold its library) and `BuiltCodeMismatch` (the bridge,
the mediator, the factory or the router is not the compiled code, immutables aside). It prints the new addresses.

## After the deployment

These steps send transactions only where they say so. The runner does the on-chain ones by itself.

1. **Deployment file on the server.** Write the new `deployment.json` (mode 0600) with the prover's
   `deployment-file` command, as in `docs/testnet-run.md` step 5: the same light client, gate and registry addresses,
   the new `bridge`, `mediator`, `token_factory` (the factory at nonce n + 5, which `tokenFactory()` of the new mediator
   returns) and `delivery_router`, and `start_block` of each chain = the block before its first redeploy transaction.
   Keep the light clients' own start in `light_client_start_block` (the block before their creation: 12,020,692 on
   Sepolia, 25,767,015 on 943); the prover scans the stored heads from it (see "What got in the way" below).
   The libraries need no entry: nothing off chain calls them. Commit `deploy/deployments/sepolia-pls943.json` with the
   new addresses (the old file goes to `deploy/deployments/archive/sepolia-pls943.2026-10.json`, so the old pair can
   still be read).
2. **Open the new bridges (sends transactions, automatic).** Both new bridges start locked. The runner opens each
   with `openDeposits` after an update of the light client of its own chain (`docs/testnet-run.md` step 8). **Reset the
   runner state first:** the state file of each direction (`<stateDirectory>/runner-sepolia-pls943-<direction>.json`)
   keeps one `depositsOpen` flag, not keyed by bridge, and it is `true` for the old bridges, so the runner would never
   try to open the new ones. Start each direction with a fresh state file (or set `depositsOpen` to `false`); its spend
   records start over with it. The proof cache (`<stateDirectory>/proof-cache/`) is keyed by the light client, which
   stays, so it stays valid and can be kept.
3. **Layout rows (sends transactions, automatic).** The new bridges have no `block_roots`, block hash or
   `historical_summaries` rows. The evidence of the first delivery lists them as prerequisites, and the runner sends
   them before `executeMessage` (`docs/hardened-build-contract.md`, step 7 of the launch sequence).
4. **Gate.** Nothing: the gates stay, and the traffic bot and the dapp confirm the epoch before a send from Sepolia as
   today (`ensureGateConfirmed`).
5. **Indexer: reindex.** The schema changed (no `gasLimit`, no `deliveredSuccess`, no `failed_call`), so the indexer
   needs a fresh database: new `start_block`s from the deployment file, the new bridge, mediator and router addresses,
   and a full reindex from there. Everything the indexer serves starts over with it: `/api/counts` (Explore's browse
   tiles; SQL aggregates over the tables, so they count only the new pair's history), the browse lists
   (`/api/browse/*`), the feed and the delivered stats. Its `byStatus` now has no `failed_call` key, and the dapp's
   browse filter "Failed" asks for `release_failed` only. The old pair's history is not carried over; if it must stay
   visible, run the old indexer read-only on its own database until it is no longer needed.
6. **Backend, runner, traffic.** Point `deploymentFile` at the new file; rename `proofCheckGas` to
   `deliveryGasFallback` in the runner configuration (the bots refuse the old name); the runner's `deliveryRouter`
   list is an operator allowlist and takes the new router addresses. The traffic bot's `newCopyGasLimit` is ignored now
   and can be deleted from its configuration.
7. **Status page.** It reads `depositsOpen()` of the bridges and the gates from the deployment file
   (`explorer/status`), so point its `deploymentFile` at the new file too. Until the runner opens them, the two bridge
   checks report "deposits are closed, sends are refused" (degraded); that is expected right after the deployment and
   clears when step 2 is done. The gate checks do not change.
8. **Dapp and terminal.** The release carries the new deployment (pair `sepolia-pls943` in
   `explorer/shared/src/pairs.ts` reads the deployment file) and the new ABIs; a relay with a call now passes
   `callbackGas` from `routerCallbackGas`.
9. **Test tokens.** Keep them. Their first relay through a new mediator deploys a new copy (no gas number is needed:
   the executor brings the gas). The traffic bot's token list names native tokens, so it needs no change.
10. **Smoke test (sends transactions).** One relay each way through the router, as `docs/testnet-run.md` step 11:
    check `TokensBridged` on the destination, `AffirmationCompleted(..., true)`, and that a delivery with too little gas
    reverts and leaves the message waiting.

## What happened on 2026-11-08

Owner, 2026-11-07 and 2026-11-08: "do it all now", "go".

**The broadcast.** Deployer `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`, from the release commit of `feat/gas-revert-up-2`.
The record is `broadcast/multi/RedeployLayers.s.sol-latest/run.json` (16 receipts, all status 1); the filled
configuration is `script/testnet/redeploy.config.testnet.json`.

- Sepolia, nonces 14 to 21, blocks 12,087,603 to 12,087,610 (01:49:24 to about 01:51 UTC): 98,325,040 gas in all, the
  largest creation (`MessageBridge`) 14,587,871 gas, within 1% of the node estimates above; 0.00098 ETH.
- Chain 943, nonces 18 to 25, blocks 25,846,177 to 25,846,189 (01:51:39 to 01:53:39 UTC): 13,996,582 gas; 0.00014 PLS.
- **The fee of the first 943 broadcast was too low.** Foundry's estimate of the maximum fee on 943 came out 15 wei below
  the priority fee of 0.01 gwei (`--priority-gas-price 10000000`), and a transaction whose maximum fee is below its
  priority fee is invalid, so the broadcast stalled. It was resumed with
  `--resume --multi --with-gas-price 30000000 --priority-gas-price 10000000` (a maximum fee of 0.03 gwei); the first
  creation is in block 25,846,177 and the other seven, at the planned nonces, from 25,846,182 on. Next time on 943, pass
  `--with-gas-price` together with the priority fee from the start.

| Contract | Sepolia 11155111 | Chain 943 |
|---|---|---|
| `ReceiptProofLib` | `0x11b211E478105683096E5DA4cE1abf019fF35961` | `0x603ba9c389d02964d9E7c06D994d917b868f834E` |
| `OpeningProofLib` | `0xa8B9650A2021e014253a338629F8095D1f2e2910` | `0xBA4BecF539B90c68A333A090B3A51587909F6981` |
| `BeaconLayoutLib` | `0x08E458763D9410EcD56B9459b42Cdc624D389d04` | `0x2c00675092e2955d27F476B5a1baC9AC5Bb6FA86` |
| `MessageBridge` | `0xD4b1ECc1b919cf9BA7Ff45e57e1712B31abA4C66` | `0x3846e483C98cD0f164c29A5e40F7295A5765ABa4` |
| `MediatorPayloads` | `0x603ba9c389d02964d9E7c06D994d917b868f834E` | `0x1c4627D76e6b423e06C61f055C2ce0d3E944Ce8a` |
| `TokenFactory` | `0xBA4BecF539B90c68A333A090B3A51587909F6981` | `0xDcD7165D9941099B6657101C42CfcEb3B958557c` |
| `TokenMediator` | `0x2c00675092e2955d27F476B5a1baC9AC5Bb6FA86` | `0x8eeF4098D3726955F7D227C4D1D92487C99F7e62` |
| `DeliveryRouter` | `0x3846e483C98cD0f164c29A5e40F7295A5765ABa4` | `0xBEa5F0fd3712B02c25Bda32C7719fB9373C0fA20` |

One deployer with overlapping nonce ranges puts different roles at the same address on the two chains (the Sepolia
router and the 943 bridge share an address, and so on), and the 943 test tokens `tUSD` and `tTKN` sit at the addresses
of the Sepolia proof libraries. Always read an address together with its chain.

**Checked on the live chains after the broadcast** (read only, public RPCs): every address holds code of the planned
size; every receipt has status 1; and the script's own read-backs (`verifyBridge`, `verifyMediator`, the factory of the
mediator, `verifyRouter`, `verifyLibraries`, `verifyLinks`) ran again in a throwaway script against forks of both chains
at blocks 12,087,652 and 25,846,227 and all passed: the twins name each other, the light clients, gates, wrapped native
tokens, reward address (`0xE73c...2DB4`) and failed delivery address (`0xF71c...5eAc`) are the kept ones, and the code
of the libraries and every link site is the compiled code.

**The deployment file.** `deploy/deployments/sepolia-pls943.json` was written with `zk-bridge-prover deployment-file`:
the new bridge, mediator, token factory and router; the same light clients, gates, 943 fork registry and wrapped native
tokens; `start_block` 12,087,602 on Sepolia and 25,846,176 on 943. The old file is
`deploy/deployments/archive/sepolia-pls943.2026-10.json`; neither the release glob (`deploy/deployments/*.json`) nor the
docs reader (`readdirSync`, `.json` files only) descends into `archive/`. No frontend holds a router address of its own:
`isKnownDeliveryRouter` reads the routers of the deployment file.

**The last message on the old contracts** (Sepolia to 943, waiting since about 01:50) was delivered by the runner at
02:28:42 UTC (update `0x4b46356241b2899bb31171dd57edb5db8e579cc5a9dff237fa622400c5ecca17`, delivery batch
`0x3332b5f19f2b0095be68d6104329e715d5896ae188dd7e11f7d7607d2942ed71`, both on 943). Then the runner was stopped and the
switch began.

**The server** (release `911335249e98571f1943947de54ea7683d80ab96`, built with `build.yml`; every changed file has a
copy with the suffix `.bak-20261108`):

- `/etc/zk-bridge/deployment.json` (the one file every service reads): the new pair, mode 0644 root:root as before.
- `/etc/zk-bridge/runner/bots.json`: `proofCheckGas` removed, `deliveryGasFallback` 1,500,000 (the old 400,000 was
  the share of the proof check only; the new setting is the whole delivery, and 1,500,000 is the code default), and the
  four new copies of the test tokens added to `tokenValuationsWei` (Sepolia copies of the 943 tokens
  `0xfFd05cCfBa2DF891b837D06695e01051f2f9304d` and `0x486367F9550b211689532Edde0C0F074C014698B` at 10 coins per token;
  943 copies of the Sepolia tokens `0xf646d8DecD04732c9CD39b56525E1D6F6d09bF2c` and
  `0x33f92b140B18b5e1380Ea24B0520ba6139E8db21` at 1 coin), from `predictAddress` of the new factories. The runner has
  no `deliveryRouter` setting: it takes the router of the deployment file.
- `/etc/zk-bridge/traffic/bots.json`: `newCopyGasLimit` removed.
- Runner state: both `runner-sepolia-pls943-<direction>.json` moved aside, so each direction started with
  `depositsOpen` false. The proof cache stayed.
- Indexer: `indexer.yml -e action=green` filled the new schema `indexer_4b2d903b8088` on port 42070 in a few minutes;
  `-e action=switch` pointed Caddy at it. **`finish` was not run**: the old indexer (schema `indexer_172c92436019`, the
  309 messages of the old pair) still runs as the unit `zk-bridge-indexer` on 127.0.0.1:42069, reachable through an SSH
  tunnel (`ssh -L 42069:127.0.0.1:42069 zkbfi-app`, then `http://127.0.0.1:42069/api/counts`). Caddy keeps it as the
  fallback of indexer.zkb.fi, so if green stops, the public site shows the old pair.
- **The backend, the runner and the status service read the indexer directly at 127.0.0.1:42069**, not through Caddy,
  so after the switch they still saw the old pair (the backend refused a proof request with `nothing-to-prove`).
  Their `indexerUrl` (status: `indexerLocal`) now points at green, 127.0.0.1:42070. Green is a transient unit
  (`zk-bridge-indexer-pre`, `Restart=no`): it does not survive a reboot or a crash. When the old pair's history is no
  longer needed, run `indexer.yml -e commit=<hash> -e action=finish` and set those three URLs back to 42069.
- `backend.yml` (drain, switch, health), `bots.yml -e bots=runner,status`, then `bots.yml -e bots=traffic`. Caddy needed
  no change beyond the indexer switch.

**The bridges opened by themselves.** At its first pass on the new deployment the runner built both opening proofs from
its proof archive, without a new light client update:

- Sepolia bridge: `openDeposits` `0xb0b017a1f3ed959fc5f37a91b32c1e4e3dec199140c4f5aeb8f2cb9f03203125` (02:32:51 UTC,
  626,833 gas).
- 943 bridge: `openDeposits` `0xed768fd138a9a3784c5b18caae39e87679965abbf55d0bfc8367edd48b1a7ad8` (02:32:59 UTC,
  589,969 gas).

**Smoke test.** One relay each way through the new routers, sent by the traffic bot (restarted at 02:34):

- **943 to Sepolia.** The relay `0x1ef8f5e223824d55824880dde11aba4d36305b43e9bcfda1f42ec24b8a0d395e` (02:50:09 UTC, tTKN,
  a deploy message) was delivered on Sepolia at 03:12:41 in
  `0xd670555f6555f6032e08094ec401e969660124ebd076c03f8d5ea307ab3c0c55` (status 1, 7,883,652 gas, which deploys the
  copy `ztTKN` at `0x486367F9550b211689532Edde0C0F074C014698B`, the address the factory predicted): `TokensBridged` from
  the new mediator, `AffirmationCompleted(943 mediator, Sepolia mediator, message, true)` from the new bridge. Before
  it, the runner sent the first layout rows of the Sepolia bridge: `addBlockRootsLayout`
  `0x2536543cd433229c47dea3baebf69236a6be28445b7909044deedc858413ab28`, `addBlockHashLayout`
  `0x715727d57405d0ba8eb5d0d0973c34003ea5ba020d140f1338ee626b56490e62` and
  `0x9650689583f1f0d0077d75bb3c2f71b2da692f7ef102a869d5e3a1fbd32f18ac`. A second message followed at 03:14:04
  (`0xdd2e8eaee0ed494a96c3fc528fc2ee175d205b95d5165fd2215d80aa8502dfa7`).
- **Sepolia to 943.** The relay `0xe28fdbad0d20f26fe35b97be10c4221dc0e06930e94745c1f959b492e8ae825f` (03:02:37 UTC) was
  delivered on 943 at 03:22:11 in `0xfa286a0b569896b80d506cb41d2bf20d11e4d4720864590472e1b3b27f2c07ae` (status 1,
  `TokensBridged` from the new mediator, `AffirmationCompleted(..., true)` from the new bridge), after the layout row
  `addBlockRootsLayout` `0x6fcbf08019203a52de8840ec710faf7d500c9b8691e19985dc443fcc5ce51513`.
- The delivery with too little gas (step 10 of the plan) was not tried on the live chains; the forge tests cover it.

**What got in the way, and what to change next time.**

- **The first delivery on each side waits for three light client heads after `start_block`.** The prover finds the
  stored heads of the destination light client by scanning its `HeadUpdated` logs from the route's `start_block`
  (`read_stored_slots` in `prover/src/stored.rs`), and the first layout row of a new bridge (`addBlockRootsLayout`)
  needs two stored heads below the anchor. The light clients are kept and hold many heads, but the scan starts at the
  redeploy block, so evidence failed with "not enough stored headers yet to validate the block roots layout" until each
  light client had stored three heads after the redeploy. Here that was sped up with proof requests to the backend
  (`POST /requests`, reason `message`, for messages that were waiting), three per direction. Fixed after the fact
  (branch `fix/layout-loop-and-grind`): the deployment file has `light_client_start_block` for each chain (the block
  before the light client's creation, from the receipts of the October broadcast: 12,020,692 on Sepolia, creation tx
  `0x94ff6bb85ab784e4df0dc3ff4f307c585f26999777050962b35e5f0c1988b90d` in block 12,020,693; 25,767,015 on 943, creation
  tx `0xb34487c3ebb1580c633cb967e8c2902bb4b283cfbc7d9e4cbd70840924ba0755` in block 25,767,016), the runner writes it into
  the prover configuration as `destination.light_client_start_block`, and the prover scans the stored heads from there
  (`start_block` when it is absent).
- **The first Sepolia send reverted at the gate.** The traffic bot confirmed epoch 360342 ten seconds before its end,
  and the relay `0x4a543d53bca0227af30c82aa164ebab87960e8586d2abc2ed5d78da5cdb63bda` was mined in epoch 360343
  (`ForkNotConfirmed(360343)`). The gate is the kept one; the bot sent again in its next hour. The bot should not
  confirm and send this close to an epoch boundary.
- **One 943 message looped on a block hash row that could not cover it.**
  `0x00050000c9be6ab2a70642475d4a2ec9c896c44f8fa9c0cd0000000000000000` (943 to Sepolia, relay
  `0xedcca15514f40c66c77dba8697219d2ac0eeb0bb096398f0d62c3ea2231b5fc0`, 02:35:42 UTC, the first message on the new 943
  bridge) was sent before the slot of the first head that the scan from `start_block` could see. Its block hash row must
  hold a stored head at or below its source slot; that head (slot 11274432, stored at 01:31) is older than
  `start_block`, so the prover never offered it. It offered only the row of the head below the anchor, which the bridge
  takes but which does not reach down to the source slot. Once the message had waited an hour, the unpaid rule
  (`deliverUnpaidAfterSeconds`) sent that row (`addBlockHashLayout`), the evidence still listed it, and the runner logged
  `prerequisite_loss` with `prerequisites-not-satisfied`. The unpaid pass passed "no layout spend" to its bookkeeping, so
  the item waited the five minutes of an ordinary retry instead of `prerequisiteLossRefusalSeconds` (1,800 s): a row
  every sweep after five minutes, about every 7 minutes, each a loss that was not charged to the unpaid cap. The fix
  (branch `fix/layout-loop-and-grind`): the scan starts at `light_client_start_block`; the prover answers "no stored
  header at or below source slot N" instead of offering a row that cannot cover the message; the unpaid pass counts its
  layout spend (refusal window, recorded loss, charged to `maximumUnpaidSpendPerDayWei`); the runner state keeps, per
  message, the layout calls it sent (none is sent twice) and the tries that paid for layout calls without covering the
  message, and after `maximumUnsatisfiedPrerequisiteAttempts` (default 3) it sends no more for it (skip
  `prerequisites-stuck`, warning `prerequisites_stuck`); the retry times are in the state file, so a restart keeps them.
  Checked read only on 2026-11-09: the message is still undelivered (`deliveryStatus` 0); the bridge's one block hash
  row (gindex 412) covers slots 11274912 to 11290176, and the source slot is 11274897. The light client logged 166
  heads between its creation and `start_block`, the highest at or below the source slot being 11274432 (block
  12,087,515, header still stored), so with `light_client_start_block` the prover offers the row of that head, which
  widens row 412 down past the source slot. A run of the new `evidence` command without the setting now ends with "no
  stored header at or below source slot 11274897" instead of offering the anchor's row. The server's Sepolia RPC must
  serve `eth_getLogs` back to block 12,020,692 (publicnode answers "pruned history unavailable" there).
- **The backend, the runner and the status service bypass Caddy** (see the server list above): a blue/green switch of
  the indexer without `finish` leaves them on the old index unless their URLs are changed too.

### The router of 2026-11-08, night (layer 3 alone)

Owner: "do both", "go ahead with the router deploy". A new `DeliveryRouter` on each chain that emits `Delivered`
(`feat/router-delivered-event`), deployed with `REDEPLOY_MODE=router` as in "Layer 3 later, alone" below; records in
`broadcast/RedeployLayers.s.sol/{11155111,943}/run-latest.json`, configuration `script/testnet/router-redeploy.config.testnet.json`.

| Chain | New router | Nonce | Transaction | Block | Bound to mediator |
|---|---|---|---|---|---|
| Sepolia | `0x1c4627D76e6b423e06C61f055C2ce0d3E944Ce8a` | 22 | `0x41be362075d4f0bc50718d023ee67315550f1979fb5378b9e8dc06ffcd58f348` | 12,088,245 | `0x2c00675092e2955d27F476B5a1baC9AC5Bb6FA86` |
| 943 | `0x6e0178049277442d5BF58963f9a1E0469B46Fce3` | 26 | `0xe7cd7bb382380d93fa011b7dfc8e1947da4129da745c9258c62cc341a66dc953` | 25,846,960 | `0x8eeF4098D3726955F7D227C4D1D92487C99F7e62` |

Checked on chain (read only): both have 8,472 bytes of code, both receipts status 1, `bridge()` is the mediator of
their chain, and `wNative()`, `rewardAddress()` and `failedDeliveryAddress()` equal those of the routers they replace.

- **Deployment file.** `delivery_router` is the new router of each chain; `delivery_routers` keeps the router of the
  redeploy (`0x3846e483C98cD0f164c29A5e40F7295A5765ABa4` on Sepolia, `0xBEa5F0fd3712B02c25Bda32C7719fB9373C0fA20` on
  943), so the indexer reads both. `start_block` stays.
- **Drain first.** The runner delivers to one router only (its `deliveryRouter`, else the deployment file's), so a
  message addressed to the old router would be skipped once it switches. The traffic bot was stopped at 04:08 UTC, the
  three messages in flight were proven on request and delivered at 04:11 (943 to Sepolia
  `0x852c9332fca2b55a3d1da0f70bd56a32bbfd09cbca71ac24ac657cf6d41ad982`, Sepolia to 943
  `0xc563fe50193226b648b56a6d74c8dd66d99d1b1cdb9ff51b8c96d7aed9ddea7c`), then the runner was stopped and switched.
  Message `...0000` above stays addressed to the old router. For the runner it has no offer (its recipient is not the
  configured router), so the unpaid rule delivers it straight to the bridge; the old router then receives the tokens
  outside `executeMessage` and passes them on without a tip.
- **Server** (release `f2d3e6ba3c8ed3a3928830b5a7db66a7842b430a`; backups with the suffix `.bak-20261108b`):
  `/etc/zk-bridge/deployment.json` replaced (0644 root:root); no runner or traffic setting names a router. The indexer
  schema changed (fee fields), so a second green ran beside the first: `indexer.yml -e action=green` with
  `-e zkb_indexer_green_port=42071 -e zkb_green_indexer_unit=zk-bridge-indexer-pre2` filled `indexer_5bc793a78041`
  (same counts as the first green, the two new routers added, and the old routers' deliveries with fee fields from
  their transfer logs, `feeSource` `logs`), then `-e action=switch` with the same two variables. The `indexerUrl` of
  the backend and the runner and the `indexerLocal` of the status service now point at 127.0.0.1:42071. Then
  `backend.yml` and `bots.yml -e bots=runner,status,traffic`. The runner delivers to the new routers.
- **Indexers now:** green 2 (`zk-bridge-indexer-pre2`, 42071, schema `indexer_5bc793a78041`) serves indexer.zkb.fi
  and the services; it is a transient unit (`Restart=no`) like the first. The first green
  (`zk-bridge-indexer-pre`, 42070) was stopped once green 2 had shown a delivery with `feeSource` `event`. The
  pre-redeploy indexer (`zk-bridge-indexer`, 42069) is untouched and stays Caddy's fallback.
- **Smoke test** through the new routers: a Sepolia to 943 transfer of 31.16 was delivered through the new 943 router,
  and the fee was read from its `Delivered` event: 0.03116 to the runner, 31.12884 to the recipient.

## What the split costs a delivery

Each library call is a DELEGATECALL and copies its arguments (the proof) into the call. Measured with the forge tests of
this build against the unsplit branch: `executeMessage` on the recent path +12,532 gas (367,373 to 379,905), on the
historical path +10,324 (396,171 to 406,495); a token delivery about +13,400 (short form 523,070 to 536,487; with the
deployment of a copy +19,152); a relay about +5,000; `openDeposits` +5,506. The runner sizes deliveries with
`eth_estimateGas`, so it follows by itself.

## Layer 3 later, alone

A new router needs no change to layers 1 and 2. It is bound for good to the mediator that it names, so it is deployed
for the running mediator, one chain per run.

### The router that emits `Delivered` (prepared 2026-11-07, not sent)

Owner, verbatim: "it also looks like there are no fees coming out of the output, which is odd", then, on the missing
success event of the router: "do both". The routers of 2026-11-08 emit an event only when something fails, so the
explorer saw the mediator pay the router and nothing after it: no fee, no amount received. The new `DeliveryRouter`
emits on every delivery that pays its recipient:

```solidity
event Delivered(
    address indexed token,      // what the mediator released (the wrapped native token for an unwrap)
    address indexed recipient,  // from the terms, or the 20 byte legacy data
    address indexed feeTo,      // rewardAddress, or address(0) when no fee was paid
    uint256 amount,             // what the router received: fee + paidOut
    uint256 fee,                // to feeTo
    uint256 paidOut,            // to the recipient
    PaidAs paidAs,              // 1 Token, 2 Native, 3 Wrapped (the recipient refused the coin); 0 is never emitted
    address callTarget          // the target of the call that follows, or address(0)
);
// topic0 = keccak256("Delivered(address,address,address,uint256,uint256,uint256,uint8,address)")
```

It is emitted after the payments and before the follow-up call (a failed call adds `CallFailed` after it); hand-offs
still emit `DeliveryFailed` and no `Delivered`. It costs 3,779 gas per token delivery (all fee modes) and 3,785 per
native delivery (`DeliveryRouterGas.t.sol`, before and after). Because the event runs after the fee measure,
`NATIVE_GAS_OVERHEAD` rises from 100,000 to 105,000 (the work after the measure for two new accounts went from 97,268 to
101,053 gas); `TOKEN_GAS_OVERHEAD` stays at 100,000 (82,190 to 85,969). `@zkb/core` follows (`NATIVE_GAS_OVERHEAD`
105,000n), so its estimate for the routers of 2026-11-08 is 5,000 gas high, never low. Runtime code 8,472 bytes.

The configuration is `script/testnet/router-redeploy.config.testnet.json`: the deployer, and for each chain the running
bridge, mediator and router of `deploy/deployments/sepolia-pls943.json` (2026-11-08). Its two nonces are placeholders
that the script refuses by name. The script also refuses a `previousRouter` whose mediator is not `previousMediator`
(`PreviousRouterOfAnotherMediator`), and after the creation it reads back the mediator, the wrapped token, the reward
and failed delivery addresses, and requires the compiled code (`BuiltCodeMismatch` otherwise).

1. **Build** from the release commit: `forge build`, then `pnpm abis` (the ABI of the router in
   `explorer/data/src/abis` carries `Delivered`). Do not rebuild between the dry run and the run.
2. **Nonces** (no transactions). Write each into the configuration in place of its placeholder:

   ```sh
   cast nonce 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc --rpc-url sepolia
   cast nonce 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc --rpc-url pulsechain_testnet_v4
   ```

3. **Dry run** (no `--broadcast`, nothing reaches a chain), one chain at a time:

   ```sh
   REDEPLOY_CONFIG=script/testnet/router-redeploy.config.testnet.json REDEPLOY_MODE=router REDEPLOY_CHAIN=chainA \
     forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
     --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc 2>&1 | redact | tee "$RUN_DIR/router-dry-run-sepolia.log"

   REDEPLOY_CONFIG=script/testnet/router-redeploy.config.testnet.json REDEPLOY_MODE=router REDEPLOY_CHAIN=chainB \
     forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
     --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc 2>&1 | redact | tee "$RUN_DIR/router-dry-run-943.log"
   ```

   It prints `n delivery router (predicted)` and `new delivery router` with the same address. Done on 2026-11-07 with
   the nonces of that moment (public RPCs as `rpcAlias`, `--sender` only, no keystore), both forks passed the
   read-back:

   | Chain | Deployer nonce | Predicted router | For the mediator | Node estimate of the creation |
   |---|---|---|---|---|
   | Sepolia 11155111 | 22 | `0x1c4627D76e6b423e06C61f055C2ce0d3E944Ce8a` | `0x2c00675092e2955d27F476B5a1baC9AC5Bb6FA86` | 13,526,903 gas (80.6% of the EIP-7825 cap) |
   | 943 | 26 | `0x6e0178049277442d5BF58963f9a1E0469B46Fce3` | `0x8eeF4098D3726955F7D227C4D1D92487C99F7e62` | 2,288,865 gas |

   The addresses hold only while the nonces are 22 and 26; any other transaction from the deployer first moves them,
   and the script then refuses the stale nonce.

4. **The deployment (sends one transaction per chain).** Sepolia:

   ```sh
   REDEPLOY_CONFIG=script/testnet/router-redeploy.config.testnet.json REDEPLOY_MODE=router REDEPLOY_CHAIN=chainA \
     forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
     --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc \
     --broadcast --slow --skip-simulation 2>&1 | redact | tee "$RUN_DIR/router-sepolia.log"
   ```

   Chain 943, with explicit fees: Foundry's own estimate for 943 was a max fee of 15 wei (the dry run above printed
   0.000000015 gwei and a priority fee of 1 wei), and the first broadcast of 2026-11-08 with Foundry's fees failed. 943
   needs a priority fee above 0.001 gwei:

   ```sh
   REDEPLOY_CONFIG=script/testnet/router-redeploy.config.testnet.json REDEPLOY_MODE=router REDEPLOY_CHAIN=chainB \
     forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers \
     --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc \
     --broadcast --slow --skip-simulation \
     --with-gas-price 30000000 --priority-gas-price 10000000 2>&1 | redact | tee "$RUN_DIR/router-943.log"
   ```

5. **After.** Add the new router to `delivery_router` of each chain in the deployment file and keep the router of
   2026-11-08 next to it: messages already sent name the old router as their receiver and are still delivered to it.
   The indexer reads `delivery_routers` (a list: the new router first, the old ones after it) and indexes all of them;
   for a router with no `Delivered` event it derives the fee from the transfer logs of the delivery (see
   `explorer/indexer/README.md`). Then add the router to the runner's router allowlist and to the frontends
   (`isKnownDeliveryRouter`).

### Any later router

```sh
REDEPLOY_CONFIG=<file whose previousRouter is the router to replace> REDEPLOY_MODE=router REDEPLOY_CHAIN=chainA \
  forge script script/hardened/RedeployLayers.s.sol --tc RedeployLayers --account "$KEYSTORE_NAME" --sender 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc \
  --broadcast --slow --skip-simulation
```

One transaction (create `DeliveryRouter`, about 2,500,000 local gas, about 13,500,000 on Sepolia) for the running
mediator, with the kept wrapped token, reward address and failed delivery address. Add the 943 fee flags above for
chain 943. Messages already sent to the old router are still delivered to it: a router is the receiver named in each
message, so the old router keeps working for them.

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
