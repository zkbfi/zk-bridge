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
  - `verify-storage` checks the storage proofs in a bundle.

### Tables

| Table | Key | Holds |
|---|---|---|
| `storage_proofs` | chain id, address, block number, block hash, storage keys | The raw `eth_getProof` answer (jsonb, as the node sent it). Also the stored slot (the light client head whose `executionBlockHashes` entry the key opens), `fetched_at` and the source **host** (never a URL). |
| `light_client_proofs` | pair, direction, start slot, new slot, `keccak256(proof)` | The proof bytes and public values. Also the fields derived from the public values: roots, execution block hash and number. When known: the program key, the whole proof message (`payload`), the posting chain, transaction and block, the msgboard message hash, and the backend job id. A second distinct proof of the same slots is its own row. |
| `message_evidence` | message id, `sha256(body)` | The evidence JSON exactly as the backend stored it (text, so the hash holds), with pair, direction and the backend's `stored_at`. |
| `conflicts` | id (one row per distinct incoming value) | Table, key, column, the archived value and the refused value, and the source. |
| `schema_version` | version | Migrations applied. |

**Left out of the backend tables:**

- `jobs`, `requests`, `warmup_*`, `job_timings`: bookkeeping that can be rebuilt, and some of it names callers.
- `archive_entries`: the backend's work list.
- The backend file itself is still in every bundle as a consistent snapshot. Import restores it on a fresh server.

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

### Read routes (indexer, public under `/api/*`)

- `GET /api/proofs/storage/:chainId/:address/:block` returns `{ entries: [...] }`, as proof cache entries without the
  fetch time. It answers 404 when there are none.
- `GET /api/proofs/light-client/:direction?startSlot=&limit=` returns the newest start slot first, at most 500.
- `GET /api/proofs/evidence/:messageId`
- `GET /api/proofs/summary` returns row counts.

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

## Export, import, verify

`deploy/app-server/proofs.sh` runs as root on the server. It calls the archive CLI
`explorer/indexer/bin/zk-bridge-proof-archive.mjs` as `zkb_indexer`, with the indexer's environment (through
`systemd-run`, so the script never reads the env files).

```sh
proofs.sh export                       # one bundle into /var/backups/zk-bridge/proofs
proofs.sh import <bundle.tar.gz>       # idempotent; conflicts are reported, exit 3
proofs.sh verify [<bundle.tar.gz>]     # checksums, then each storage proof against its block's state root
proofs.sh publish [--dry-run]          # the public tree to IPFS (below)
```

From the operator machine (venv of `docs/deploy-blue-green.md`):

```sh
cd deploy/ansible
ansible-playbook proofs.yml -e action=export                 # also fetches the bundle to ~/zkb-backups/
ansible-playbook proofs.yml -e action=import -e bundle=~/zkb-backups/zk-bridge-proofs-<stamp>.tar.gz
ansible-playbook proofs.yml -e action=verify
ansible-playbook proofs.yml -e action=publish -e dry_run=true
```

**A bundle** is `zk-bridge-proofs-<UTC stamp>.tar.gz`, with a `.sha256` file next to it. Inside:

- `archive/{storage_proofs,light_client_proofs,message_evidence,conflicts}.ndjson`: one JSON record per line.
- `backend/backend.sqlite`: a consistent snapshot, taken as the backend user.
- `files/runner/proof-cache/`, `files/runner/beacon-states/`, `files/backend/beacon-states/`.
- `manifest.json`: format version, time, commit, host, files and records per folder, SHA-256 and size of every file, and
  the newest IPFS publication.

**Import** works into a fresh server:

1. It checks the `.sha256` and the manifest, and stops on any mismatch.
2. It migrates the schema and upserts the NDJSON. A light client record whose slots or hash do not match its proof is
   refused as invalid, and so is evidence whose hash does not match its body.
3. It ingests the backend snapshot.
4. It copies each file that is missing, as the owning service user. Identical files are skipped. A file that exists
   with other content is reported and never overwritten.
5. It installs the SQLite snapshot only when the server has no backend database yet.

**Verify** reads each block's header by its hash from `EXPLORER_RPC_URL_<chainId>`. Headers stay on every node. It
checks the account proof against `stateRoot` and each storage proof against the account's `storageHash` (EIP-1186
Merkle Patricia proofs). A record must also prove the key of the head it names (`executionBlockHashes[storedSlot]`). Each proof ends up as
verified, invalid (exit 3), or unchecked (no endpoint, or the node does
not have the block, which is the case for an orphaned block).

**Nightly:** `zk-bridge-proofs-export.timer` runs daily around 03:30 UTC, keeps the newest 14 bundles
(`ZKB_PROOFS_KEEP`), and is installed by `provision.sh`. The bundles sit on the server's own disk, so they are not
off-site until one of the next two steps copies them away.

**The owner's Mac (first off-site copy):** `deploy/operator/install-proofs-pull.sh` installs a launchd agent.

- Every day it pulls the newest bundle over the `zkbfi-app` ssh alias into `~/zkb-backups/proofs/`.
- It checks the `.sha256` and every manifest entry, deletes a bundle that fails, keeps the newest 30, and logs to
  `~/zkb-backups/proofs/pull.log`.
- `--render` previews the agent and `--uninstall` removes it.

**Off-site hook (for Cloudflare R2 later):** after the bundle and retention are done, `proofs.sh export` runs
`ZKB_PROOFS_OFFSITE_HOOK`, or every executable in `/etc/zk-bridge/proofs/offsite.d/`, with `<bundle> <sha256 file>`.
Without one it does nothing. A failing hook makes the run exit non-zero after the local bundle exists. An R2
(S3-compatible) uploader is a script dropped there; the export does not change. On the Mac, `ZKB_PULL_HOOK` does the
same after a pull.

## Public bundle on IPFS

This is a separate tree, not the backup. It holds only an allowlist of chain data (`public.ts`):

- `storage-proofs/<chain>/<account>/<block>-<hash>.json`
- `light-client-proofs/<pair>/<direction>/<start>-<new>-<proofHash>.json`
- `evidence/<pair>/<direction>/<messageId>-<sha256>.json`: the bytes as built.
- `beacon-states/<chain>/<slot>-<root>.ssz|.summary`
- `README.txt`, which says how to check each kind.
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

1. It builds the tree.
2. It adds the tree to the server's kubo node through the HTTP RPC API with curl: `POST
   /api/v0/add?cid-version=1&pin=true&pin-name=zkb-proofs-<stamp>`, one multipart part per directory and file, the way
   kubo's own client sends a tree. The API secret never goes on a command line. The node's user reads `AuthSecret` from
   the node's config, turns it into the header the way kubo does (`bearer:<t>` becomes `Bearer <t>`), and pipes it into
   `curl -H @-`. Pins are listed and removed through `/api/v0/pin/ls` and `/api/v0/pin/rm` the same way.
3. It appends `<time> <cid> <files> <commit>` to `/var/backups/zk-bridge/proofs/ipfs-cids.log`.
4. It keeps the newest 7 publications pinned (`ZKB_PROOFS_IPFS_KEEP`) and unpins only older CIDs from that log.

The tree is then served at `gateway.zkb.fi/ipfs/<cid>`.

- **First publish:** it is manual. Run the dry run, then review the tree (`proofs.sh publish --dry-run` prints its
  path).
- **Nightly publish:** off by default. Set `ZKB_PROOFS_PUBLISH=1` in `/etc/zk-bridge/proofs/proofs.env`. The example is
  `deploy/app-server/config/proofs/proofs.env.example`.
- **Stable name:** `_dnslink.proofs.zkb.fi`. Only `ansible-playbook proofs.yml -e action=publish -e publish_dns=true -e
  confirm_production=yes` writes it. It goes through the same tasks that update `docs.zkb.fi` (`tasks/site_docs.yml`).
  Those tasks check that a public gateway serves the CID, and they print the old record (the rollback) first.

Dry run on a machine without Postgres, from a pulled bundle:

```sh
mkdir -p /tmp/zkb-public && tar -xzf ~/zkb-backups/proofs/zk-bridge-proofs-<stamp>.tar.gz -C /tmp/zkb-public
cd explorer/indexer
node bin/zk-bridge-proof-archive.mjs public-export --in /tmp/zkb-public/zk-bridge-proofs-<stamp> --out /tmp/zkb-public/tree
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
4. `proofs.sh export`, then `proofs.sh verify`: storage proofs come out verified, and only blocks that a node lacks come
   out unchecked.
5. `systemctl list-timers zk-bridge-proofs-export.timer`.
6. `proofs.sh publish --dry-run`, then look through the printed tree before the first real publish.

## Limits

- Storage proofs start from when the archiver first runs. Proofs of older blocks are gone unless the runner's proof
  cache still has them; the first export takes those in.
- A light client proof posted through a contract other than the light client itself or Multicall3 is not found in
  calldata (logged as `proof_archive_no_update_call`). The backend route still brings the proofs this deployment made.
- The archive does not verify SP1 proofs itself. Their consumers do: the runner's verify guard and the contracts.
- `proof_archive` lives on the same Postgres and disk as the indexer. The bundles and their off-site copies are the
  backup.
