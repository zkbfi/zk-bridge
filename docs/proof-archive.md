# Proof archive

Internal operator document. It is not on the docs site (`explorer/docs/public-pages.json` does not list it).

## Why

The owner, 2026-11-01:

> "and if the proofs get harder to compute the further back one has to go simply based on the rpc recomputing it, then we
> should also be caching the proofs right? as in, starting now"

> "seems like proofs is another thing that the indexer should be caching for us. we also need to write playbooks /
> scripts to help move import/export these proofs into and out of db's. otherwise we will lose them and they seem
> incredibly difficult to recompute"

On where the copies go:

> "start with my machine. we'll get cloudflare object storage together soon"

> "can we do ipfs as well? that could be cool. we have to publish the data though"

What is hard to get again:

- **Storage proofs** (`eth_getProof`). A node answers only inside its proof window. Measured: about 64 blocks on a public
  Sepolia node, about 128 on a public PulseChain testnet node, at least 4096 on the official 943 node. One provider
  refuses every historical depth. After that only an archive node can answer.
- **SP1 light client proofs.** These take GPU time to prove. A posted proof is in the calldata of its `update`
  transaction and on msgboard. A held proof (proved but not posted yet) exists only in the backend's SQLite file, and the
  backend deletes it once its job ends.
- **Delivery evidence of messages.** The prover builds it from receipts and header ancestry. The backend deletes it once
  the message is delivered.
- **Verified beacon states.** Public beacon nodes prune them.
- **Handoff updates of sync-committee periods.** A light client strands for good if no source has the "handoff
  update" of a period it missed (one period is about 23 to 27 hours). PulseChain beacon nodes serve no light client
  routes and prune the states the prover builds those updates from. So the backend captures, for every period of each
  source chain, one complete prover-ready update (a "handoff record"), and the archive keeps it for good. The record is
  untrusted data: the zk proof checks the committee signatures.

## Design

The indexer owns the archive. It is a Postgres schema of its own, `proof_archive`, in the indexer's database. It sits
beside Ponder's schemas, not inside one. Each indexer build gets a new Ponder schema (`DATABASE_SCHEMA=indexer_<hash>`,
`deploy/app-server/deploy.sh`), so nothing durable can live there. No release creates `proof_archive` from scratch or
drops it.

- **Migration** (`explorer/indexer/src/proof-archive/schema.ts`): one transaction under an advisory lock, all
  `CREATE ... IF NOT EXISTS`. The blue and green indexers of a switch can both run it at once.
- **Writes** (`store.ts`): rows are keyed by what they prove (natural keys), written by upsert, and never deleted.
  - A field that must match (`compare`) is never replaced. A different value is recorded in `proof_archive.conflicts`,
    and the upsert reports `conflict`.
  - A field that a later source may know (`fill`, such as the posting transaction or the proof message) is filled when
    the archived value is null. Two different non-null values are a conflict.
  - Metadata (`meta`: where and when a row came from) is written once and never compared.
- **The cache is not trusted.** Each consumer verifies what it reads:
  - The runner checks an archived storage proof against the state root of its block before it uses it
    (`explorer/shared/src/prover/proof-archive-client.ts`, `storage-proof-verify.ts`).
  - The prover verifies the local cache file again (`prover/src/proof_cache.rs`).
  - `verify-storage` checks the storage proofs of the mirror (or of an old bundle).

### Tables

| Table | Key | Holds |
|---|---|---|
| `storage_proofs` | chain id, address, block number, block hash, storage keys | The raw `eth_getProof` answer (jsonb, as the node sent it). Also the stored slot (the light client head whose `executionBlockHashes` entry the key opens), `fetched_at` and the source **host** (never a URL). |
| `light_client_proofs` | pair, direction, start slot, new slot, `keccak256(proof)` | The proof bytes and public values. Also the fields derived from the public values: roots, execution block hash and number. When known: the program key, the whole proof message (`payload`), the posting chain, transaction and block, the msgboard message hash, and the backend job id. A second distinct proof of the same slots is its own row. |
| `message_evidence` | message id, `sha256(body)` | The evidence JSON exactly as the backend stored it (text, so the hash holds), with pair, direction and the backend's `stored_at`. |
| `handoff_updates` | chain id, period | The handoff update of one sync-committee period of a source chain, as the JSON text the backend stored (`record`, text, so the bytes and the hash hold). Also `sha256` of that text, `attested_slot` and `finalized_slot` (read from it), the backend's `stored_at`, the source and `ingested_at`. Schema version 2. |
| `conflicts` | id (one row per distinct incoming value) | Table, key, column, the archived value and the refused value, and the source. |
| `schema_version` | version | Migrations applied. |

The handoff updates are about 60 KB a record, one per period per chain: about 2 a day on testnet, about 45 MB a year in
total.

**Left out of the backend tables:**

- `jobs`, `requests`, `warmup_*`, `job_timings`: bookkeeping that can be rebuilt, and some of it names callers.
- `archive_entries`: the backend's work list.
- The backend file itself is in the mirror as a nightly snapshot (30 days). Import restores the newest on a fresh server.

### How rows get in

1. **Storage proofs, near the tip** (`archiver.ts`). It runs inside the indexer process, beside Ponder's indexing.
   - For each side of the pair it runs the runner's prefetcher (`proof-prefetch.ts`) over a store that writes into the
     archive. At each epoch-boundary block it fetches the answer an opening proof would need: the light client on that
     side, with the key of the head it holds in that block.
   - It works within 16 blocks of the tip. It never looks further back: an older block is skipped, not retried, and
     never holds back indexing.
   - Unlike the runner, it keeps going after a bridge opens, at one call per epoch per chain.
2. **Posted light client proofs, from calldata** (`calldata.ts`). The `HeadUpdated` handler decodes the transaction's
   `update(proof, publicValues)`, either direct or inside a Multicall3 batch. It picks the call whose public values give
   the event's slot and root.
   - Ponder runs handlers again in a new schema or after a reorganisation. The upsert makes that harmless.
   - A failure is logged and never fails the handler.
3. **Held proofs and evidence, from the backend** (`backend-rows.ts`):
   - Live: every 5 minutes the indexer reads the backend's private route `GET /archive/proofs`. It is on the loopback
     port only and no Caddy host passes it on. It is set by `PROOF_ARCHIVE_BACKEND_URL` in `indexer.env`.
   - Nightly: the export ingests the backend snapshot and the runner's proof cache.
4. **Handoff updates, from the backend** (`backend-rows.ts`). The same two ways in.
   - Live: `GET /archive/proofs` has a field `handoffs: [{ chainId, period, record, storedAt }]` with the rows stored in
     the last 7 days. A backend without the field counts as none.
   - Nightly: `ingest-backend` reads the table `handoff_updates` of the snapshot (all rows). A snapshot without the
     table counts as none.
   - Each record is checked before it goes in: it parses; `format` is exactly `zkb-handoff-update/1`; `chainId` and
     `period` are integers equal to the row's; `attestedSlot` and `signatureSlot` are integers with
     `floor(slot / 8192) = period` (all four chains have 8192 slots per period); `finalizedSlot` is an integer not above
     `attestedSlot`; `nextSyncCommitteeRoot` is `0x` and 64 hex digits; `update` is an object with a
     `next_sync_committee` object. A record that fails is refused: it is logged (`proof_archive_handoff_refused`, with the
     chain, period and reason, never the text) and counted as `invalid`, like an invalid light client proof.
   - A different record for the same chain and period is a conflict (recorded in `conflicts`, the first stays).

### Read routes (indexer, public under `/api/*`)

- `GET /api/proofs/storage/:chainId/:address/:block` returns `{ entries: [...] }`, as proof cache entries without the
  fetch time. It answers 404 when there are none.
- `GET /api/proofs/light-client/:direction?startSlot=&limit=` returns the newest start slot first, at most 500.
- `GET /api/proofs/evidence/:messageId`
- `GET /api/proofs/handoffs/:chainId` returns `{ periods: [...] }`, the periods that have a handoff update, ascending.
- `GET /api/proofs/handoffs/:chainId/<period>.json` returns the record JSON exactly as stored (`application/json`). It
  answers 404 when there is none and 400 for a file name that is not `<period>.json`. A prover reads
  `<base>/<chainId>/<period>.json`, with base `.../api/proofs/handoffs` or `.../ipfs/<cid>/handoff-updates`: the layout
  is the same in both.
- `GET /api/proofs/summary` returns row counts (`storageProofs`, `lightClientProofs`, `evidence`, `handoffUpdates`,
  `conflicts`).

Every route answers 503 when the archive is off: no `DATABASE_URL`, `PROOF_ARCHIVE=off`, or the database cannot be
reached.

The routes show the same fields as the public IPFS tree, through the same projections in `public.ts`. No source host,
fetch time, backend job id, source or backend time leaves the indexer.

### The runner reads the archive first

- The runner's prefetcher and opener use `createArchivedProofCacheStore`, which reads in this order:
  1. The indexer archive (`runner.indexerUrl`). An entry is checked against what the runner asked for, never against
     what it says about itself (`archivedEntryRefusal`):
     - It must be for the requested chain, account, block number and block hash. The header is read by hash from the
       source chain and must carry that number.
     - It must name the head that the light client held in that block. The runner reads that head at the block while a
       node still can; otherwise it uses the entry's own slot.
     - It must prove the key of `executionBlockHashes[storedSlot]` (the rule of opening.rs) against the header's state
       root, and that key must hold a block hash that is not zero.

     A good entry is copied into the local cache, which is where the prover reads. A refused one is logged as
     `proof_archive_entry_refused` with the reason.
  2. The local cache.
  3. A node: the prefetcher fetches on a miss, and the prover asks when the file is missing.
- Before each opening proof, the opener fetches the entry for the block of the stored head
  (`storedHeadCacheKey` → `prepareOpening`). A failure there is logged as `deposits_opening_cache_failed`, and the
  prover goes on without it.

## The mirror: 30 days of everything

The owner, 2026-11-02, after seeing the sizes (proofs about 5 MB a day, beacon states about 150 MB a day at about
4.5 MB each and about 33 a day, and a nightly tarball of about 350 MB that held everything again each night):

> "ok, so lets plan to do 30 days of everything"

So the nightly tarball is gone. The server keeps one private **mirror** that grows by what is new each night, and every
copy elsewhere (the operator's Mac, later R2) copies only what it lacks.

### Layout

`/var/backups/zk-bridge/proofs/mirror` (`ZKB_PROOFS_MIRROR`). It is private: it keeps the whole records, with source
hosts, fetch times and backend job ids. The public tree on IPFS is built separately (below).

| Path | What | Kept |
|---|---|---|
| `storage-proofs/<chain>/<account>/<block>-<block hash>.<sha256>.json` | one storage proof record | for good |
| `light-client-proofs/<pair>/<direction>/<start>-<new>-<proof hash>.<sha256>.json` | one light client proof record | for good |
| `evidence/<pair>/<direction>/<message id>-<body sha256>.<sha256>.json` | one evidence record | for good |
| `handoff-updates/<chain id>/<period>.<sha256>.json` | one handoff update record (the archive row; its `record` field is the update text) | for good |
| `conflicts/conflict.<sha256>.json` | one conflict the archive recorded | for good |
| `beacon-states/<chain>/<slot>-<root>.ssz` and `.summary` | the verified beacon states of the runner and the backend | 30 days |
| `snapshots/<stamp>.sqlite` | the backend's database, one each night | 30 days |
| `manifests/<stamp>.json` | sha256 and size of every other file present, one each night | 30 days |

- **Content-named, written once.** The path is the public tree's layout plus `<sha256>`, the hash of the file itself
  (canonical JSON, sorted keys). A record that a later source fills in (a light client proof that gets its posting
  transaction) is a new file next to the old one; the import merges them by the archive's fill rule, and the public
  tree merges them too. Nothing in the mirror is ever rewritten. A name that comes again with other content (a beacon
  state, a snapshot, a damaged record) is a **conflict**: the file is left as it is, the run logs `ERROR`, finishes
  everything else (manifest, hook, publication) and then exits 1.
- **Owners and modes.** The mirror belongs to `zkb_indexer`, the archive CLI's user, which writes and prunes there. The
  top directory is 0750 (root and the archive user only), the directories in it 0755, every file 0644. Root only
  creates and hands over the top directory (in its own 0711 parent; a top directory that is a link is refused). The
  modes inside are set by the archive user on what it owns, with `find -P` (links are never followed); entries of
  another owner and links are reported and left alone.
- **Root trusts nothing in the mirror.** The archive user can write it, so root never reads, chmods or chowns a path
  inside it: the archive user streams a tar when root needs a copy (import, `bundle`, the public tree), and root checks
  that copy (a directory only root can write) for links, special files and hard links.
- **The trust anchor covers what root itself saw.** `/var/backups/zk-bridge/proofs/manifests.sha256` (root:root 0644, in
  the root-owned 0711 backup directory, appended to only) holds `<sha256>  <path>` lines, each from bytes root holds:
  - `<stamp>.json`: the day's manifest. The CLI prints the manifest's bytes to root (`mirror-manifest --print`), root
    keeps them in `/var/backups/zk-bridge/proofs/trusted-manifests/<stamp>.json` (root 0644, pruned with the window) and
    hashes that copy; the mirror's copy must be the same bytes.
  - `snapshots/<stamp>.sqlite`: the backend's user hands the snapshot's bytes to root, which writes them into its own
    staging directory and hashes them there, before the archive and the mirror take that copy.
  - `beacon-states/<chain>/<name>`: each service's user streams its states to root, which unpacks them into its own
    staging directory (no links, plain modes) and hashes each one there, once per name and content.

  Records (proofs, evidence) get no line: storage proofs are checked against block state roots, and light client proofs
  are data that their consumers verify. Import installs only a snapshot and beacon states whose hashes are listed, and
  import and verify accept only a manifest that equals root's copy and is listed. The Mac pull fetches
  `trusted-manifests/` and the list, and prefers root's copy.
- **One rule for manifest names.** The script and the CLI both take `YYYYMMDDTHHMMSSZ.json`; a `manifests/` directory
  holding any other name is refused, and the script names the manifest it picked to the CLI (`mirror-check --manifest
  <name>`), so both read the same file.
- **What the services hold is copied, never moved.** The runner's proof cache and both services' beacon states are
  copied by their own users into a staging directory with `install -m 0644` or `cat` (never `cp`, which would keep the
  services' 0600 and leave the copies unreadable to the archive user). The SQLite snapshot is taken by the backend's user
  and switched to `journal_mode=DELETE`, so the archive user opens it read only.
- **Window.** `ZKB_PROOFS_RETENTION_DAYS` (default 30). A beacon state's age is its slot's time: the genesis time read
  from the state itself (an SSZ `BeaconState` starts with `genesis_time`, then `genesis_validators_root`, then `slot`,
  which must equal the slot in the name) plus the slot times the chain's slot length (12 s on Ethereum and Sepolia, 10 s
  on PulseChain and its testnet). Never the file time. A state whose time cannot be read is kept and logged. Snapshots
  and manifests count from the stamp in their names. Records are never deleted.
- **Before the services prune.** The services keep each state for 3 days (and their newest 16), and the export runs
  every night, so every state reaches the mirror long before. After each run every state the services hold must be in
  the mirror, unless the window dropped it; one that is not is a `WARNING` that names it.

### Commands

`deploy/app-server/proofs.sh` runs as root on the server. It calls the archive CLI
`explorer/indexer/bin/zk-bridge-proof-archive.mjs` as `zkb_indexer`, with the indexer's environment (through
`systemd-run`, so the script never reads the env files).

```sh
proofs.sh export                      # update the mirror (the nightly timer runs this)
proofs.sh verify [<mirror dir>]       # the newest manifest must match exactly, then every storage proof against the chain
proofs.sh import [<mirror dir> | <bundle.tar.gz>]   # default: this server's own mirror; conflicts are reported, exit 3
proofs.sh bundle                      # zk-bridge-mirror-<stamp>.tar.gz of the whole mirror, for a one-off copy
proofs.sh publish [--dry-run]         # the public tree to IPFS (below)
```

**Export**, each night at about 03:30 UTC (`zk-bridge-proofs-export.timer`, installed by `provision.sh`):

1. The backend's SQLite snapshot, the runner's proof cache and both services' beacon states go to a staging directory
   (above).
2. The cache and the snapshot's proofs go into the archive (`ingest-cache`, `ingest-backend`; conflicts there are
   recorded in the archive and are a warning).
3. `mirror-write`: every archive row becomes a record file, unless it is there already.
4. `mirror-add`: the beacon states of both services, then the snapshot.
5. `mirror-prune`: the window, and the check that every state the services hold is in the mirror.
6. `mirror-manifest`: `manifests/<stamp>.json`, with the commit, the host, the window and the newest IPFS publication.
7. The off-site hook, then the publication when it is on.

The output ends with `mirror: <dir>` and `manifest: <file>`. Old nightly tarballs (`zk-bridge-proofs-*.tar.gz`) in
`/var/backups/zk-bridge/proofs` are left alone and logged; nothing makes new ones. Delete them by hand once the mirror
has been pulled.

**Verify** checks that the newest manifest equals root's copy and is in `manifests.sha256`, then the mirror against that
manifest
exactly (every listed file with its hash, no file unlisted,
every record file's content equal to the hash in its name), warns when that manifest is not today's, then reads each
storage proof's block header by its hash from `EXPLORER_RPC_URL_<chainId>` (headers stay on every node) and checks the
account proof against `stateRoot` and each storage proof against the account's `storageHash` (EIP-1186 Merkle Patricia
proofs). A record must also prove the key of the head it names (`executionBlockHashes[storedSlot]`). Each proof ends up
as verified, invalid (exit 3), or unchecked (no endpoint, or the node does not have the block, which is the case for an
orphaned block).

**Import** works into a fresh server:

1. The input (a directory, by default this server's mirror read by the archive user, or an unpacked tar.gz) is copied
   into a directory only root can write. A link, a special file or a hard link stops it. Its newest manifest (by the
   name rule above) must equal root's copy and be in `manifests.sha256`. For a mirror from another server pass
   `--trust-list <file>` (that server's `manifests.sha256`; the Mac keeps one in `~/zkb-backups/proofs/`), or
   `--manifest-sha256 <hex>` and `--snapshot-sha256 <hex>` by hand (beacon states are then left out, as nothing vouches
   for them). The copy must match that manifest exactly: a missing, changed or unlisted file stops the import. The
   snapshot to install must have a listed hash (or match `--snapshot-sha256`), else nothing is imported.
2. It migrates the schema and upserts every record file. A light client record whose slots or hash do not match its proof
   is refused as invalid, and so is evidence whose hash does not match its body. Versions of one record merge by the fill
   rule; two different non-null values are a conflict.
3. The newest snapshot is ingested, and installed as the backend's database only when the server has none.
4. Each service gets the 16 newest beacon states of each chain whose hashes root recorded (any other is named in a
   WARNING and left out) (its own cache keeps 16), copied by its own user, only when
   missing. A file that exists with other content is reported and never overwritten.

A tar.gz is unpacked first (its `.sha256` checked when it sits next to it): a mirror bundle (`proofs.sh bundle`) is
imported as above, and a nightly bundle of the old format (`archive/*.ndjson`) is still imported and verified the old
way.

From the operator machine (venv of `docs/deploy-blue-green.md`):

```sh
cd deploy/ansible
ansible-playbook proofs.yml -e action=export      # export now, then pull the mirror to ~/zkb-backups/proofs/mirror
ansible-playbook proofs.yml -e action=import      # restore the archive from the server's own mirror
ansible-playbook proofs.yml -e action=import -e mirror=~/zkb-backups/proofs/mirror [-e trust_list=<that server's list>]
                                                  # copied up into <backup dir>/incoming-mirror (root's), then imported
ansible-playbook proofs.yml -e action=import -e bundle=<local zk-bridge-proofs-*.tar.gz or zk-bridge-mirror-*.tar.gz>
ansible-playbook proofs.yml -e action=verify
ansible-playbook proofs.yml -e action=publish -e dry_run=true
```

### Copies off the server

**The owner's Mac (first off-site copy):** `deploy/operator/install-proofs-pull.sh` installs a launchd agent that runs
`deploy/operator/pull-proofs.sh` every day at 04:45 UTC, in the local time zone. Over the `zkbfi-app` ssh alias it
copies the mirror into `~/zkb-backups/proofs/mirror`:

- `storage-proofs/`, `light-client-proofs/`, `evidence/`, `handoff-updates/`, `conflicts/`: rsync `--ignore-existing`. A file that is here is
  never fetched again, and nothing here is deleted, even when the server no longer has it; such records are logged.
- `beacon-states/`, `snapshots/`, `manifests/`: rsync `--ignore-existing --delete`, so the Mac follows the server's
  window; the deletions are counted in the log.
- Each rsync holds a shared `flock` on the server's lock file, so it waits for a running export (and an export waits for
  it, up to an hour). rsync puts a file in place only when it is complete.
- Then the newest manifest is checked: its name must follow the rule, it must equal the server's own copy (fetched from
  `trusted-manifests/` to `~/zkb-backups/proofs/trusted-manifests/`, and the file list is read from that copy), its
  sha256 must be in the server's `manifests.sha256` (fetched to `~/zkb-backups/proofs/manifests.sha256`), and every
  file it lists must be here with its sha256. A missing file (the pull met an export)
  gets one more pull; a file that differs fails the run and is left for a person to look at.
- The mirror directories are 0700. The log is `~/zkb-backups/proofs/pull.log`. `ZKB_PULL_HOOK` runs after a good pull
  with `<mirror dir> <newest manifest>`.
- The tarballs earlier versions pulled (`~/zkb-backups/proofs/zk-bridge-proofs-*.tar.gz`) stay where they are; nothing
  deletes them or makes new ones. They hold the beacon states from before the mirror; import one with
  `proofs.yml -e action=import -e bundle=<file>` if a state from then is ever needed.
- `--render` previews the agent and `--uninstall` removes it (the mirror stays).

**Off-site hook (for Cloudflare R2 later):** after the manifest, `proofs.sh export` runs `ZKB_PROOFS_OFFSITE_HOOK`, or
every executable in `/etc/zk-bridge/proofs/offsite.d/`, with `<mirror dir> <manifest of the day>`. Hooks run as root
and must read the mirror as `zkb_indexer` (`runuser -u zkb_indexer -- ...`), never as root, and check the manifest's
sha256 against `manifests.sha256`. Files are never
rewritten, so an uploader copies the names the remote side lacks (and may drop the pruned ones the manifest no longer
lists). Without a hook it does nothing. A failing hook makes the run exit non-zero after the mirror is complete.

### Sizes

Measured on testnet (Sepolia and PulseChain testnet v4), 2026-11-02: beacon states about 4.5 MB each and about 33 a day
(about 150 MB a day); proofs and evidence about 5 MB a day.

| | 1 day | 30 days (the window) | a year |
|---|---|---|---|
| Beacon states, testnet | about 150 MB | about 4.5 GB (then flat) | about 4.5 GB |
| Proofs and evidence, testnet | about 5 MB | about 150 MB | about 1.8 GB (never deleted) |
| SQLite snapshots | one `backend.sqlite` | 30 of them | 30 of them |
| Handoff updates, testnet | about 120 KB (2 records of about 60 KB) | about 3.6 MB | about 45 MB (never deleted; one record per period per chain, about 2 a day on testnet) |
| Manifests | a few MB (one line per file) | 30 of them | 30 of them |
| **Mirror, testnet** | | **about 4.7 GB** plus 30 snapshots | about 6.5 GB |
| **Mirror, mainnet** (about double) | | **about 9.5 GB** | about 13 GB |

- **Server:** the mirror plus the IPFS copy of the public tree. The two pinned publications share every block but one
  day's, so the node holds about one window: about 4.7 GB on testnet, so about **9.5 GB on the server** (about 19 GB with
  mainnet). The app server has an 80 GB disk; the node's `Datastore.StorageMax` is 20 GB.
- **The Mac:** the same as the mirror, about 4.7 GB on testnet. The first pull copies the whole window; later pulls copy
  about one day (about 155 MB).
- The nightly tarball (about 350 MB, everything again each night) is no longer made.

## Public bundle on IPFS

This is a separate tree, not the mirror. It holds only an allowlist of chain data (`public.ts`): every proof and piece
of evidence of the archive, and the beacon states of the mirror's window (30 days).

- `storage-proofs/<chain>/<account>/<block>-<hash>.json`
- `light-client-proofs/<pair>/<direction>/<start>-<new>-<proofHash>.json`
- `evidence/<pair>/<direction>/<messageId>-<sha256>.json`: the bytes as built.
- `handoff-updates/<chain id>/<period>.json`: exactly the record text (compact JSON, sorted keys). It holds only hex,
  numbers and fixed key names. The sanitizer checks that it is a valid handoff update for the chain and period in its
  path and scans everything but the fixed `format` tag.
- `beacon-states/<chain>/<slot>-<root>.ssz|.summary`
- `README.txt`, which says how to check each kind. For the handoff updates it says what they are and that a prover reads
  them at `<tree>/handoff-updates/<chain id>/<period>.json`; the proof verifies the committee signatures, so nobody has
  to trust the file.
- `manifest.json`, without the host name.

What is left out: no source host, no fetch time, no job id, no source, and nothing from jobs, requests or timings.

The files are canonical JSON with sorted keys, so unchanged content gives the same bytes and the same file CIDs. The
root CID changes with the manifest (its time and commit).

The sanitizer (`public-check`) fails the publish in these cases:

- Any file sits outside the allowlisted layout.
- Any text holds a field named like a host, URL, caller or key.
- Any text looks like a URL, an IPv4 or IPv6 address, an email address, a known key prefix, or a long mixed
  letter-and-digit word that is not 0x hex.

It reports the file and the reason, never the value. SSZ states are binary chain data and are not scanned.

`proofs.sh publish` works like this:

1. The archive user builds the tree: the records from the archive, the beacon states from the mirror (only plain files
   with the exact names, never a link; the mirror holds the window that the nightly export has just pruned), then the
   manifest. Root takes it as a tar stream into a directory only root can write, refuses links, special files and hard
   links there, and runs the sanitizer on that copy, which is what gets added. The sanitizer skips `.ssz` files, so a
   key could only reach the tree through a link; that path is closed by construction.
2. It adds the tree to the server's kubo node through the HTTP RPC API with curl: `POST
   /api/v0/add?cid-version=1&pin=true&pin-name=zkb-proofs-<stamp>`, one multipart part per directory and file, the way
   kubo's own client sends a tree. The API secret never goes on a command line. The node's user reads `AuthSecret` from
   the node's config, turns it into the header the way kubo does (`bearer:<t>` becomes `Bearer <t>`), and pipes it into
   `curl -H @-`. Pins are listed and removed through `/api/v0/pin/ls` and `/api/v0/pin/rm` the same way.
3. It appends `<time> <cid> <files> <commit>` to `/var/backups/zk-bridge/proofs/ipfs-cids.log`.
4. It keeps the newest 2 publications pinned (`ZKB_PROOFS_IPFS_KEEP`) and unpins only older CIDs from that log. Each
   publication holds the whole window, so two are enough; the second covers a publication that went wrong.
5. After an unpin it runs a garbage collection of the node (`/api/v0/repo/gc`; `ZKB_PROOFS_IPFS_GC=0` turns it off). The
   daemon runs without `--enable-gc`, so without it the states that left the window would stay on disk. Only pinned
   content survives: the release archives and the kept publications.

**Expected repo size.** The two kept publications share every block but one day's (unchanged files give the same
bytes, so the same blocks), so the node holds about one window plus a day: about 4.7 GB on testnet, about 9.5 GB with
mainnet, under the node's `Datastore.StorageMax` of 20 GB. Seven publications (the old setting) would have cost little
more on disk for the same reason, but each holds the window, so two say the same.

The tree is then served at `gateway.zkb.fi/ipfs/<cid>`.

- **First publish:** it is manual. Run the dry run, then review the tree (`proofs.sh publish --dry-run` prints its
  path).
- **Nightly publish:** off by default. Set `ZKB_PROOFS_PUBLISH=1` in `/etc/zk-bridge/proofs/proofs.env`. The example is
  `deploy/app-server/config/proofs/proofs.env.example`.
- **Stable name:** `_dnslink.proofs.zkb.fi`. Only `ansible-playbook proofs.yml -e action=publish -e publish_dns=true -e
  confirm_production=yes` writes it. It goes through the same tasks that update `docs.zkb.fi` (`tasks/site_docs.yml`).
  Those tasks check that a public gateway serves the CID, and they print the old record (the rollback) first.

Dry run on a machine without Postgres, from the pulled mirror (versions of one record are merged, a storage proof
fetched twice is one entry):

```sh
cd explorer/indexer
node bin/zk-bridge-proof-archive.mjs public-export --mirror ~/zkb-backups/proofs/mirror --out /tmp/zkb-public/tree
node bin/zk-bridge-proof-archive.mjs manifest-write --dir /tmp/zkb-public/tree --commit "$(git rev-parse HEAD)" --public
node bin/zk-bridge-proof-archive.mjs public-check --dir /tmp/zkb-public/tree
```

(Beacon states are added only by `proofs.sh publish`.)

## Checking it on the server

None of this could run locally against the real Postgres, kubo or systemd. After a deploy:

1. `journalctl -u zk-bridge-indexer | grep proof_archive_ready`, then `curl -s 127.0.0.1:42069/api/proofs/summary`. The
   storage proof count should grow by about two every epoch (6.4 minutes on Sepolia).
2. `sudo -u zkb_indexer psql zkb_indexer -c '\dt proof_archive.*'`. The tables are there and outlive the next indexer
   release: compare the counts before and after a release that changes the indexer schema.
3. `curl -s 127.0.0.1:8787/archive/proofs | head -c 300` on the server answers. From outside, the same path on any
   public host is 404.
4. `proofs.sh export`, then `proofs.sh verify`: the mirror matches today's manifest, storage proofs come out verified,
   and only blocks that a node lacks come out unchecked. `ls -ld /var/backups/zk-bridge/proofs/mirror` is
   `drwxr-x--- zkb_indexer zkb_indexer`, and `find /var/backups/zk-bridge/proofs/mirror -type f ! -perm 0644` prints
   nothing.
5. `systemctl list-timers zk-bridge-proofs-export.timer`, and the next morning `journalctl -u zk-bridge-proofs-export
   --since -1d | grep -E 'WARNING|ERROR'` prints nothing.
6. `proofs.sh publish --dry-run`, then look through the printed tree before the first real publish.

## Limits

- Storage proofs start from when the archiver first runs. Proofs of older blocks are gone unless the runner's proof
  cache still has them; the first export takes those in.
- A light client proof posted through a contract other than the light client itself or Multicall3 is not found in
  calldata (logged as `proof_archive_no_update_call`). The backend route still brings the proofs this deployment made.
- The archive does not verify SP1 proofs itself. Their consumers do: the runner's verify guard and the contracts.
- `proof_archive` lives on the same Postgres and disk as the indexer. The mirror and its off-site copies are the backup.
- Beacon states older than the window are gone from the mirror and the public tree (the owner chose 30 days). The
  tarballs of the old format on the Mac still hold the states of their nights.
- A state that a service still holds but that is older than the window is copied in and dropped again each night, with
  no warning (the services' own cache keeps its 16 newest whatever their age).
- The beacon state clock reads the slot length from a table (`SECONDS_PER_SLOT` in `@zkb/data`); a chain missing from it
  counts 12 s slots.
