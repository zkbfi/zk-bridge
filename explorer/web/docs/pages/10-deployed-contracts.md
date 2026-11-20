---
title: "Deployed contracts"
summary: "Every contract of each deployed pair, per chain, with its address, its role, the explorers that show it, where its source is verified, its source commit and its deploy date."
audience: [user, operator, integrator]
chains: all
verified_release: 0.1.0
---

# Deployed contracts

This page lists every contract that is live in each deployed pair, on each chain: what it does, its full address, a link to each explorer, whether its source code is verified there, the commit of the source and the day it was deployed. It also lists retired contracts, test tokens and the third-party contracts the bridge uses. The page is generated from the deployment record of each pair (`deploy/deployments/<pair>.json`) and is regenerated at every contract deployment.

Every contract in the bridge has no owner, no upgrade path and no pause. The address of a contract never changes, so a new deployment means new addresses and a new list on this page.

## Sepolia and PulseChain testnet v4

The pair `sepolia-pls943`.

### Sepolia (chain 11155111)

Verification status read on 2026-11-19.

#### Contracts in use on Sepolia

The bridge itself, the helper contracts it needs and the light clients. Nothing here has an owner, an upgrade path or a pause.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| MessageBridge | Sends messages to the other chain and delivers the ones that arrive, after it checks the proofs that link each one to a finalized header of the other chain. | `0x5897d3de91d59fb691e3887d6ffbba072384293a` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x5897d3de91d59fb691e3887d6ffbba072384293a): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x5897d3de91d59fb691e3887d6ffbba072384293a): verified · [Etherscan](https://sepolia.etherscan.io/address/0x5897d3de91d59fb691e3887d6ffbba072384293a): not verified | `cf63fff9` | 2026-11-11 |
| TokenMediator | Moves tokens through the bridge: it locks a native token here and mints a bridged copy on the other chain, or burns a copy and unlocks the native token. | `0x571f96605921f76a24cf1388c2caf126b15b09f7` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x571f96605921f76a24cf1388c2caf126b15b09f7): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x571f96605921f76a24cf1388c2caf126b15b09f7): verified · [Etherscan](https://sepolia.etherscan.io/address/0x571f96605921f76a24cf1388c2caf126b15b09f7): not verified | `cf63fff9` | 2026-11-11 |
| BeaconForkGate | Refuses new sends when the other chain has moved to a state layout that the proof program cannot read. | `0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3): verified · [Etherscan](https://sepolia.etherscan.io/address/0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3): not verified | `cf63fff9` | 2026-11-11 |
| TokenFactory | Creates the bridged copy of a token the first time that token is sent here. | `0x2436b1826a4879e90b565638147fe1c5c24364e5` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x2436b1826a4879e90b565638147fe1c5c24364e5): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x2436b1826a4879e90b565638147fe1c5c24364e5): verified · [Etherscan](https://sepolia.etherscan.io/address/0x2436b1826a4879e90b565638147fe1c5c24364e5): not verified | `cf63fff9` | 2026-11-11 |
| DeliveryRouter | Optional entry point for delivery: it wraps the native coin, delivers the message, pays a voluntary tip, unwraps, and makes the follow-up call. | `0xa125684b9479fbab64218581763788bafb520a57` | [Blockscout](https://eth-sepolia.blockscout.com/address/0xa125684b9479fbab64218581763788bafb520a57): verified · [Sourcify](https://repo.sourcify.dev/11155111/0xa125684b9479fbab64218581763788bafb520a57): verified · [Etherscan](https://sepolia.etherscan.io/address/0xa125684b9479fbab64218581763788bafb520a57): not verified | `cf63fff9` | 2026-11-11 |
| ReceiptProofLib | Library that checks the receipt, transaction and log proofs of a message against a block. | `0x6dcc32be1802b1747465dfb2d3a1bf171eaed611` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x6dcc32be1802b1747465dfb2d3a1bf171eaed611): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x6dcc32be1802b1747465dfb2d3a1bf171eaed611): verified · [Etherscan](https://sepolia.etherscan.io/address/0x6dcc32be1802b1747465dfb2d3a1bf171eaed611): not verified | `cf63fff9` | 2026-11-11 |
| OpeningProofLib | Library that checks the opening proof that releases tokens locked by a one-way deposit. | `0x9765bc0e7f57d0064b99a4ae855db16e5b5aa7ba` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x9765bc0e7f57d0064b99a4ae855db16e5b5aa7ba): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x9765bc0e7f57d0064b99a4ae855db16e5b5aa7ba): verified · [Etherscan](https://sepolia.etherscan.io/address/0x9765bc0e7f57d0064b99a4ae855db16e5b5aa7ba): not verified | `cf63fff9` | 2026-11-11 |
| BeaconLayoutLib | Library that checks the beacon state layout rows (block roots, block hashes, historical summaries) that a message proof relies on. | `0x4acd9fcef648029931ce163d343feb6d94181322` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x4acd9fcef648029931ce163d343feb6d94181322): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x4acd9fcef648029931ce163d343feb6d94181322): verified · [Etherscan](https://sepolia.etherscan.io/address/0x4acd9fcef648029931ce163d343feb6d94181322): not verified | `cf63fff9` | 2026-11-11 |
| MediatorPayloads | Library that encodes and decodes the token messages that the mediator sends across the bridge. | `0x1e68160762061624bb5fa31d589a8f31c3e44bc5` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x1e68160762061624bb5fa31d589a8f31c3e44bc5): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x1e68160762061624bb5fa31d589a8f31c3e44bc5): verified · [Etherscan](https://sepolia.etherscan.io/address/0x1e68160762061624bb5fa31d589a8f31c3e44bc5): not verified | `cf63fff9` | 2026-11-11 |
| BeaconLightClient | Light client of the PulseChain testnet v4 beacon chain, kept on Sepolia. It stores finalized headers and accepts a new one only with a zero-knowledge proof. | `0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e): verified · [Etherscan](https://sepolia.etherscan.io/address/0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e): not verified | `4e86885` | 2026-10-29 |
| SP1Verifier | Checks the Groth16 zero-knowledge proofs that the light clients accept (the vendored SP1 verifier, version 6.1.0). | `0xF7110fA5dF18509733C11B644eC3EDAC19E27f67` | [Blockscout](https://eth-sepolia.blockscout.com/address/0xF7110fA5dF18509733C11B644eC3EDAC19E27f67): verified · [Sourcify](https://repo.sourcify.dev/11155111/0xF7110fA5dF18509733C11B644eC3EDAC19E27f67): verified · [Etherscan](https://sepolia.etherscan.io/address/0xF7110fA5dF18509733C11B644eC3EDAC19E27f67): not verified | `4e86885` | 2026-10-29 |

#### Test tokens on Sepolia

Test tokens used on the testnet pair. Each chain holds the original of one token and the bridged copy of the other chain's token.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| TestToken tUSD | Test token zkb Test Dollar (tUSD, 6 decimals). Only the deployer can mint it. | `0x988a6160b5580895ea15a080a8d4ea763cf6538f` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x988a6160b5580895ea15a080a8d4ea763cf6538f): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x988a6160b5580895ea15a080a8d4ea763cf6538f): verified · [Etherscan](https://sepolia.etherscan.io/address/0x988a6160b5580895ea15a080a8d4ea763cf6538f): not verified | `71bb2017` | 2026-11-01 |
| TestToken tTKN | Test token zkb Test Token (tTKN, 18 decimals). Only the deployer can mint it. | `0x23b69083d577bd8d1a9fbdf8ef1411b7285cf45e` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x23b69083d577bd8d1a9fbdf8ef1411b7285cf45e): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x23b69083d577bd8d1a9fbdf8ef1411b7285cf45e): verified · [Etherscan](https://sepolia.etherscan.io/address/0x23b69083d577bd8d1a9fbdf8ef1411b7285cf45e): not verified | `71bb2017` | 2026-11-01 |
| BridgedToken ztUSD | Bridged copy of tUSD from PulseChain testnet v4, created by the token factory on the first transfer. | `0xdbe592A7d7614a10cDcA4B27D889F4f9E59F0Fa6` | [Blockscout](https://eth-sepolia.blockscout.com/address/0xdbe592A7d7614a10cDcA4B27D889F4f9E59F0Fa6): verified · [Sourcify](https://repo.sourcify.dev/11155111/0xdbe592A7d7614a10cDcA4B27D889F4f9E59F0Fa6): verified · [Etherscan](https://sepolia.etherscan.io/address/0xdbe592A7d7614a10cDcA4B27D889F4f9E59F0Fa6): not verified | `71bb2017` | 2026-11-11 |
| BridgedToken ztTKN | Bridged copy of tTKN from PulseChain testnet v4, created by the token factory on the first transfer. | `0x61FA294Fb1CA457B9F3a22e71b36971d4A1E3C20` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x61FA294Fb1CA457B9F3a22e71b36971d4A1E3C20): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x61FA294Fb1CA457B9F3a22e71b36971d4A1E3C20): verified · [Etherscan](https://sepolia.etherscan.io/address/0x61FA294Fb1CA457B9F3a22e71b36971d4A1E3C20): not verified | `71bb2017` | 2026-11-11 |

#### Third-party contracts on Sepolia

Contracts that the bridge uses but that this project did not deploy.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| WETH | Wrapped ether on Sepolia, which the delivery router wraps the native coin into. Not deployed by this project. | `0x7b79995e5f793a07bc00c21412e50ecae098e7f9` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x7b79995e5f793a07bc00c21412e50ecae098e7f9): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x7b79995e5f793a07bc00c21412e50ecae098e7f9): verified · [Etherscan](https://sepolia.etherscan.io/address/0x7b79995e5f793a07bc00c21412e50ecae098e7f9): not checked | not ours | not recorded |

#### Retired contracts on Sepolia

Contracts that no longer take new traffic. The record still lists them, so transfers made through them stay readable.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| DeliveryRouter (retired) | The delivery router before the one above. It is retired, and the record still lists it so that deliveries made through it are recognised. | `0x3846e483c98cd0f164c29a5e40f7295a5765aba4` | [Blockscout](https://eth-sepolia.blockscout.com/address/0x3846e483c98cd0f164c29a5e40f7295a5765aba4): verified · [Sourcify](https://repo.sourcify.dev/11155111/0x3846e483c98cd0f164c29a5e40f7295a5765aba4): verified · [Etherscan](https://sepolia.etherscan.io/address/0x3846e483c98cd0f164c29a5e40f7295a5765aba4): not verified | `71bb2017` | 2026-11-08 |

### PulseChain testnet v4 (chain 943)

Verification status read on 2026-11-19.

#### Contracts in use on PulseChain testnet v4

The bridge itself, the helper contracts it needs and the light clients. Nothing here has an owner, an upgrade path or a pause.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| MessageBridge | Sends messages to the other chain and delivers the ones that arrive, after it checks the proofs that link each one to a finalized header of the other chain. | `0x5897d3de91d59fb691e3887d6ffbba072384293a` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x5897d3de91d59fb691e3887d6ffbba072384293a): verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| TokenMediator | Moves tokens through the bridge: it locks a native token here and mints a bridged copy on the other chain, or burns a copy and unlocks the native token. | `0x571f96605921f76a24cf1388c2caf126b15b09f7` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x571f96605921f76a24cf1388c2caf126b15b09f7): verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| BeaconForkGate | Refuses new sends when the other chain has moved to a state layout that the proof program cannot read. | `0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3): verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| TokenFactory | Creates the bridged copy of a token the first time that token is sent here. | `0x2436b1826a4879e90b565638147fe1c5c24364e5` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x2436b1826a4879e90b565638147fe1c5c24364e5): verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| DeliveryRouter | Optional entry point for delivery: it wraps the native coin, delivers the message, pays a voluntary tip, unwraps, and makes the follow-up call. | `0xa125684b9479fbab64218581763788bafb520a57` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0xa125684b9479fbab64218581763788bafb520a57): verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| ReceiptProofLib | Library that checks the receipt, transaction and log proofs of a message against a block. | `0x6dcc32be1802b1747465dfb2d3a1bf171eaed611` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x6dcc32be1802b1747465dfb2d3a1bf171eaed611): not verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| OpeningProofLib | Library that checks the opening proof that releases tokens locked by a one-way deposit. | `0x9765bc0e7f57d0064b99a4ae855db16e5b5aa7ba` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x9765bc0e7f57d0064b99a4ae855db16e5b5aa7ba): not verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| BeaconLayoutLib | Library that checks the beacon state layout rows (block roots, block hashes, historical summaries) that a message proof relies on. | `0x4acd9fcef648029931ce163d343feb6d94181322` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x4acd9fcef648029931ce163d343feb6d94181322): not verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| MediatorPayloads | Library that encodes and decodes the token messages that the mediator sends across the bridge. | `0x1e68160762061624bb5fa31d589a8f31c3e44bc5` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x1e68160762061624bb5fa31d589a8f31c3e44bc5): not verified · Sourcify: not supported · Etherscan: not supported | `cf63fff9` | 2026-11-11 |
| BeaconLightClient (follows Sepolia) | Light client of the Sepolia beacon chain, kept on PulseChain testnet v4. It stores finalized headers and accepts a new one only with a zero-knowledge proof. | `0x1dbbcc0bc25de5f6ae122fb0009b3ee4931fd958` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x1dbbcc0bc25de5f6ae122fb0009b3ee4931fd958): verified · Sourcify: not supported · Etherscan: not supported | `4e86885` | 2026-10-29 |
| BeaconLightClient (follows 943) | Light client of the PulseChain testnet v4 beacon chain, kept on PulseChain testnet v4 itself. The fork registry reads it. | `0x759b764D7FE6e0adC97CfD00Eca886Ff53f6A329` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x759b764D7FE6e0adC97CfD00Eca886Ff53f6A329): verified · Sourcify: not supported · Etherscan: not supported | `4e86885` | 2026-10-29 |
| ForkRegistry | Records the fork version and state layout of this chain's own beacon chain from proofs, so the gate can tell when the layout changes. | `0x0f094a965f280599b41f57a5182955f4afad063f` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x0f094a965f280599b41f57a5182955f4afad063f): verified · Sourcify: not supported · Etherscan: not supported | `4e86885` | 2026-10-29 |
| SP1Verifier | Checks the Groth16 zero-knowledge proofs that the light clients accept (the vendored SP1 verifier, version 6.1.0). | `0xB01856AbEf5b971019F1d25630450cc6bcbAFB21` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0xB01856AbEf5b971019F1d25630450cc6bcbAFB21): verified · Sourcify: not supported · Etherscan: not supported | `4e86885` | 2026-10-29 |

#### Test tokens on PulseChain testnet v4

Test tokens used on the testnet pair. Each chain holds the original of one token and the bridged copy of the other chain's token.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| TestToken tUSD | Test token zkb Test Dollar (tUSD, 6 decimals). Only the deployer can mint it. | `0x11b211e478105683096e5da4ce1abf019ff35961` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x11b211e478105683096e5da4ce1abf019ff35961): verified · Sourcify: not supported · Etherscan: not supported | `71bb2017` | 2026-11-01 |
| TestToken tTKN | Test token zkb Test Token (tTKN, 18 decimals). Only the deployer can mint it. | `0xa8b9650a2021e014253a338629f8095d1f2e2910` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0xa8b9650a2021e014253a338629f8095d1f2e2910): verified · Sourcify: not supported · Etherscan: not supported | `71bb2017` | 2026-11-01 |
| BridgedToken ztUSD | Bridged copy of tUSD from Sepolia, created by the token factory on the first transfer. | `0x75dE3c47773162Be247D145619B4266e255dfFF1` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x75dE3c47773162Be247D145619B4266e255dfFF1): not verified · Sourcify: not supported · Etherscan: not supported | `71bb2017` | 2026-11-11 |
| BridgedToken ztTKN | Bridged copy of tTKN from Sepolia, created by the token factory on the first transfer. | `0x96EF4e50E0BdffB2f4D1708568BdfF16416b8725` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x96EF4e50E0BdffB2f4D1708568BdfF16416b8725): verified · Sourcify: not supported · Etherscan: not supported | `71bb2017` | 2026-11-11 |

#### Third-party contracts on PulseChain testnet v4

Contracts that the bridge uses but that this project did not deploy.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| WPLS | Wrapped PLS on PulseChain testnet v4, which the delivery router wraps the native coin into. Not deployed by this project. | `0x70499adebb11efd915e3b69e700c331778628707` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0x70499adebb11efd915e3b69e700c331778628707): verified · Sourcify: not supported · Etherscan: not supported | not ours | not recorded |

#### Retired contracts on PulseChain testnet v4

Contracts that no longer take new traffic. The record still lists them, so transfers made through them stay readable.

| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |
|---|---|---|---|---|---|
| DeliveryRouter (retired) | The delivery router before the one above. It is retired, and the record still lists it so that deliveries made through it are recognised. | `0xbea5f0fd3712b02c25bda32c7719fb9373c0fa20` | [PulseChain testnet scan](https://scan.v4.testnet.pulsechain.com/#/address/0xbea5f0fd3712b02c25bda32c7719fb9373c0fa20): verified · Sourcify: not supported · Etherscan: not supported | `71bb2017` | 2026-11-08 |

## How to check a contract yourself

1. Open the explorer link of the contract and confirm that the page shows verified source code with the contract name from the table. The address in the table is the full address; compare it with the one you are about to use.
2. Check the source against the chain. Check out the source commit from the table, build with the pinned compiler (Solidity 0.8.28, 200 optimizer runs, EVM version shanghai, no metadata hash, as set in `foundry.toml`), and compare the result with the code on the chain: `cast code <address> --rpc-url <rpc>` gives the deployed code. A contract that links a library has the library address written into its code; the libraries are in the same table.
3. A Blockscout page may say "partial match". The build sets no metadata hash, so Blockscout has no hash to compare and calls the match partial. Sourcify compares the same code and reports an exact match.
4. A contract shows "not verified" on an explorer until its source has been submitted there. That says nothing about the contract itself: the code on the chain is the same either way, and you can compare it yourself as in step 2.
5. Sourcify does not serve PulseChain testnet v4, and Etherscan serves only Ethereum chains, so those cells read "not supported".

## Keeping this page current

Every contract deployment updates the deployment record, runs the verification script (`deploy/contracts-page/verify.mjs`), regenerates this page (`deploy/contracts-page/generate.mjs`) and commits the result. A test fails when the committed page differs from what the record renders to. The steps are in `docs/testnet-run.md`.
