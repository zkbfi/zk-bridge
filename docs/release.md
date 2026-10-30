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

## Pairs and settings of a release

One release serves every pair that has a deployment. Each pair has one file, `deploy/deployments/<pair>.json` (the
file name is the pair name, such as `sepolia-pls943`); add a file to add a pair. `script/release/release.env` holds
the build settings: the public indexer, backend and archive addresses on zkb.fi, keyless public RPC endpoints, and
`VITE_EXPLORER_DEPLOYMENTS_JSON`, a map of every deployment file built at load time. Load it before `release.sh`:

```sh
set -a; . script/release/release.env; set +a
RELEASE_VERSION=<version> <password-manager command that prints the key> | script/release/release.sh "$(mktemp -d)"
```

The dapp opens the pair that `?pair=<name>` or a `#/pair/<name>` route asks for, else `VITE_EXPLORER_PAIR` when it is
set, else the first file. Its global view lists every pair of the release; another pair opens with a fresh page load,
because the page builds its connections for one pair. The indexer, backend and archive addresses apply to every pair,
so a release that adds a pair served by other services needs those settings per pair first. The dapp sets no msgboard
node: no keyless public msgboard endpoint exists yet, and the dapp works without one.

The landing page links each download at `<downloadBaseUrl>/<file>`. In `explorer/landing/landing.config.json`,
`{version}` in `downloadBaseUrl` becomes the version of the signed dapp release, so one setting serves every release.
The downloads are attached to the GitHub release of that version on `zkbfi/releases`; the signed SHA-256 on the page
is what makes them safe to use, not the host.

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
RELEASE_CHANNEL=stable RELEASE_REMOTE=<release repository> RELEASE_GIT_NAME=<name> RELEASE_GIT_EMAIL=<email> \
  RELEASE_PIN_PROVIDER=kubo KUBO_API_URL=http://127.0.0.1:5001 script/release/publish.sh <release-directory>
```

- `RELEASE_GIT_NAME`, `RELEASE_GIT_EMAIL`: the author and committer of the release commit. The checkout is a temporary
  folder, so the script never takes them from the git configuration, where the machine's default identity would apply.
- `KUBO_API_URL`: the RPC address. It must be http or https and carry no user or password.
- `KUBO_API_AUTH`: optional. The full `Authorization` header value, when the node sets `API.Authorizations`. Only from
  the environment; never printed.
- For each archive it POSTs the CAR to `/api/v0/dag/import?pin-roots=true` as the multipart field `file`. It fails
  unless the node reports exactly one root, that root is the CID computed here, and the pin of the root succeeded. Then
  it asks `/api/v0/pin/ls?type=recursive` and fails unless the root is pinned recursively.
- Every version stays hosted until it is retired on purpose, so users can move off an old version at their own pace.
  The adapter keeps each release addressable by version: it names the pin `zkbfi-<site>-<version>` (`pin/add` with
  `name`), and files the archive in the node's MFS at `/releases/<version>/<site>` (`files/mkdir`, then
  `files/cp /ipfs/<cid>`). It needs the object key `<version>/<site>.car`, which `publish.sh` passes. An archive filed
  earlier at that same path is replaced; nothing else is removed and nothing is unpinned.
- List the hosted versions through the tunnel:

  ```sh
  curl -s -X POST -H "Authorization: $KUBO_API_AUTH" 'http://127.0.0.1:5001/api/v0/pin/ls?type=recursive&names=true'
  curl -s -X POST -H "Authorization: $KUBO_API_AUTH" 'http://127.0.0.1:5001/api/v0/files/ls?arg=/releases'
  ```

  On the server the same lists come from `ipfs pin ls --names` and `ipfs files ls /releases` (as the node's user, with
  the API token). Retiring a version is a manual, deliberate step: unpin its three CIDs and remove `/releases/<version>`.
  Retire a version only after the signed list has moved users to a newer one.

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
RELEASE_CHANNEL=stable RELEASE_PAGES_LANDING=zkb-fi RELEASE_LANDING_DOMAINS=zkb.fi,www.zkb.fi script/release/publish-pages.sh <release-directory>
```

It refuses (exit 1) when `RELEASE_PAGES_LANDING` or `RELEASE_CHANNEL` is not set, when the release names another
channel than `RELEASE_CHANNEL`, when the Worker or a domain belongs to the other channel, or when the release does not
verify. Otherwise it deploys a
Cloudflare Worker with static assets only (`npx wrangler@4 deploy` with a configuration written outside the site):
wrangler 4 creates new projects as Workers, not as classic Pages projects. `RELEASE_LANDING_DOMAINS` attaches custom
domains; a domain must have no other DNS record on that name. Wrangler reads its own Cloudflare credentials. If the
mirror and IPFS ever disagree, IPFS and the signature win. The mirror carries no downloads: the terminal programs are
larger than its 25 MiB file limit, and they come from the GitHub release instead (see "Pairs and settings of a
release").

## Staging: next.zkb.fi

`next.zkb.fi` is the staging channel. It is the same signed landing page as zkb.fi, served by its own Worker
(`zkb-fi-next`), listing a release on the `next` channel. Builds are tried there, by anyone with the link, before they
reach zkb.fi.

**Two keys, on purpose.** A staging release is signed with its own Ed25519 key, the 1Password item
`release signing key staging` in the zkb.fi vault. The staging landing page (`explorer/landing/landing.next.config.json`)
trusts only that key; the production landing page (`landing.config.json`) trusts only the production key. So a staging
`version.json` can never be accepted by zkb.fi, even though both are valid signatures, and a leaked staging key cannot
publish to production. Each landing page also keeps its own sequence memory (a separate browser origin).

**The channel is the operator's, never the artifact's.** `publish.sh` and `publish-pages.sh` require
`RELEASE_CHANNEL=stable` or `next`. It picks the trusted keys, the branch of the release repository (`main` or `next`)
and the allowed targets (stable: Worker `zkb-fi`, zkb.fi and www.zkb.fi; next: Worker `zkb-fi-next`, next.zkb.fi; the
mapping lives in `script/release/channels.sh`). A release that names another channel, or a target of the other
channel, is refused before anything is pinned, pushed or deployed. Trusting the channel written in `version.json` would
let a staging release choose its own keys.

Make and publish a staging release:

```sh
set -a; . script/release/release.env; set +a
op read 'op://zkb.fi/release signing key staging/credential' | RELEASE_CHANNEL=next RELEASE_VERSION=0.1.2-next.1 \
  RELEASE_PREVIOUS_MANIFEST=<the version.json now on next.zkb.fi> script/release/release.sh "$(mktemp -d)"
RELEASE_CHANNEL=next RELEASE_REMOTE=<release repository> RELEASE_GIT_NAME=<name> RELEASE_GIT_EMAIL=<email> \
  RELEASE_PIN_PROVIDER=kubo KUBO_API_URL=http://127.0.0.1:5001 script/release/publish.sh <release-directory>
RELEASE_CHANNEL=next RELEASE_PAGES_LANDING=zkb-fi-next RELEASE_LANDING_DOMAINS=next.zkb.fi \
  script/release/publish-pages.sh <release-directory>
```

The archives are pinned on the kubo node under their version, as production ones are (`zkbfi-<site>-<version>`,
`/releases/<version>/<site>`). Downloads go to a GitHub release tagged `v<version>` on zkbfi/releases, as for production.

## Promotion: next to zkb.fi

```sh
op read 'op://zkb.fi/release signing key/credential' | PROMOTE_PUBLISH=1 \
  script/release/promote.sh <staging-release-directory> "$(mktemp -d)"
```

`promote.sh` verifies the staging release against the staging key, rebuilds only the landing page (at the staging
commit, with the production configuration), and writes a production `version.json` (`channels.stable`, sequence =
the live production sequence + 1, version = the staging version without `-next.N`, or `PROMOTE_VERSION`) that keeps the
dapp and docs archives byte for byte: production serves the exact content addresses that were tried on staging, already
pinned. It refuses if a kept archive differs from what the staging manifest names. It signs with the production key,
verifies against the production key, and with `PROMOTE_PUBLISH=1` runs `publish.sh` and `publish-pages.sh` with the
channel fixed to stable. Upload the downloads to the GitHub release of the production version as for any release.
