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
