# Deployment plan

**Status (2026-10-28):** plan, not yet built. The owner chose the hosting model. The sizes come from one measured
end-to-end run (see "Measurements"). The backend's own memory is not measured yet.

This page says where each part of the system runs at launch, how big each server is, and why. The release pipeline is in
`docs/release.md`. The guide to run the whole system yourself is Task 27 of the finishing plan.

## The hosting model

- The dapp and the docs live on IPFS only. No server of ours hosts them. A user loads a signed release from IPFS, and the
  dapp works when our servers are down: a user can still deliver a message from it.
- Normal hosting is only for backends and landing pages.
- The landing page is at the root of zkb.fi, on Cloudflare Pages. It checks the signed `version.json` and links to the
  IPFS copies of the dapp and the docs.
- The IPFS archives are pinned at Filebase. The release pipeline uploads the archive files (CAR) and checks that the
  content address (CID) that Filebase reports equals the one it computed itself.
- Graphics processor proving runs on RunPod, serverless. It costs money only while it proves.

## Servers

| Server | Runs | Size | Provider |
|---|---|---|---|
| App server | backend (modules `requests`, `webhook`, `msgboard-indexer`, `archive`), explorer indexer (Ponder), Postgres | 4 GB memory, 2 vCPU, 80 GB disk | DigitalOcean |
| Bot server | publisher bot, runner bot | 1 GB memory, 1 vCPU, 25 GB disk | DigitalOcean |
| Prover | the prover worker image | one graphics processor per job | RunPod serverless |
| Landing page | static page | none | Cloudflare Pages |
| Dapp and docs | static sites | none | IPFS, pinned at Filebase |

### App server

- The explorer indexer is the largest part. It used up to 817 MB on two test chains with a few dozen messages, and it
  grows with the history of the real chains.
- In the measured run the indexer kept its database inside its own process (PGlite). On the server it uses Postgres, so
  part of that memory moves into the Postgres process. Postgres also needs memory for its cache.
- The archive module starts the prover program (`zk-bridge-prover`) for short runs that build evidence. The program runs
  on the CPU of this server. Proofs do not.
- With managed Postgres (a separate database service), the app server can drop to 2 GB.
- Only the backend's port is public, behind a TLS proxy. Set `trustForwardedHeader` and `trustedProxyHops` to match that
  proxy. The indexer and Postgres listen on the private interface only.

### Bot server

- The publisher and the runner used about 230 MB together.
- The runner holds a hot wallet key that pays gas for deliveries. It runs on its own server so that a break-in to the
  public backend does not reach that key. The bot server needs no public port.
- Keep only a small balance in the runner's wallet, and top it up as needed.
- 512 MB would hold the measured 230 MB, but it leaves little room for the memory peaks of Node.js and the operating
  system. 1 GB is the safer size.

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
  address with a key in it still sits in the configuration file (mode 0600).

## Secrets

All secrets live in the 1Password vault `zkb.fi` and reach a server only as environment variables.

| Secret | Where it is used |
|---|---|
| RunPod key | app server (backend) |
| Webhook bearer token | app server (backend) and the RunPod worker |
| Runner wallet key | bot server only |
| Endpoint keys of the providers | app server and bot server |
| Filebase keys | the release machine only |
| Release signing key | the release machine only, read at the moment of use |
| SSH key `DigitalOcean (zkb.fi)` | the operator's machine, through the 1Password SSH agent |

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
- A Cloudflare API token with the scopes "Zone DNS Edit" and "Zone Read", for zkb.fi only, for DNS changes. The wrangler
  login cannot change DNS.
