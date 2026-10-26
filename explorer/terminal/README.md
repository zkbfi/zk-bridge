# Explorer terminal dashboard

An OpenTUI (React reconciler) dashboard for the bridge. It runs on Bun. Design: `docs/explorer.md`.

## Run

```
cd explorer/terminal
bun install --frozen-lockfile
EXPLORER_DATA=fixture bun run src/main.tsx      # sample data, no network, nothing reaches a chain
bun run src/main.tsx                            # reads the indexer and the chains
bun test                                        # tests
bunx tsc --noEmit                               # type check
```

Keys: `1` to `4` views, `Tab` area, arrows move, `Enter` opens, `?` help, `q` quit. `5` opens the Prover setup view,
which is deliberately the last option everywhere.

## Environment variables

| Variable | Use |
|---|---|
| `EXPLORER_DATA=fixture` | Built-in sample data and simulated sends. |
| `EXPLORER_INDEXER_URL` | Indexer API. Default `http://localhost:42069`. |
| `EXPLORER_PAIR`, `EXPLORER_DEPLOYMENT_FILE` | Pair (default `eth-pls`) and the deployment JSON that `docker/deploy.sh` writes. |
| `EXPLORER_RPC_URL_<chainId>` | RPC URL of each chain. Keyed URLs: keep them out of files. |
| `EXPLORER_PRIVATE_KEY`, `EXPLORER_PRIVATE_KEY_FILE` | Signer at startup. The variable is removed from the environment when read. The file must be mode 0600. |
| `EXPLORER_KEYSTORE_FILE` | Prefills the keystore dialog. The password is always prompted. |
| `EXPLORER_MNEMONIC`, `EXPLORER_MNEMONIC_PASSPHRASE` | Used when the mnemonic field is left empty. Removed from the environment when read. |
| `EXPLORER_TREZOR_CONTACT` | Required by Trezor Connect for its manifest. |
| `EXPLORER_HANDOFF_FILE`, `EXPLORER_EVIDENCE_FILE` | Prefill the operator dialogs. |
| `EXPLORER_CONFIG_DIR` | Where the Prover setup file lives. |

## Layout of the code

- `src/tx`, `src/signing`, `src/flow`, `src/format`, `src/model`, `src/config`: no terminal library inside. The web
  interface can reuse them. The setup schema, the secret store, the setup file and the redactor moved to
  `explorer/shared/src/config` (import `@zk-bridge/shared/config`), because the bots read the same file. `src/config`
  keeps the pair mirror and the connection tests. The bots import `src/signing` by path.
- `src/ui`, `src/app`: the OpenTUI views.

## Joining the workspace

`explorer/pnpm-workspace.yaml` already lists `terminal`. This package keeps its own `bun.lock` and imports only
`@zk-bridge/shared/config` from the workspace, through the `paths` entry of its `tsconfig.json` (Bun and `tsc` both read
it), so `bun install --frozen-lockfile` still works. Besides that, it mirrors the pair loader (`src/config/pairs.ts`) and keeps small ABI fragments
(`src/tx/abis.ts`) that tests check against the shared ABIs and the Foundry output.
