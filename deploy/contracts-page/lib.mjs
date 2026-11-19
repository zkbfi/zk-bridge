// The deployed contracts page: reads the deployment records in deploy/deployments, refreshes the verification status
// from the explorers, and renders the page explorer/web/docs/pages/10-deployed-contracts.md.
//
// A record is one pair, such as deploy/deployments/sepolia-pls943.json. Each chain section keeps the fields the
// explorer, the prover and the bots read (bridge, mediator, ...) and adds a `contracts` list with every contract live
// on that chain: name, address, role, source commit, deploy date and where it is verified.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_METADATA, explorerLinks } from "../../explorer/data/src/chain-metadata.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEPLOYMENTS = join(ROOT, "deploy/deployments");
export const PAGE_PATH = join(ROOT, "explorer/web/docs/pages/10-deployed-contracts.md");

/** The places a contract can be verified, in the order the page shows them. */
export const VERIFIERS = ["blockscout", "sourcify", "etherscan"];

/** The Blockscout API of each chain (the explorer page and its API sit on different hosts on PulseChain). */
export const BLOCKSCOUT_API = {
  11155111: "https://eth-sepolia.blockscout.com",
  943: "https://api.scan.v4.testnet.pulsechain.com",
};

/** Chains that Etherscan (API v2) serves. */
export const ETHERSCAN_CHAINS = new Set([1, 11155111]);

export const SOURCIFY_API = "https://sourcify.dev/server";
export const SOURCIFY_PAGE = "https://repo.sourcify.dev";
export const ETHERSCAN_API = "https://api.etherscan.io/v2/api";

const GROUP_TITLES = {
  live: "Contracts in use",
  tokens: "Test tokens",
  third_party: "Third-party contracts",
  retired: "Retired contracts",
};
const GROUP_INTROS = {
  live: "The bridge itself, the helper contracts it needs and the light clients. Nothing here has an owner, an upgrade path or a pause.",
  tokens: "Test tokens used on the testnet pair. Each chain holds the original of one token and the bridged copy of the other chain's token.",
  third_party: "Contracts that the bridge uses but that this project did not deploy.",
  retired: "Contracts that no longer take new traffic. The record still lists them, so transfers made through them stay readable.",
};

/** Reads every deployment record that has a `contracts` list, sorted by pair name. */
export function loadRecords(folder = DEPLOYMENTS) {
  return readdirSync(folder)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".test-tokens.json"))
    .sort()
    .map((file) => ({ pair: file.replace(/\.json$/, ""), file: join(folder, file), record: JSON.parse(readFileSync(join(folder, file), "utf8")) }))
    .filter(({ record }) => Object.values(record).some((section) => Array.isArray(section?.contracts)));
}

/** The chain sections of a record, in chain id order of appearance (chain_a, chain_b). */
export const sectionsOf = (record) => Object.entries(record).filter(([, section]) => typeof section?.chain_id === "number" && Array.isArray(section.contracts));

/** Writes a record the way the committed files are written: keys sorted, two spaces, a final newline. */
export function writeRecord(file, record) {
  const sortKeys = (value, depth) => {
    if (Array.isArray(value)) return value.map((item) => sortKeys(item, depth + 1));
    if (value !== null && typeof value === "object") {
      // Entries of a `contracts` list keep the order they were written in; everything else is sorted.
      return Object.fromEntries((depth === 3 ? Object.keys(value) : Object.keys(value).sort()).map((key) => [key, sortKeys(value[key], depth + 1)]));
    }
    return value;
  };
  writeFileSync(file, `${JSON.stringify(sortKeys(record, 0), null, 2)}\n`);
}

/** The links to the explorers of a chain for one address, one per explorer that verifies contracts. */
export function addressLinks(chainId, address, verified) {
  const explorers = CHAIN_METADATA[chainId]?.explorers ?? [];
  const links = explorerLinks(chainId, "address", address)
    .map((link, index) => ({ link, explorer: explorers[index] }))
    .filter(({ explorer }) => explorer?.software === "blockscout" || explorer?.software === "etherscan")
    .map(({ link, explorer }) => ({ kind: explorer.software, label: link.name.replace(/^Sepolia /, ""), url: link.url }));
  if (verified.sourcify !== "unsupported") links.push({ kind: "sourcify", label: "Sourcify", url: `${SOURCIFY_PAGE}/${chainId}/${address}` });
  return links;
}

const STATUS_WORDS = { true: "verified", false: "not verified", unsupported: "not supported", null: "not checked" };
const statusWord = (value) => STATUS_WORDS[String(value ?? null)] ?? "not checked";

/** One table row of a contract. */
function row(chainId, entry) {
  const links = VERIFIERS.map((kind) => {
    const link = addressLinks(chainId, entry.address, entry.verified).find((candidate) => candidate.kind === kind);
    const status = statusWord(entry.verified[kind]);
    return link === undefined ? `${kind === "etherscan" ? "Etherscan" : "Sourcify"}: ${status}` : `[${link.label}](${link.url}): ${status}`;
  }).join(" · ");
  const source = entry.source_commit === null ? "not ours" : `\`${entry.source_commit}\``;
  return `| ${entry.name} | ${entry.role} | \`${entry.address}\` | ${links} | ${source} | ${entry.deployed_on ?? "not recorded"} |`;
}

/** The text of the page for the given records (no network, no clock). */
export function renderPage(records) {
  const out = [];
  out.push(`---
title: "Deployed contracts"
summary: "Every contract of each deployed pair, per chain, with its address, its role, the explorers that show it, where its source is verified, its source commit and its deploy date."
audience: [user, operator, integrator]
chains: all
verified_release: 0.1.0
---

# Deployed contracts

This page lists every contract that is live in each deployed pair, on each chain: what it does, its full address, a link to each explorer, whether its source code is verified there, the commit of the source and the day it was deployed. It also lists retired contracts, test tokens and the third-party contracts the bridge uses. The page is generated from the deployment record of each pair (\`deploy/deployments/<pair>.json\`) and is regenerated at every contract deployment.

Every contract in the bridge has no owner, no upgrade path and no pause. The address of a contract never changes, so a new deployment means new addresses and a new list on this page.`);

  for (const { pair, record } of records) {
    const sections = sectionsOf(record);
    const names = sections.map(([, section]) => CHAIN_METADATA[section.chain_id]?.name ?? `chain ${section.chain_id}`);
    out.push(`## ${names.join(" and ")}\n\nThe pair \`${pair}\`.`);
    for (const [, section] of sections) {
      const chainName = CHAIN_METADATA[section.chain_id]?.name ?? `chain ${section.chain_id}`;
      out.push(`### ${chainName} (chain ${section.chain_id})`);
      if (typeof section.verification_checked === "string") out.push(`Verification status read on ${section.verification_checked}.`);
      for (const group of Object.keys(GROUP_TITLES)) {
        const entries = section.contracts.filter((entry) => entry.group === group);
        if (entries.length === 0) continue;
        out.push(`#### ${GROUP_TITLES[group]} on ${chainName}\n\n${GROUP_INTROS[group]}`);
        out.push(["| Contract | What it does | Address | Explorers and verification | Source commit | Deployed |", "|---|---|---|---|---|---|", ...entries.map((entry) => row(section.chain_id, entry))].join("\n"));
      }
    }
  }

  out.push(`## How to check a contract yourself

1. Open the explorer link of the contract and confirm that the page shows verified source code with the contract name from the table. The address in the table is the full address; compare it with the one you are about to use.
2. Check the source against the chain. Check out the source commit from the table, build with the pinned compiler (Solidity 0.8.28, 200 optimizer runs, EVM version shanghai, no metadata hash, as set in \`foundry.toml\`), and compare the result with the code on the chain: \`cast code <address> --rpc-url <rpc>\` gives the deployed code. A contract that links a library has the library address written into its code; the libraries are in the same table.
3. A Blockscout page may say "partial match". The build sets no metadata hash, so Blockscout has no hash to compare and calls the match partial. Sourcify compares the same code and reports an exact match.
4. A contract shows "not verified" on an explorer until its source has been submitted there. That says nothing about the contract itself: the code on the chain is the same either way, and you can compare it yourself as in step 2.
5. Sourcify does not serve PulseChain testnet v4, and Etherscan serves only Ethereum chains, so those cells read "not supported".

## Keeping this page current

Every contract deployment updates the deployment record, runs the verification script (\`deploy/contracts-page/verify.mjs\`), regenerates this page (\`deploy/contracts-page/generate.mjs\`) and commits the result. A test fails when the committed page differs from what the record renders to. The steps are in \`docs/testnet-run.md\`.`);
  return `${out.join("\n\n")}\n`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET with a few tries on a server error (the PulseChain Blockscout answers 500 at times). Returns { status, body } or null. */
async function getJson(url, fetchImpl, tries = 4) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (response.status < 500 && response.status !== 429) return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      // try again
    }
    await sleep(1500 * (attempt + 1));
  }
  return null;
}

/** Whether Blockscout shows verified source for an address (a partial match counts), or null when it did not answer. */
export async function blockscoutStatus(chainId, address, fetchImpl = fetch) {
  const base = BLOCKSCOUT_API[chainId];
  if (base === undefined) return "unsupported";
  const result = await getJson(`${base}/api/v2/smart-contracts/${address}`, fetchImpl);
  if (result === null) return null;
  if (result.status === 404) return false;
  return result.status === 200 ? result.body?.is_verified === true : null;
}

/** Sourcify: true for a match, false for none, "unsupported" for a chain it does not serve, null when it did not answer. */
export async function sourcifyStatus(chainId, address, fetchImpl = fetch) {
  const result = await getJson(`${SOURCIFY_API}/v2/contract/${chainId}/${address}`, fetchImpl);
  if (result === null) return null;
  if (result.status === 200) return result.body?.match === "match" || result.body?.match === "exact_match" || result.body?.runtimeMatch != null;
  if (result.status === 404) return false;
  return result.body?.customCode === "unsupported_chain" ? "unsupported" : null;
}

/** Etherscan v2 getsourcecode. The key is only sent, never printed. */
export async function etherscanStatus(chainId, address, key, fetchImpl = fetch) {
  if (!ETHERSCAN_CHAINS.has(chainId)) return "unsupported";
  if (!key) return null;
  const result = await getJson(`${ETHERSCAN_API}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${encodeURIComponent(key)}`, fetchImpl);
  const first = result?.body?.result?.[0];
  if (result === null || typeof first !== "object" || first === null) return null;
  return typeof first.SourceCode === "string" && first.SourceCode !== "";
}

/**
 * Reads the status of every contract of a record from the explorers and writes it into the record. A status that an
 * explorer did not answer stays as the record has it, and the problem is reported through `log`.
 *
 * @param record The parsed record.
 * @param options `fetch`, `etherscanKey`, `today` (YYYY-MM-DD) and `log`.
 */
export async function refreshRecord(record, { fetch: fetchImpl = fetch, etherscanKey = "", today, log = () => {} } = {}) {
  for (const [, section] of sectionsOf(record)) {
    const chainId = section.chain_id;
    if (!etherscanKey && ETHERSCAN_CHAINS.has(chainId)) log(`chain ${chainId}: no ETHERSCAN_API_KEY, so the Etherscan status stays as the record has it`);
    for (const entry of section.contracts) {
      const found = {
        blockscout: await blockscoutStatus(chainId, entry.address, fetchImpl),
        sourcify: await sourcifyStatus(chainId, entry.address, fetchImpl),
        etherscan: await etherscanStatus(chainId, entry.address, etherscanKey, fetchImpl),
      };
      for (const kind of VERIFIERS) {
        if (found[kind] === null) {
          if (kind !== "etherscan" || etherscanKey) log(`chain ${chainId} ${entry.name} ${entry.address}: ${kind} gave no answer, keeping ${statusWord(entry.verified[kind])}`);
        } else entry.verified[kind] = found[kind];
      }
    }
    section.verification_checked = today;
  }
  return record;
}
