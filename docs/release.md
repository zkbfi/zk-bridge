# Releases

A release is one directory, made by `script/release/release.sh` and checked before anything leaves the machine. The
signed release on IPFS is the source of truth. Everything else is a mirror of it.

## What a release holds

| Path | What it is |
| --- | --- |
| `archives/dapp.car`, `archives/docs.car`, `archives/landing.car` | Each site packed as one content-addressed archive (CAR). UnixFS, CID version 1, raw leaves, fixed 256 KiB chunks, files in sorted order. The same files always give the same CID. |
| `downloads/` | The terminal programs (`zk-bridge-terminal-<os>-<arch>`), the prover for the machine that made the release (`zk-bridge-prover-<os>-<arch>`), and both guest programs (`light-client.elf`, `fork-observation.elf`). |
| `version.json` | The release list: each site with its version, commit, CID and archive SHA-256, and each download with its SHA-256. Written as the exact bytes the key signs (keys sorted, no spaces). Its `sequence` only goes up. |
| `version.json.sig` | The 64-byte Ed25519 signature of `version.json`. |
| `public-keys.json` | The public half of the key that signed. For reference only: a check trusts the keys built into the landing page, never this file. |
| `SHA256SUMS` | Every archive and download, in the format `sha256sum --check` reads. |

The landing page fetches `version.json` and its signature and checks them in the browser with the keys built into the
page (`explorer/landing/landing.config.json`). It refuses a `sequence` lower than one it has seen.

## Making a release

```sh
<password-manager command that prints the key> | script/release/release.sh "$(mktemp -d)"
```

The key arrives on standard input and is read only by the signing step at the end. Every build step runs with standard
input closed. Nothing writes the key to disk. Use any password manager whose command line prints a secret to standard
output.

`release.sh` builds the three sites, packs them, builds the terminal programs and the prover, writes `version.json`,
`SHA256SUMS`, the signature and `public-keys.json`, then verifies the whole directory. The last line is
`release verified`. The check covers the signature, the canonical form of `version.json`, each archive (hash, every
block against its content address, root CID) and each download, and it serves each site from its archive under
`/ipfs/<cid>/` and fetches every asset its `index.html` names. A site that uses a root path such as `/assets/x.js`
fails there, because a gateway serves it under a prefix.

Settings: `RELEASE_VERSION` (default `0.0.0-<short commit>`), `RELEASE_PREVIOUS_MANIFEST` (the last `version.json`, so the
sequence goes up), `RELEASE_TERMINAL_TARGETS`. `RELEASE_SKIP_PROVER=1` builds no prover and no guest program, and
`version.json` then lists none; use it only for a test run on a machine without Docker and `cargo prove`. A real
release builds both guest programs in the pinned Docker image (`light-client/scripts/program-keys.sh`).

To check a release yourself:

```sh
node explorer/release/src/cli.ts verify <release-directory> --public-keys explorer/landing/landing.config.json
```

## A testnet release

`script/release/testnet.env` holds the build settings of a release for the pair `sepolia-pls943`: the public indexer,
backend and archive addresses on zkb.fi, keyless public RPC endpoints, and the contracts of the testnet deployment
(`deploy/testnet/deployment.json`, inline). Load it before `release.sh`:

```sh
set -a; . script/release/testnet.env; set +a
RELEASE_VERSION=0.1.0-testnet.1 <password-manager command that prints the key> | script/release/release.sh "$(mktemp -d)"
```

The dapp then shows a TESTNET banner on every page (the pair registry marks `sepolia-pls943` as a testnet). The landing
page shows the `notice` of `explorer/landing/landing.config.json` above everything else; remove it for a mainnet
release. The dapp sets no msgboard node: no keyless public msgboard endpoint exists yet, and the dapp works without one.

## The release key

**Creating it.** Make one Ed25519 key on a machine you trust and put the private key straight into the password
manager:

```sh
node -e 'crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]).then(p=>crypto.subtle.exportKey("jwk",p.privateKey)).then(k=>process.stdout.write(JSON.stringify(k)))' \
  | <password-manager command that stores standard input as a secret>
```

Then put the public half (`{"kty":"OKP","crv":"Ed25519","x":"…"}`, the private key without `d`) into `publicKeys` of
`explorer/landing/landing.config.json`. The first release writes it to `public-keys.json` as well.

**One key.** There is exactly one release key at any time. It lives in the password manager and nowhere else: not in
the repository, not in CI, not in a file on a build machine.

**What it protects.** It signs `version.json`, which names the official content addresses and download hashes. A
stolen key could point the landing page and the update checks at a malicious build. It cannot touch the contracts or
any funds.

**Changing the key.** A new key is announced in a release signed by the old key: that release's landing page lists the
new key in its built-in keys, and its notes say so. Users who trust the old key can follow the change. After that
release, sign only with the new key.

**If the key is lost or stolen.** The old key cannot announce anything trustworthy any more. A successor forks the
release repository, makes a new key, and publishes under it. Users decide to switch to the successor's key. This is
the plain answer: there is no recovery that does not depend on users choosing whom to trust.

## Reproducible builds

Anyone can check a release against the source. Check out the commit that `version.json` names, run the same build, and
pack the sites with `node explorer/release/src/cli.ts pack <dist> <file.car>`: the CID must match. The packing is
deterministic (sorted files, fixed chunks, blocks sorted by CID), so the same site output gives the same CID and the
same archive bytes. The guest programs are built in a Docker image pinned by digest, and
`light-client/program-keys.json` records their SHA-256 and program keys. The sites and the guest programs are what a
reproducible check covers today. Bun-compiled terminal programs and the native prover are not yet byte-for-byte
reproducible across machines; compare them by building from source instead.

## Platforms

| Program | Published for | Everyone else |
| --- | --- | --- |
| Terminal | macOS (arm64, x64), Linux (x64, arm64); Windows x64 when its build succeeds | Build from source: `script/build-terminal.sh <dir> bun-<os>-<arch>` |
| Prover | The platform of the machine that made the release | Build from source: `cd prover && cargo build --release --no-default-features --features sp1` |
| Guest programs | Any (`platform: any`) | `light-client/scripts/program-keys.sh` rebuilds and checks them |
| Sites | IPFS | `pnpm --filter @zk-bridge/web build`, `pnpm --filter @zk-bridge/docs build`, `node explorer/landing/scripts/build.ts` |

## Publishing

Both targets are off until configured. Neither runs as part of `release.sh`. Both verify the release first.

**Where things are hosted.** The dapp and the docs are published on IPFS only. Normal hosting is only for backends and
landing pages: the landing page has a mirror on Cloudflare Pages at the zkb.fi root, and nothing else does.

### IPFS: `script/release/publish.sh <release-directory>`

It exits 1 with `no release remote or pinning account is configured` until both `RELEASE_REMOTE` (the git repository
that holds `version.json`) and `RELEASE_PIN_PROVIDER` are set. Then it verifies the release against the keys built into
the landing page (or `RELEASE_PUBLIC_KEYS`), pins the three archives, and pushes `version.json`, its signature,
`public-keys.json` and `SHA256SUMS` to the release remote.

The pinning step is an adapter chosen by `RELEASE_PIN_PROVIDER` (`explorer/release/src/pin.ts`). Each adapter uploads
an archive and fails unless the service reports the same CID that was computed here. There are two adapters.

**`kubo`: the IPFS node on the app server.** This is the main pin. The node's RPC API listens on `127.0.0.1:5001` of
the server only. It can pin, unpin and change the node, so it is never public. Reach it through an SSH tunnel:

```sh
ssh -N -L 5001:127.0.0.1:5001 zkbfi-app &
RELEASE_REMOTE=<release repository> RELEASE_PIN_PROVIDER=kubo KUBO_API_URL=http://127.0.0.1:5001 \
  script/release/publish.sh <release-directory>
```

- `KUBO_API_URL`: the RPC address. It must be http or https and carry no user or password.
- `KUBO_API_AUTH`: optional. The full `Authorization` header value, when the node sets `API.Authorizations`. Only from
  the environment; never printed.
- For each archive it POSTs the CAR to `/api/v0/dag/import?pin-roots=true` as the multipart field `file`. It fails
  unless the node reports exactly one root, that root is the CID computed here, and the pin of the root succeeded. Then
  it asks `/api/v0/pin/ls?type=recursive` and fails unless the root is pinned recursively.

**`filebase`: an optional second pin.** One node is one point of failure: while the app server is down, only gateway
caches hold the sites. A second, independent pin removes that. Run the pin step again with the other adapter:
`node explorer/release/src/cli.ts pin <release-directory> --prefix <version>`, with `RELEASE_PIN_PROVIDER=filebase`.

- `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`: an access key of the Filebase account. Only from the environment;
  never printed.
- `FILEBASE_BUCKET`: an IPFS bucket. Archives go to `<version>/<site>.car`.
- It PUTs each archive to `https://s3.filebase.com` (region `us-east-1`, AWS Signature Version 4) with the metadata
  `import=car` (the header `x-amz-meta-import: car`), so Filebase imports it as a CAR, and reads the CID from the
  `x-amz-meta-cid` header of the answer, or of a HEAD of the object. This follows Filebase's guide to pinning a CAR
  through the S3 API (filebase.com/docs/ipfs/pinning/pinning-files, read 2026-10-28).

A new provider is one more entry in the adapter table, with its credentials named in its error message.

### Cloudflare Pages: `script/release/publish-pages.sh <release-directory>`

Pages is a mirror. It deploys the landing archive of a verified release, unpacked, together with `version.json` and its
signature, so the page checks the same signed manifest wherever it is loaded:

```sh
RELEASE_PAGES_LANDING=<project> script/release/publish-pages.sh <release-directory>
```

It refuses (exit 1) when `RELEASE_PAGES_LANDING` is not set or the release does not verify, and runs
`npx wrangler@4 pages deploy <dir> --project-name <project> --branch main` otherwise. Wrangler reads its own Cloudflare
credentials. If the mirror and IPFS ever disagree, IPFS and the signature win.

**Open point.** The landing page links downloads at `./downloads/`. Pages refuses files over 25 MiB and the terminal
programs are larger, so the mirror does not carry them. Where the downloads are served from is not decided yet.
