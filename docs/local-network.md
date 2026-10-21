# Local network

This page shows how to run the hardened bridge on two local chains in Docker. You need three commands. The network has bots that move test tokens in both directions, so you can watch the bridge work.

The files are in `docker/`. The network is for development only. It uses the oracle backend and the development beacon source, so it needs no proving toolchain. Every key is a public Anvil development key.

## What runs

| Service | What it does |
|---|---|
| `chain-a` | An Anvil chain with identifier 1 and the `cancun` hardfork. RPC on `http://127.0.0.1:28545`. |
| `chain-b` | An Anvil chain with identifier 369 and the `shanghai` hardfork. RPC on `http://127.0.0.1:28546`. |
| `deploy` | A one-shot job. It deploys the test tokens, the oracle verifiers and the bridge. |
| `prover` | The prover service in `run` mode, for both directions. |
| `bots` | Three accounts that deposit random small amounts, one direction after the other, for ever. |
| `beacon-stub` | A small HTTP server. It answers the three beacon requests that `route-health` makes. |

Both chains mine one block every 2 seconds. The deploy job, the prover, the bots and the beacon stub use `network_mode: host`. The prover refuses a development beacon source unless every RPC URL is a loopback address, so these services reach the chains on the published localhost ports. On Colima, the host is the Colima virtual machine. The beacon stub listens on `127.0.0.1:29000` there. They use the standard Anvil mnemonic. The ports bind to localhost only. They differ from the ports of the tests (18545 and 18546), so both can run together.

## Start

Run these commands from the repository root. The first build compiles the Rust code and takes several minutes. Later builds use the cache.

```
docker compose -f docker/compose.yaml up -d chain-a chain-b
docker compose -f docker/compose.yaml run --rm deploy
docker compose -f docker/compose.yaml up -d prover bots
```

The deploy job takes about 30 seconds. It writes its result to the volume `bridge-state`: `deployment.json` (all addresses), `prover.toml`, `route-health.toml` and a keystore for the prover.

You can run the deploy job again. If the vaults already exist, it prints "already deployed" and stops. If the chains hold other contracts, it refuses and says so. Chains that restart lose their state. Then run `down -v` (see "Stop") and start again.

## Watch

The bots log each deposit and each completed withdrawal. A withdrawal is complete when the destination vault says `claimed(nonce)`.

```
docker compose -f docker/compose.yaml logs -f bots
docker compose -f docker/compose.yaml logs -f prover
```

A deposit line looks like this: `event=deposit direction=a_to_b ... amount_tokens=0.37 nonce=0x...`. The line `fork_proof=true` shows a deposit that carried gate evidence. The Ethereum-side gate (chain A) runs in `Enforcing` mode and wants a fork proof for the first deposit of every epoch. The bots build the proof as the Anvil tests do.

A completed withdrawal line looks like this: `event=withdrawal_completed direction=a_to_b ... seconds=9 completed_a_to_b=3 completed_b_to_a=2`. The two counters tell you how many withdrawals each direction has paid.

## Check status

```
docker compose -f docker/compose.yaml exec prover prover-entry status
docker compose -f docker/compose.yaml exec prover prover-entry route-health
```

`status` prints one line for every deposit that the prover knows, with its state (`seen`, `awaiting_finality`, `light_client_updated`, `proven`, `submitted`, `confirmed` or `failed`). The last line is `deposits=N`.

`route-health` says for each route whether it can still deliver a deposit made now. See `prover/README.md`. On the local network it reads the beacon stub. The stub reports one fork (Capella) and the head slot of the local chain. Both routes show `OPEN` while the bots run. A route shows `STALE` when the bots stop and the light client head falls behind. A route shows `WARN` when the light client head and the chain head lie in different sync committee periods.

You can read the chains with `cast`. Replace the addresses with the ones in `deployment.json`:

```
docker compose -f docker/compose.yaml exec prover cat /state/deployment.json
cast call <vault address> 'claimed(bytes32)(bool)' <nonce> --rpc-url http://127.0.0.1:28546
```

## Tune the bots

The bots take options. Add them to the `command` of the `bots` service in `docker/compose.yaml`:

```
command: ["local-network", "traffic", "--minimum-wait-seconds", "2", "--maximum-wait-seconds", "6", "--bots", "5"]
```

## Stop

```
docker compose -f docker/compose.yaml down -v
```

This command stops every container, removes the network and removes the volume `bridge-state`. Without `-v`, the volume stays, and a new deploy job finds the old record. The chains keep no state on disk, so a full restart always needs `-v`.

## Notes

- The bots and the beacon stub are the binary `local-network` in `prover/`. It is built only with the cargo feature `dev-source`. A production build (`--no-default-features`) leaves it out.
- The prover signs with the second Anvil account. The same account is the oracle of the verifier contracts.
- The deploy job runs `script/hardened/DeployBridge.s.sol` with `docker/bridge.config.template.json`. It checks the addresses that the script predicts against the chains.
- Each vault receives 1,000,000 test tokens at the start, because a vault pays withdrawals from its own balance.
- The images pin their base images by version and by digest. The Rust build uses `cargo build --release --locked -j 2`, so it fits in a virtual machine with 2 GB of memory.
