# The terminal program

The terminal program is a dashboard for the bridge. It reads the indexer and the chains, signs and sends, and runs the
operator actions. This page tells you how to get it, and what each build can and cannot do.

## Build it from source (recommended)

A copy that you build yourself needs no approval from the operating system, and you know what is in it.

```
cd explorer/terminal
bun install --frozen-lockfile
bun run src/main.tsx                      # run it from source
EXPLORER_DATA=fixture bun run src/main.tsx   # sample data, nothing reaches a chain
```

To make one standalone file for your own machine, or for every platform, run the build script from the repository root:

```
script/build-terminal.sh "$(mktemp -d)"                       # all five targets
script/build-terminal.sh "$(mktemp -d)" bun-darwin-arm64      # one target
```

The script writes `zk-bridge-terminal-<os>-<architecture>` for each target and prints one line for each:
`ok <file>` or `skipped <target>: <reason>`. The script exits with code 1 when a target other than Windows fails.
Windows is tried, and a failure there is a skip.

The targets are `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64` and `bun-windows-x64`.
Bun builds all of them from one machine. The script downloads the OpenTUI native library of each platform with
`npm pack`. It checks each download against the integrity hash that `explorer/terminal/bun.lock` pins, and stops using
the download if the hash differs. The build needs network access for this step.

Run `zk-bridge-terminal --version` to see `zk-bridge-terminal <version> <commit>`. A copy that runs from source shows
`source` in place of the commit. Run `zk-bridge-terminal --help` for the short usage text. Any other argument prints the
help and exits with code 2.

## Use a downloaded copy

Each download is listed with its SHA-256 checksum in the signed release manifest (`version.json`). Check the checksum
before you run the file. No Apple developer account signs these programs yet, so macOS asks for a one-time approval.

1. Check the checksum: `shasum -a 256 zk-bridge-terminal-darwin-arm64`. It must equal the value in the manifest.
2. Make the file runnable: `chmod +x zk-bridge-terminal-darwin-arm64`.
3. Start it once. macOS refuses and says it cannot verify the program.
4. Open System Settings, then Privacy and Security. Under the message about the program, choose Open Anyway.
   Or run `xattr -d com.apple.quarantine zk-bridge-terminal-darwin-arm64` once, and start it again.

macOS asks only once for each downloaded file. Linux needs only `chmod +x`.

## What each target does

I built all five targets on a Mac with an Apple processor on 2026-10-28 and ran what the machine could run.
"Starts" means the dashboard drew its first screen on sample data (`EXPLORER_DATA=fixture`). The hardware wallet and
secret store columns come from a probe program built with the same Bun options, run on the target where it could run.

| Target | Builds | Starts | Ledger over USB | Trezor | Secret store |
|---|---|---|---|---|---|
| macOS arm64 | yes | yes (native) | no | module loads; no device tried | yes: Keychain, through `security` |
| macOS x64 | yes | yes (under Rosetta) | no | module loads; no device tried | yes: Keychain, through `security` |
| Linux arm64 | yes | yes (Debian 12, arm64 virtual machine) | no | no | see the note below |
| Linux x64 | yes | not tested | not tested | not tested | not tested |
| Windows x64 | yes | not tested | not tested | not tested | no store; the encrypted file only |

Notes on the table:

- **Ledger over USB does not work in any compiled program that I could test.** The `node-hid` library looks for its
  native files beside its own source, and a compiled program has no such folder. The error is "Could not find module
  root". The same code works when you run from source. Use a copy built from source, or the dapp, for a Ledger.
- **Trezor** loads on macOS. It fails on Linux arm64 with "No native build was found", because the `usb` library
  has the same problem. No Trezor device was connected for this check, so I did not test a signature.
- **Secret store.** The program does not link a native library for it. It runs the operating system commands
  `security` on macOS and `secret-tool` on Linux, so it works where those commands work. Windows has no such
  command in the code, and uses the encrypted file. On Linux the check that decides whether `secret-tool` exists
  treats a missing command as present, so the program may pick a store that cannot work. Install `secret-tool` (the package `libsecret-tools`)
  before you rely on it.
- **Linux x64** builds, but the only Linux machine here is an emulated one, and Bun itself stops there with "CPU lacks
  AVX support". I did not run this file. The Linux arm64 file is built the same way and does run.
- **Windows x64** builds. I have no Windows machine, so I did not run it. Treat it as untested.

## What is inside each file

Each file holds the Bun runtime, the dashboard code and the OpenTUI native library for its own platform (and for Linux,
both the glibc and the musl library). The files are about 100 to 125 megabytes. They hold no secret, and nothing
reaches the network until you start an action.
