# Local network

This page shows how to run two local chains with the hardened bridge contracts deployed on them. You need three commands. The network has no prover, no bots and no beacon chain. It gives you chains and contracts. A stateful server of yours, or a script, does the rest.

The files are in `docker/`. The network is for development only. It uses the oracle verifier, so it needs no proving toolchain. Every key is a public Anvil development key.

The full relayer used to run on this network. It posted the updates, opened the bridges, delivered the messages and ran bots that moved test tokens both ways. That code lives on the branch `archive/full-relayer`, together with its Anvil tests, the attack scripts and the end-to-end scripts. The repository now holds only the part that makes proofs (`prover/README.md`).

## What runs

| Service | What it does |
|---|---|
| `chain-a` | An Anvil chain with identifier 1 and the `cancun` hardfork. RPC on `http://127.0.0.1:28545`. |
| `chain-b` | An Anvil chain with identifier 369 and the `shanghai` hardfork. RPC on `http://127.0.0.1:28546`. |
| `deploy` | A one-shot job. It deploys the wrapped native tokens, the test tokens, the oracle verifiers, and on each chain the light client, the gate, the message bridge, the token mediator (with its token factory) and the native coin router. |

Both chains mine one block every 2 seconds. They use the standard Anvil mnemonic. The ports bind to localhost only. They differ from the ports of the tests (18545 and 18546), so both can run together.

## Start

Run these commands from the repository root.

```
docker compose -f docker/compose.yaml up -d chain-a chain-b
docker compose -f docker/compose.yaml run --rm deploy
```

The deploy job takes about 30 seconds. It writes its result to the volume `bridge-state`: `deployment.json` holds, for each chain, the keys `token`, `wrapped_native`, `bridge`, `mediator`, `token_factory`, `native_router`, `gate`, `light_client`, `start_block` and `gate_genesis_time`, and the chain identifier. `start_block` is the block where the light client was deployed.

```
docker compose -f docker/compose.yaml run --rm --entrypoint cat deploy /state/deployment.json
```

You can run the deploy job again. If the bridges and mediators already exist, it prints "already deployed" and stops. If the chains hold other contracts, it refuses and says so. Chains that restart lose their state. Then run `down -v` (see "Stop") and start again.

## What is left to do

Both bridges start locked. A new bridge refuses every send with `DepositsNotOpen()` until a proof shows that the light client on the other chain stored a head. A token relay is a send, so it waits too. The launch sequence in `docs/hardened-build-contract.md` lists the steps. A stateful server does them: it posts light-client updates, calls `openDeposits` on each bridge, and delivers the messages.

The light clients of this network start from made-up checkpoint hashes, and Anvil has no beacon chain. So the `prove` command cannot make a proof here. The oracle backend can sign for the oracle verifier, but it needs a beacon source that serves updates. The test crate has one: a signed beacon chain over local blocks (`prover/src/local_network/signed_beacon/`). `prover/tests/produce.rs` and `prover/tests/evidence.rs` use it. For a run with real proofs and the real verifier, see `docs/end-to-end-real-proofs.md`.

The oracle of each verifier is the second Anvil account. To sign with it, put its key in the environment of the producer and name the variable in `prover.oracle_key_env`. Print the key with `cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 1`. Never write it into a file that you commit.

You can read the chains with `cast`. Replace the addresses with the ones in `deployment.json`:

```
cast call <bridge address> 'depositsOpen()(bool)' --rpc-url http://127.0.0.1:28546
cast call <mediator address> 'mediatorContractOnOtherSide()(address)' --rpc-url http://127.0.0.1:28546
cast call <bridge address> 'remoteBridge()(address)' --rpc-url http://127.0.0.1:28546
cast call <mediator address> 'tokenFactory()(address)' --rpc-url http://127.0.0.1:28546
cast call <native router address> 'WETH()(address)' --rpc-url http://127.0.0.1:28546
cast call <light client address> 'head()(uint64)' --rpc-url http://127.0.0.1:28546
```

## Stop

```
docker compose -f docker/compose.yaml down -v
```

This command stops every container, removes the network and removes the volume `bridge-state`. Without `-v`, the volume stays, and a new deploy job finds the old record. The chains keep no state on disk, so a full restart always needs `-v`.

## Notes

- The deploy job runs `script/hardened/DeployBridge.s.sol` with `docker/bridge.config.template.json`. It checks the addresses that the script predicts against the chains.
- No contract holds test tokens at the start. The mediator locks a native token when someone relays it, and it mints a bridged copy on the other chain at the first relay. The test token of each chain (`token`) is there so that you can try a relay. The wrapped native token (`wrapped_native`) belongs to the native coin router.
- The images pin their base images by version and by digest.
- The Dockerfile has two more targets, `prover-sp1` (the proof producer for a server, `docs/server-prover.md`) and `prover-gpu-worker` (the worker for a GPU host, `docs/gpu-prover.md`).
