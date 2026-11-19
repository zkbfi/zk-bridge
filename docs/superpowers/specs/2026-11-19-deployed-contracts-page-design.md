# The deployed contracts page

Date: 2026-11-19. Status: built, waiting for review.

## The owner's words

- "when you are done you need to put all of these on a documentation page. we need to update them every time we deploy contracts"
- "pulsechain uses a hashrouter. seems like you didn't even load the endpoint. also, why verify on blockscout but not etherscan?"

## What it does

One page of the dapp documentation, `explorer/web/docs/pages/10-deployed-contracts.md`, lists every contract that is live in
each deployed pair, per chain: its role, its full address, a link to each explorer, whether its source is verified on each
explorer, the source commit and the deploy date. Retired contracts, test tokens and third-party contracts have their own
tables. The page is generated, so it cannot drift from the deployment record.

## Parts

1. **The record.** `deploy/deployments/<pair>.json` keeps every field it had (the explorer, the prover and the bots read
   them). Each chain section gains a `contracts` list and a `verification_checked` date. An entry holds `name`, `address`,
   `role`, `group` (`live`, `tokens`, `third_party` or `retired`), `source` (`path:ContractName`, or null for a contract
   that is not ours), `libraries` (names of libraries it links, from the same list), `created_by` (`factory` for a bridged
   token, which has no creation transaction of its own), `source_commit`, `deployed_on` and `verified` (`blockscout`,
   `sourcify`, `etherscan`: true, false, `unsupported` or null for not checked).
2. **Explorer links** come from `explorerLinks` in `explorer/data/src/chain-metadata.ts`. The PulseChain scans route by hash
   (`https://scan.v4.testnet.pulsechain.com/#/address/<address>`). Etherscan and Blockscout use paths. Sourcify is
   `https://repo.sourcify.dev/<chainId>/<address>` and is left out where it does not serve the chain. Sepolia gained its
   Blockscout (`https://eth-sepolia.blockscout.com`) as a second explorer; Etherscan stays the main one.
3. **The generator**, `deploy/contracts-page/generate.mjs`. Without options it renders the page from the record, with no
   network. `--refresh` first reads the verification status from Blockscout (v2 `smart-contracts`), Sourcify (v2
   `contract`) and, when `ETHERSCAN_API_KEY` is set, Etherscan v2 `getsourcecode`, and writes it into the record. A status that
   an explorer did not give stays as the record has it. `--check` exits 1 when the committed page differs.
4. **The staleness test**, `explorer/docs/test/deployed-contracts-page.test.ts`, renders from the committed record with no
   network and fails when the committed page differs, so a deploy that changes the record without regenerating fails CI.
5. **The verify script**, `deploy/contracts-page/verify.mjs`, for every contract deployment: given a pair and a source commit
   it submits each contract of that commit to Blockscout (v2 standard JSON endpoint), Sourcify (Sepolia and mainnet) and
   Etherscan v2 (with `ETHERSCAN_API_KEY`), then runs the generator with `--refresh`.
6. **The runbook step** in `docs/testnet-run.md`: after a contract deployment, update the record, run the verify script,
   run the generator, commit the page.

## Facts behind the first record (read on 2026-11-19)

- Nine contracts have the same address on both chains, from `RedeployLayers` at commit 66578376 (2026-11-11): MessageBridge,
  TokenMediator, BeaconForkGate, TokenFactory, DeliveryRouter and the libraries ReceiptProofLib, OpeningProofLib,
  BeaconLayoutLib and MediatorPayloads.
- The light clients, the SP1 verifiers and the ForkRegistry come from `DeployBridge` at commit fbc62e9 (2026-10-29). The
  PulseChain testnet has two light clients: one follows Sepolia, one follows PulseChain testnet itself for the ForkRegistry.
- The retired delivery routers and the test tokens are from commit 91133524.
- Sepolia Blockscout shows all of its contracts as verified, labelled "partial" because `foundry.toml` sets `bytecode_hash`
  to none and `cbor_metadata` to false; Sourcify reports an exact match. PulseChain testnet Blockscout shows all verified
  except ReceiptProofLib, OpeningProofLib, BeaconLayoutLib, MediatorPayloads and one bridged token. Etherscan: none yet,
  for want of an API key. Sourcify and Etherscan do not serve chain 943.
- The deploy dates in the record are the block times of each contract's creation. The second bridged token on 943 has no
  creation transaction in Blockscout (a factory made it); its date is the day found by searching for the block where code
  first appears.
