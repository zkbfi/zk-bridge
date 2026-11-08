# Redeploy plan: gas reverts up (testnet, November 2026)

Status: a plan, brought up to date on 2026-11-07 (merged with main, contracts split for the gas cap, dry run done).
Nothing here has been sent. Every step that sends a transaction says so. The owner runs it.

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

Order: Sepolia first, then chain 943, eight transactions on each, all from the deployer `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`. Both bridges and both mediators
name their twins on the other chain by predicted address, so the nonce of each chain must not move between the dry run
and the run; nothing else may send from the deployer meanwhile.

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
