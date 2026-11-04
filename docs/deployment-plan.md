# Deployment plan

**Status (2026-10-28):** plan, not yet built. The owner chose the hosting model. The sizes come from one measured
end-to-end run (see "Measurements"). The backend's own memory is not measured yet.

This page says where each part of the system runs at launch, how big each server is, and why. The release pipeline is in
`docs/release.md`. The guide to run the whole system yourself is Task 27 of the finishing plan. Provider choice: a cloud server, not a
dedicated one, because snapshots, quick rebuilds, a firewall and an API matter more than price at this size. A dedicated
server with NVMe disks becomes the better choice only when we run our own chain nodes.

## The hosting model

- The dapp and the docs live on IPFS only. No server of ours hosts them. A user loads a signed release from IPFS, and the
  dapp works when our servers are down: a user can still deliver a message from it.
- Normal hosting is only for backends and landing pages.
- The landing page is at the root of zkb.fi, on Cloudflare Pages. It checks the signed `version.json` and links to the
  IPFS copies of the dapp and the docs.
- The IPFS archives are pinned on our own IPFS node (kubo) on the app server. The release pipeline imports the archive
  files (CAR) through an SSH tunnel and checks that the content address (CID) the node reports equals the one it
  computed itself. The node's RPC API stays on 127.0.0.1; only its peer port (4001) is open.
- One node is one point of failure. A second, independent pin (Filebase, or another service) comes later, so the sites
  stay reachable while the app server is down. Anyone can also pin the same CIDs.
- Graphics processor proving runs on RunPod, serverless. It costs money only while it proves.

## Servers

| Server | Runs | Size | Provider |
|---|---|---|---|
| App server | backend (modules `requests`, `webhook`, `msgboard-indexer`, `archive`), explorer indexer (Ponder), Postgres, publisher bot, runner bot | Hetzner Cloud CAX21 (ARM64): 4 shared vCPU, 8 GB memory, 80 GB disk | Hetzner Cloud, in an account of zkb.fi only |
| Prover | the prover worker image | one graphics processor per job | RunPod serverless |
| Landing page | static page | none | Cloudflare Pages |
| Dapp and docs | static sites | none | IPFS, pinned on the app server's kubo node; a second pin later |

### App server

- Built 2026-10-29: `zkbfi-app`, CAX21 in Falkenstein (`fsn1`), Ubuntu 24.04, project `zkb-fi`. The CX33 (x86) was sold
  out in every EU location, so the server is ARM64. The prover binary that the archive module starts is the default
  build (no `sp1` features) and must be built for `aarch64-unknown-linux-gnu`. The `sp1` features run only in the
  RunPod worker image.
- Hetzner firewall `zkbfi-app`: inbound TCP 22, 80 and 443 and ICMP from anywhere; everything else is closed. SSH takes
  keys only (`PasswordAuthentication no`). The Hetzner key `zkbfi-operator` is the 1Password key `zkbfi-app SSH key`.
  The 1Password agent offers many keys, so connect with `IdentitiesOnly yes` and that key's public file, or sshd stops
  after too many failed keys.
- `deploy/app-server/provision.sh` prepares the server and can run again: Node.js 24, Rust 1.93.0 in `/opt/rust`, one
  system user per service (`zkb_backend`, `zkb_indexer`, `zkb_publisher`, `zkb_runner`), Postgres on the local socket only with peer login
  for the indexer, and Caddy as the TLS proxy. It installs no service of ours and no secret.
- `deploy/app-server/deploy.sh <git-ref>` deploys one commit, as root on the server (`ssh zkbfi-app 'bash -s' -- <ref> <
  deploy/app-server/deploy.sh`). It unpacks the commit into `/opt/zk-bridge/releases/<commit>`, runs `pnpm install`,
  builds the prover there (`--no-default-features`, into `bin/`), points `/opt/zk-bridge/current` at it, installs the
  four systemd units and restarts each service whose files exist. A service without its files is skipped. Each unit
  runs as its own user and may write only its directory in `/var/lib`.
- Configuration goes into `/etc/zk-bridge/<service>/`, mode 0640, owner root, group of the service user. Templates are in
  `deploy/app-server/config/`. Backend: `backend.json` and `backend.env`. Indexer: `indexer.env`. Publisher and runner,
  each in its own directory: `bots.json`, `prover-setup.json` and `bots.env`; the runner also `runner.env` with the
  wallet key. The
  deployment file of the pair is `/etc/zk-bridge/deployment.json`, mode 0644.
- A change to the indexer or the shared code gives the indexer a new Postgres schema, so it indexes again from the start.
  The old schema stays until someone drops it (`ponder prune`).
- Host names, one per function, each passing only its own routes (`deploy/app-server/Caddyfile`; the names come from
  `/etc/caddy/zkb.env`, see `caddy.env.example`): `prove.zkb.fi` (requests and latest proofs), `webhook.zkb.fi` (the
  prover's callback; the backend's `publicUrl`), `archive.zkb.fi` (evidence), `indexer.zkb.fi` (the indexer's `/api/*`
  and GraphQL; `/sql`, `/metrics` and `/status` stay private). DNS-only records, so Caddy holds the certificates.
  `ipfs.zkb.fi` names the IPFS node for peers and pinning services: port 4001, plus the secure WebSocket (no gateway on the apex). Its secure
  WebSocket address uses a `libp2p.direct` certificate that the node gets itself (AutoTLS), not a Caddy one.
- IPFS gateway forms (the node serves only its own pins, `Gateway.NoFetch`):
  - `https://gateway.zkb.fi/ipfs/<cid>` is path style and stays so, with no redirect: in-browser IPFS clients fetch raw
    blocks there over HTTPS (the node announces `/dns4/gateway.zkb.fi/tcp/443/tls/http`). All releases share one browser
    origin there.
  - `https://<cid>.ipfs.zkb.fi/` is the subdomain gateway: each release has its own browser origin, so the dapp and
    the docs do not share storage. kubo has a `Gateway.PublicGateways` entry for `zkb.fi` with `UseSubdomains`; Caddy's
    `*.ipfs.zkb.fi` site forwards with the original Host header. It needs a wildcard DNS record
    (`*.ipfs.zkb.fi`, A and AAAA, DNS only, like the other names). Certificates are issued on demand, one per CID, and
    only after the ask service (`deploy/app-server/ipfs-tls-ask`, `zk-bridge-ipfs-tls-ask.service`, user `zkb_tlsask`,
    127.0.0.1:8089) agrees: the host must be exactly a lowercase CIDv1 base32 label and the node must hold the CID.
    Answers are cached for ten minutes and lookups in kubo are limited to 20 per second. Let's Encrypt limits
    new certificates per registered domain (50 per week), which bounds how many releases can get a name.
  - `wss://ipfs.zkb.fi` (the apex) stays the secure WebSocket for browser peers.
- Every consumer takes these addresses from configuration: the dapp from `VITE_EXPLORER_*_URL` at build time and from its
  Connections view at run time, the prover worker from the `webhookUrl` that the backend sends with each job.
- The explorer indexer is the largest part. It used up to 817 MB on two test chains with a few dozen messages, and it
  grows with the history of the real chains.
- In the measured run the indexer kept its database inside its own process (PGlite). On the server it uses Postgres, so
  part of that memory moves into the Postgres process. Postgres also needs memory for its cache.
- The archive module starts the prover program (`zk-bridge-prover`) for short runs that build evidence. The program runs
  on the CPU of this server. Proofs do not.
- Only Caddy is public; the backend and the indexer listen on 127.0.0.1 behind it. Set `trustForwardedHeader` and `trustedProxyHops` to match that
  proxy. The indexer and Postgres listen on the private interface only.

### The bots on the same server

- The publisher and the runner used about 230 MB together. All services together peaked at about 905 MB, so 8 GB leaves
  room for the cache of Postgres.
- The runner holds a hot wallet key that pays gas for deliveries. The owner chose one server for launch (2026-10-28), so
  the key sits on the same machine as the public backend. To keep that risk small:
  - each service runs as its own system user, the publisher and the runner too, so only the runner's user can read the
    wallet key, in its file or in the runner's process environment;
  - the bots have no inbound port; only the TLS proxy in front of the backend is public;
  - the runner's wallet holds a small balance, topped up as needed, so a break-in loses little.
- Moving the bots to a small server of their own later needs no change to the code.

### Prover

- The backend sends proof jobs to the RunPod endpoint. The rate limits of the backend (`limits` in its configuration)
  cap how many jobs callers can start, and so cap the spend.
- The RunPod key lives only in the environment of the backend.

## Chain access

The backend, the indexer and the bots need an execution endpoint (RPC) and a beacon endpoint for Ethereum and for
PulseChain. At launch these come from providers, not from our own nodes. Own nodes need several terabytes of disk per
chain and constant care, so they are a later step.

Before launch, check that each provider:

- serves the old blocks, receipts and beacon state that evidence needs, back to the oldest message that the archive must
  still prove;
- has rate limits above the read rate of the indexer and the archive;
- keeps keys out of addresses where it can. The backend removes configured endpoint addresses from its logs, but an
  address with a key in it still sits in the configuration file (mode 0640, readable by the backend's user only).

## Secrets

All secrets live in the 1Password vault `zkb.fi` and reach a server only as environment variables.

| Secret | Where it is used |
|---|---|
| RunPod key | app server (backend) |
| Webhook bearer token | app server (backend) and the RunPod worker |
| Runner wallet key | app server, readable by the runner's user only |
| Endpoint keys of the providers | app server |
| Filebase keys, when the second pin is set up | the release machine only |
| Release signing key | the release machine only, read at the moment of use |
| Hetzner API token: item `hetzner`, field `api-token` (project `zkb-fi`, read and write) | the operator's machine, through `op run` |
| Cloudflare token for DNS: item `Cloudflare`, field `key` (DNS Edit and Zone Read, zone zkb.fi only; the wrangler login cannot change DNS) | the operator's machine, through `op run` |
| SSH key `zkbfi-app SSH key` | the operator's machine, through the 1Password SSH agent |

## Measurements

One end-to-end run on 2026-10-28, oracle proofs, two Anvil chains, about 12 minutes. Resident memory, sampled every 2
seconds:

| Process | Peak | Typical |
|---|---|---|
| Explorer indexer (Ponder with PGlite) | 817 MB | about 710 MB |
| Runner bot | 161 MB | 149 MB |
| Publisher bot | 73 MB | one sample |
| Backend | not measured yet | not measured yet |

The run tells nothing about growth over months of real chain history. After launch, watch the memory of the indexer and
the disk of Postgres.

## Open items

- Measure the backend's memory under message traffic.
- The backend refuses to start without `RUNPOD_API_KEY`, even when it proves nothing remotely. Make the prover backend a
  configuration setting (already a planned follow-up), so a server that only serves evidence holds no RunPod key.
- Pick the RPC and beacon providers, and check the points under "Chain access".
- Restore `.git/info/forbidden-patterns` on the release machine, or the docs build stops (the public-docs gate fails
  closed).
