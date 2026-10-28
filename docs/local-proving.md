# Prove on your own computer

The terminal can make a light client proof on your own processor. It runs the `zk-bridge-prover` program with the
`sp1` backend and shows the stages as they finish. When the proof is ready, the terminal shows the update transaction
for your review. Nothing is sent before you approve it.

A local proof is slow and uses much memory. The remote prover (see `docs/gpu-prover.md`) is the normal way. Use the local
way when you will not trust a remote service, or when no remote prover is available.

## What you need

| Need | Value | Where it comes from |
|---|---|---|
| Memory | About 56 GiB. A run on less is likely to fail because memory runs out. | Measured: a real proof peaks at 48 to 56 GiB (`docs/end-to-end-real-proofs.md`). |
| Processor | 16 cores or more are advised. | The same page. More cores make the proof faster. |
| Disk | 10 GiB free. | The same page. |
| Docker | Not needed with a prover built with `sp1-native-gnark`. Needed with a prover built with `sp1` alone. | See "Docker" below. |
| Go | Needed only to build the prover from source. | The Groth16 step is Go code that the build compiles. |

The terminal checks the memory before it starts. Under 16 GiB it refuses and says so. From 16 GiB to 56 GiB it warns
that the run will likely fail, and still starts when you choose a direction. From 56 GiB it shows no warning.

### How much memory, in practice

I measured real proofs on a server with 32 threads (`docs/end-to-end-real-proofs.md`). One proof of one update took 284
to 322 seconds and peaked between 48 and 56 GiB. The prover keeps memory after a proof, so the terminal runs one proof
for each process.

The vendor page names 16 GiB as the floor, because the last step takes about 14 GiB. That is the least the terminal
accepts. It is not enough for a whole proof. I have not run a full proof on a computer with less than 56 GiB. A run on
32 GiB is likely to fail when memory runs out. Use a computer with 64 GiB, or use the remote prover.

### How long

On the server above, about 5 minutes for one update. On a laptop expect longer; I did not measure it. The dialog shows
a running clock and, when the proof ends, the seconds each stage took.

### Docker

The Groth16 step of SP1 has two forms, chosen when the prover is built (I read the pinned `sp1-sdk` 6.8.1 and
`sp1-recursion-gnark-ffi` 6.8.1 sources):

- **Native (`sp1-native-gnark`).** The wrapper runs inside the prover process. No Docker. The build needs a Go toolchain.
- **Docker (`sp1` alone).** The prover runs `docker run ghcr.io/succinctlabs/sp1-gnark:<version>` for the last step.
  It checks `docker info` first and stops with "Failed to run `docker info`" when Docker is not running. It needs
  Docker with enough memory for the wrap step.

Build the prover with `sp1-native-gnark` and the terminal needs no Docker. The server image uses this feature too.

## Build from source (recommended)

Build every file yourself and you know what runs on your machine.

1. Build the terminal. See `docs/terminal-program.md`:

   ```
   script/build-terminal.sh "$(mktemp -d)" bun-linux-arm64      # or your own target
   ```

2. Build the prover. It needs Rust 1.93.0 and Go 1.24 or later:

   ```
   cd prover
   cargo build --release --locked --no-default-features --features sp1-native-gnark --bin zk-bridge-prover
   ```

   The result is `prover/target/release/zk-bridge-prover`.

3. Build the two guest programs. This step needs `cargo prove` (sp1-cli 6.8.1), `jq` and a running Docker engine,
   because it rebuilds the programs in a pinned image so that the program keys match the deployed contracts:

   ```
   cd light-client
   ELF_OUTPUT_DIR=elf scripts/program-keys.sh
   ```

   The script checks each program against `light-client/program-keys.json` and exits with code 1 when a value differs.
   It writes `light-client/elf/light-client.elf` and `light-client/elf/fork-observation.elf`.
   Docker is needed here to build the programs, and not to prove with them.

4. Put the three files next to the terminal program, with these exact names:

   ```
   zk-bridge-terminal-<os>-<architecture>
   zk-bridge-prover
   light-client.elf
   fork-observation.elf
   ```

A downloaded release carries the same four files. Check each against the checksum file of the signed release manifest
before you run it.

## Set it up

The terminal reads the chain addresses from the secret store, as the Prover setup view does (key `6`). Set these:

- the RPC URL and the beacon URL of each chain, in Prover setup;
- the first block of each deployment: the terminal reads `start_block` from the deployment file of the pair, as the
  prover configuration does. The prover scans from there. A deployment file with no `start_block` for a chain stops the
  run with "The deployment file names no start_block for <chain>."

Nothing secret goes into a file you write. The terminal reads the URLs at the moment of the run. It puts them in a
private configuration file (mode 0600) that it deletes when the prover ends.

## Run it

1. Start the terminal and press `p`.
2. The dialog says whether the three files are in place and whether the memory is enough.
3. Press `1` or `2` to choose the direction.
4. Wait. The dialog shows a clock. When the prover ends it lists the stages with their seconds.
5. Press Enter. The review shows the `update` call to the light client. Approve it as for any transaction.

If the light client already holds the newest final header, the dialog says so and offers nothing to post.

## What the terminal shows when a need is missing

| Missing | What you see |
|---|---|
| One or more of the three files | "Missing next to the terminal program:" and the file names. You cannot start. |
| Memory under 16 GiB | "A local proof needs at least 16 GiB." You cannot start. |
| Memory from 16 GiB to 56 GiB | A warning that the run will likely fail. You can still start. |
| An RPC URL or beacon URL | "The beacon URL of Ethereum is not set. Open Prover setup (key 6)." |
| A start block in the deployment file | "The deployment file names no start_block for Ethereum." |
| Docker, with a prover built with `sp1` alone | The prover fails. The dialog shows the end of its output, which says `docker info` failed. Use a prover built with `sp1-native-gnark`. |
| Memory runs out during the proof | The prover ends with an error. The dialog shows the end of its output. |

The dialog never prints a key or an endpoint path. The prover cuts every URL to its scheme and host in its own log
lines.

## What I checked and what I did not

- I read the pinned SP1 sources to find when Docker is needed (above).
- The terminal tests run the real command wrapper against a stand-in prover. They check the `sp1` configuration, the
  file mode, the stages and the update transaction.
- I did not run a full Groth16 proof on this computer. It has 16 GiB of memory, and the server measurements peak near
  56 GiB.
