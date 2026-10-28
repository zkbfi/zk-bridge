# zk-bridge backend

The backend takes proof requests from dapp pages, runs one proving job per direction, and reports health.
Run it with `node bin/zk-bridge-backend.mjs --config backend.config.json [--modules requests,webhook,msgboard-indexer,archive]`.
See `backend.config.example.json` for every setting.

## Secrets

The configuration file holds the names of environment variables, never values.
The webhook bearer value must have at least 32 bytes. The backend refuses to start with a shorter one.

## Callers and limits

The backend faces the open internet. It counts each caller in a window of one minute.

- With `trustForwardedHeader` off, the caller is the socket address.
- With it on, the caller is the `X-Forwarded-For` entry `trustedProxyHops` places from the right. Your own proxies add those entries. The entries to the left can be forged by the client, so the backend ignores them. If the header has fewer entries, the backend uses the socket address.
- An IPv6 caller is counted by its first 64 bits, because one person holds a whole /64 network.
- A request with no socket address and no usable header has no known caller. All such requests share one bucket with a low limit (`requestsPerUnknownCallerPerMinute`, default 2).
- `globalRequestsPerMinute` (default 120) caps all callers together.
- `requestRetentionHours` (default 24) sets how long a request row stays in the database. The backend prunes at start and every hour.
- A request body over 4 KiB gets the answer 413.

## Msgboard indexer

The module `msgboard-indexer` reads the proof categories of the msgboard and keeps the latest valid proof of each direction. It needs `EXPLORER_MSGBOARD_URL`, the deployment file, and the RPC variables of the pair.
`GET /proofs/latest/:direction` answers:

- 200 with the proof. `headCheckedAt` is the time of the head read that the check used. That read is at most three seconds old. Read the head again before you post the proof, because the contract refuses a proof that does not start at its head.
- 404 when nothing usable is kept, or when the head moved past the start of the kept proof.
- 503 when the module cannot tell. The text says "the msgboard indexer is not running" or "the light client cannot be read". A 503 does not mean there is no proof. Try again later.

Set `EXPLORER_ACCEPT_ORACLE_PROOFS=true` only for local testing with the free test prover. The default accepts only full proofs.
The module checks at most 64 waiting messages and drops the rest with a log line. It never queues a payload longer than one proof message.
