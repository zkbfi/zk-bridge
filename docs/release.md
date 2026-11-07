# Releases

A release is one directory, made by `script/release/release.sh` and checked before anything leaves the machine. The
signed release on IPFS is the source of truth. Everything else is a mirror of it.

## What a release holds

| Path | What it is |
| --- | --- |
| `archives/dapp.car`, `archives/landing.car` | Each site packed as one content-addressed archive (CAR). The docs are inside the dapp (route `#/docs`, loaded lazily as a separate chunk), so there is no docs archive. The dapp archive also holds the docs as plain files next to `index.html` (`llms.txt`, `llms-full.txt`, `docs/<slug>.md`, `docs/skills/<name>/SKILL.md`, `data/chains.json`, `data/contracts.json`, `data/openapi/*.json`) for assistants and tools; see `docs/docs-machine-readable.md`. A release list signed before this may still name a `docs` site: it is read and verified as before, and the landing page lists only the dapp. UnixFS, CID version 1, raw leaves, fixed 256 KiB chunks, files in sorted order. The same files always give the same CID. |
| `downloads/` | The terminal programs (`zk-bridge-terminal-<os>-<arch>`), the prover for the machine that made the release (`zk-bridge-prover-<os>-<arch>`), and both guest programs (`light-client.elf`, `fork-observation.elf`). |
| `version.json` | The release list: each site with its version, commit, CID and archive SHA-256, and each download with its SHA-256. Written as the exact bytes the key signs (keys sorted, no spaces). Its `sequence` only goes up. |
| `version.json.sig` | The 64-byte Ed25519 signature of `version.json`. |
| `public-keys.json` | The public half of the key that signed. For reference only: a check trusts the keys built into the landing page, never this file. |
| `SHA256SUMS` | Every archive and download, in the format `sha256sum --check` reads. |
| `releases-log.json` | The release log of the channel: every site ever published on it, with its CID, this release's sites last. Only ever appended to. See "The release log". |
| `releases-log.json.sig` | The 64-byte Ed25519 signature of `releases-log.json`, by the same key and code as `version.json.sig`. |

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
sequence goes up), `RELEASE_TERMINAL_TARGETS`, `RELEASE_REMOTE` (the release repository: the channel's published
`releases-log.json` is fetched from it before the build, see "The release log"; `RELEASE_PREVIOUS_LOG` names a log file
instead). `RELEASE_SKIP_PROVER=1` builds no prover and no guest program, and
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
| Sites | IPFS | `pnpm --filter @zk-bridge/web build` (runs `script/check-docs-public.sh` first, because the docs pages are part of it), `node explorer/landing/scripts/build.ts` |

## Publishing

Both targets are off until configured. Neither runs as part of `release.sh`. Both verify the release first.

**Where things are hosted.** The dapp (docs included, at `#/docs`) is published on IPFS only. Normal hosting is only for backends and
landing pages: the landing page has a mirror on Cloudflare Pages at the zkb.fi root, and nothing else does.

**docs.zkb.fi.** The docs are not a second site. Owner, verbatim: "perhaps docs should be async loaded in the same app as
dapp? no need to consume a second domain" and "yes, point docs.zkb.fi at the dapp. have it go to /#/docs". The
DNSLink record `_dnslink.docs.zkb.fi` names the dapp's CID (`releases[name=dapp].cid` in `version.json`), set with
`deploy/ansible/sites.yml -e docs_cid=<dapp cid> -e confirm_production=yes` (the variable keeps its old name). When the
dapp loads on a host that starts with `docs.` and the address has no hash or `#/`, it replaces the address with `#/docs`
(`explorer/web/src/app/docs-host.ts`, no reload). The landing page lists the dapp with a "Docs" link at each gateway form:
the same address plus `/#/docs`.

### IPFS: `script/release/publish.sh <release-directory>`

It exits 1 with `no release remote or pinning account is configured` until both `RELEASE_REMOTE` (the git repository
that holds `version.json`) and `RELEASE_PIN_PROVIDER` are set. Then it verifies the release against the keys built into
the landing page (or `RELEASE_PUBLIC_KEYS`), checks that the release's `releases-log.json` only appends to the log on
the channel's branch (see "The release log"), pins the archives, and pushes `version.json`, its signature,
`public-keys.json`, `SHA256SUMS` and the release log with its signature to the release remote.

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

**Two keys, on purpose.** A staging release is signed with its own Ed25519 key, kept in the password manager next to the
production key. The staging landing page (`explorer/landing/landing.next.config.json`)
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
<password-manager command that prints the staging key> | RELEASE_CHANNEL=next RELEASE_VERSION=0.1.2-next.1 \
  RELEASE_PREVIOUS_MANIFEST=<the version.json now on next.zkb.fi> RELEASE_REMOTE=<release repository> \
  script/release/release.sh "$(mktemp -d)"
RELEASE_CHANNEL=next RELEASE_REMOTE=<release repository> RELEASE_GIT_NAME=<name> RELEASE_GIT_EMAIL=<email> \
  RELEASE_PIN_PROVIDER=kubo KUBO_API_URL=http://127.0.0.1:5001 script/release/publish.sh <release-directory>
RELEASE_CHANNEL=next RELEASE_PAGES_LANDING=zkb-fi-next RELEASE_LANDING_DOMAINS=next.zkb.fi \
  script/release/publish-pages.sh <release-directory>
```

The archives are pinned on the kubo node under their version, as production ones are (`zkbfi-<site>-<version>`,
`/releases/<version>/<site>`). Downloads go to a GitHub release tagged `v<version>` on zkbfi/releases, as for production.

## Promotion: next to zkb.fi

```sh
<password-manager command that prints the production key> | PROMOTE_PUBLISH=1 RELEASE_REMOTE=<release repository> \
  RELEASE_GIT_NAME=<name> RELEASE_GIT_EMAIL=<email> RELEASE_PIN_PROVIDER=kubo KUBO_API_URL=http://127.0.0.1:5001 \
  script/release/promote.sh <staging-release-directory> "$(mktemp -d)"
```

**Promotion requires the staging commit to be on main.** A staging manifest is signed by the staging key only, so it
may not decide on its own what the production key signs: the commit it names must be a full 40-character SHA that is
already on `origin/main` (after a fresh fetch). Staging releases may be built from any branch; they are promoted once
their commit is merged to main. The production landing page built from that commit must trust exactly the keys of the
operator's `landing.config.json`, and no staging key (`script/release/promote-checks.sh`).

`promote.sh` verifies the staging release against the staging key, rebuilds only the landing page (at the staging
commit, with the production configuration), and writes a production `version.json` (`channels.stable`, sequence =
the live production sequence + 1, version = the staging version without `-next.N`, or `PROMOTE_VERSION`) that keeps the
dapp archive byte for byte: production serves the exact content address that was tried on staging, already
pinned. It refuses if a kept archive differs from what the staging manifest names. It appends the production sites to
the stable release log (fetched from the `main` branch of `RELEASE_REMOTE`, or `RELEASE_PREVIOUS_LOG`, and checked
against the production key before anything is built), signs `version.json` and the log with the production key,
verifies both against the production key, and with `PROMOTE_PUBLISH=1` runs `publish.sh` and `publish-pages.sh` with the
channel fixed to stable. Upload the downloads to the GitHub release of the production version as for any release.

## The release log

`version.json` names only the current release. When an old pin went missing (the dapp of 0.1.2-next.4), no published
list named its CID. `releases-log.json` fixes that: one signed file per
channel that lists every site ever published on it, with its content address, so any release can always be found and
pinned again.

**What it holds.** `{"schema":1,"channel":"next","entries":[…]}`, written as the exact bytes the key signs (keys
sorted, no spaces, the same rule as `version.json`). One entry per published site, oldest first:

| Field | What it is |
| --- | --- |
| `channel`, `version`, `sequence` | The release the site belongs to (the `sequence` of its `version.json`). |
| `name`, `cid`, `archiveSha256` | The site (`dapp`, `landing`, or `docs` for releases before the docs moved into the dapp), its CID and the SHA-256 of its archive. |
| `commit`, `publishedAt` | The source commit and the time, as `version.json` names them. |
| `previous` | The SHA-256 (hex) of the canonical bytes of the entry before it; `null` for the first entry. |

**Rules** (`explorer/release/src/release-log.ts`). Every entry is on the log's channel. Each `previous` is the hash of
the entry before it, so a history rewritten anywhere no longer chains to a copy someone kept earlier, signature or not.
Entries of one release are adjacent, share its version and name each site once; sequences go up from one release to the
next. A new log must hold the published log's entries byte for byte, in place, and add at least one release with a
higher sequence. A log that reorders, edits, removes, breaks the chain, carries a signature of another key or does not
raise the sequence is refused.

**Keys.** The log of each channel is signed by that channel's key: the staging key for `next`, the production key for
`stable`. It is always checked against the keys in the channel's landing configuration (`landing.next.config.json`,
`landing.config.json`), never against keys that come with a release or the repository.

**Where it lives.** In the release repository next to `version.json` (branch `next` for next, `main` for stable), and
served next to `version.json` by the landing mirror: `publish-pages.sh` puts `releases-log.json` and its signature in
the deployed site, so they are at `https://next.zkb.fi/releases-log.json` and `https://zkb.fi/releases-log.json` from
that channel's next deploy. The log is not inside the landing archive: the landing CID is one of its entries.

**How each step uses it.**

- `release.sh` fetches the channel's published log from `RELEASE_REMOTE` first (or reads `RELEASE_PREVIOUS_LOG` and its
  `.sig`), and checks it against the channel's trusted keys before anything is built. It stops when the channel's
  branch has releases but no log yet (make the first log, below). After `version.json` it writes the new log (the
  published one plus this release's sites); the signing step signs both files with the one key read from standard
  input; the last check confirms the log ends with this release. With neither `RELEASE_REMOTE` nor
  `RELEASE_PREVIOUS_LOG` the log starts with this release, which is right only for a test run or a new channel:
  `publish.sh` refuses it when the repository already has a log.
- `publish.sh` clones the channel's branch, then refuses before pinning or pushing unless the new log extends the
  branch's log exactly (`log-check --extends`) and ends with this release. A branch that has releases but no log is
  refused. A branch that does not exist yet takes any valid log.
- `promote.sh` appends the production sites to the stable log the same way (from the `main` branch of `RELEASE_REMOTE`,
  or `RELEASE_PREVIOUS_LOG`).
- `verify` checks the log whenever a release directory holds one: signature, rules, and that its last entries are the
  sites of `version.json`.

Check a log yourself (its signature is read from `<file>.sig`):

```sh
curl -fsSO https://next.zkb.fi/releases-log.json && curl -fsSO https://next.zkb.fi/releases-log.json.sig
node explorer/release/src/cli.ts log-check releases-log.json --public-keys explorer/landing/landing.next.config.json
# that a newer copy only appends to an older one you kept:
node explorer/release/src/cli.ts log-check releases-log.json --public-keys explorer/landing/landing.next.config.json \
  --extends <older copy>/releases-log.json
```

### The first log of a channel: `script/release/bootstrap-log.sh`

Made once per channel, before the next release of that channel (until then `release.sh` and `publish.sh` stop with a
pointer here). It clones the channel's branch with its full history, reads every signed `version.json` ever pushed,
checks each signature against the channel's trusted keys, and logs their sites in sequence order. A commit without a
valid signature, on another channel or repeating a taken sequence is listed as skipped; a sequence no commit holds is
listed as a gap. Nothing is invented and nothing is re-pinned. The key arrives on standard input and is read only by
the signing step.

```sh
# next (staging key)
<password-manager command that prints the staging key> | RELEASE_CHANNEL=next \
  RELEASE_REMOTE=<release repository> RELEASE_GIT_NAME=<name> RELEASE_GIT_EMAIL=<email> BOOTSTRAP_PUBLISH=1 \
  script/release/bootstrap-log.sh "$(mktemp -d)"
# stable (production key)
<password-manager command that prints the production key> | RELEASE_CHANNEL=stable \
  RELEASE_REMOTE=<release repository> RELEASE_GIT_NAME=<name> RELEASE_GIT_EMAIL=<email> BOOTSTRAP_PUBLISH=1 \
  script/release/bootstrap-log.sh "$(mktemp -d)"
```

Without `BOOTSTRAP_PUBLISH=1` it only writes and checks the signed log in the output directory; look at it, then run
again with it. With it, the script commits `releases-log.json` and its signature to the branch and pushes, never
forced: if the branch moved meanwhile the push fails, and a branch that already holds a log is refused.

### Pinning every release again: `script/release/repin-from-log.sh`

Reads a channel's log, checks it against the channel's trusted keys, and asks the kubo node about every CID it lists
(each CID once). A dry run by default: it prints each CID as `pinned` or `MISSING` and pins nothing.

```sh
ssh -N -L 5001:127.0.0.1:5001 zkbfi-app &
RELEASE_CHANNEL=next KUBO_API_URL=http://127.0.0.1:5001 script/release/repin-from-log.sh
# then, to pin what is missing:
REPIN_APPLY=1 RELEASE_CHANNEL=next KUBO_API_URL=http://127.0.0.1:5001 script/release/repin-from-log.sh
```

- The log comes from the file given as the argument (its signature at `<file>.sig`), else from the channel's branch of
  `RELEASE_REMOTE`, else from the channel's site (`https://next.zkb.fi/releases-log.json` or
  `https://zkb.fi/releases-log.json`).
- `KUBO_API_AUTH`, when the node needs it, is read from the environment only, sent as the `Authorization` header, and
  never passed on a command line or printed, as for the kubo pin adapter.
- With `REPIN_APPLY=1`, each missing CID is pinned with `pin/add` under the name `zkbfi-<site>-<version>` (the latest
  release that lists it). The node fetches the content from the network; a CID no reachable peer holds fails after a
  timeout, is reported as `FAILED`, and the script exits 1. Re-pinning does not file the archive under
  `/releases/<version>/` in MFS; the log is the index.
