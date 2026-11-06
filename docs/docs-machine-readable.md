# The docs for assistants and tools

The docs are Markdown pages that the dapp renders at `#/docs/<slug>`. A crawler or an assistant that fetches the dapp sees an empty shell, because the pages only exist after the script runs at a hash route. So every dapp release also carries the same pages as plain files next to `index.html`, plus machine-readable facts. This page describes the files, the front matter that drives them and the checks that keep them true. The code is in `explorer/docs/machine/`.

## What a release carries

| File | What it is |
| --- | --- |
| `docs/<slug>.md` | The source of one public page, front matter included, placeholders resolved. An operator page keeps its folder, such as `docs/audit/known-issues.md`. |
| `docs/skills/<name>/SKILL.md` | One skill in the Anthropic Agent Skills format: front matter with `name` and `description` (the page's summary), then the instructions. |
| `llms.txt` | The llmstxt.org index: title, summary, then a section per audience that links every page with its one-line summary, then the skills and the data files. |
| `llms-full.txt` | Every page and skill in one file, each with its `Source:` path. |
| `data/chains.json` | Each chain: id, name, native coin, explorers, slot seconds and finality seconds. From `explorer/data/src/chain-metadata.ts` and `status.ts`. |
| `data/contracts.json` | For each chain of each deployed pair: bridge, light client, mediator, delivery router, token factory, gate, wrapped native, fork registry (when there is one), start block and the test tokens. From `deploy/deployments/*.json`. The traffic wallet and the minter are left out. |
| `data/openapi/indexer.json`, `data/openapi/backend.json` | OpenAPI 3.1 documents of the public routes. |

Every link in `llms.txt` is relative, and so is the "View as Markdown" link of the dapp, so the files load at the root of a domain and under an IPFS gateway path alike. The Vite plugin `machineDocsPlugin` (`machine/plugin.ts`) writes them during `pnpm --filter @zk-bridge/web build` and serves them in the dev server.

Only the pages the dapp shows are published: the help pages (`explorer/web/docs/pages`), the operator pages named in `explorer/docs/public-pages.json`, and the skills (`explorer/web/docs/skills`). Nothing else in `docs/` can reach the files, and `script/check-docs-public.sh` scans the skills folder like the pages.

## Front matter

Every page and skill starts with a block between two `---` lines. The syntax is a small subset of YAML (one `key: value` per line; values are quoted text, a whole number, a bare word or an inline list).

| Key | Required | Meaning |
| --- | --- | --- |
| `title` | yes | The name of the page. |
| `summary` | yes | One line, at most 220 characters. It is the row in `llms.txt` and the `description` of a skill, so it says what the page gives the reader. |
| `audience` | yes | One or more of `user`, `deliverer`, `operator`, `integrator`. The first one picks the section of `llms.txt`. |
| `chains` | yes | `all`, or a list of chain ids such as `[11155111, 943]`. |
| `verified_release` | yes | The release the page was last checked against, such as `0.1.0`. Update it when you re-check a page. |
| `kind` | skills | `skill` for a skill; leave it out for a page. |
| `name` | skills | Kebab-case. It must equal the skill's folder name (`skills/<name>/SKILL.md`, or `skills/<name>.md`). |

An unknown key, a missing key or a bad value fails the build and the CI check, with the file named. The schema and the validator are `machine/front-matter.ts`.

## Placeholders

A page may embed a fact instead of typing it: `{{contracts.<chainId>.<field>}}` (for example the bridge contract of Sepolia) and `{{chains.<chainId>.<field>}}` (for example the native coin). The path after the chain id follows the files, so a test token is `{{contracts.943.testTokens.tUSD.address}}`. The build resolves them in the dapp, in the Markdown files and in `llms-full.txt`. A placeholder that names nothing fails the build.

## Checks

`node explorer/docs/scripts/check-machine-docs.ts` (also `pnpm --filter @zk-bridge/docs check:machine`) runs in the web build before and after Vite. It checks:

- Every page and skill has valid front matter, and no two make the same address.
- Every placeholder resolves.
- Every `0x` address of 40 hex digits in the text of a page appears in `contracts.json`, or in `explorer/docs/machine/example-addresses.json` (the zero address, the canonical Multicall3). Write a placeholder instead of an address.
- Every link of `llms.txt` points at an emitted file.
- With `--dist <folder>` (the web build passes `dist`): the build holds every expected file with the same text and nothing else under `docs/` or `data/`, so a private page cannot slip in.

The OpenAPI documents are written by hand in `machine/openapi.ts`, because the route code binds to the Ponder runtime and cannot be loaded at build time. `explorer/docs/test/machine-openapi.test.ts` reads the route code of the indexer and the backend and fails when a route exists in the code and not in the document, or the other way round. A route that is not public goes into `BACKEND_INTERNAL_ROUTES` (today the authenticated proof webhook). When you add a route, add it to the document in the same change.
