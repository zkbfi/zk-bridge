#!/usr/bin/env node
// Verifies the source of every contract of one deployment on the explorers, then reads the status back into the record
// and regenerates the page. Run it after every contract deployment (docs/testnet-run.md, "After a contract deployment").
//
//   node deploy/contracts-page/verify.mjs --pair sepolia-pls943 --commit cf63fff9 [options]
//
//   --pair <name>          the record, deploy/deployments/<name>.json (required)
//   --commit <hash>        the source commit; only contracts whose `source_commit` matches it are verified (required)
//   --chain <id>           only this chain
//   --only <Name,Name>     only contracts with these names (the `name` of the record, without the part in brackets)
//   --explorers <list>     blockscout,sourcify,etherscan (default: all three; etherscan needs ETHERSCAN_API_KEY)
//   --force                submit even where the explorer already shows the contract as verified
//   --dry-run              build everything and read what is needed, but submit nothing and leave the record alone
//   --no-generate          skip the status read and the page at the end
//   --lib <folder>         where the Foundry libraries are (default: lib/ of the main checkout), linked into the temporary worktree
//
// How it works, per contract: the standard JSON input comes from `forge verify-contract --show-standard-json-input` in a
// temporary git worktree of the source commit. The constructor arguments are the tail of the creation transaction's
// input after the creation code (`forge inspect ... bytecode`); a contract created by a factory has none. A library that
// the contract links is read from the same chain's list in the record. Blockscout takes the standard JSON on its v2
// endpoint (the legacy keyless API is rate limited, and the script waits and retries on "Too many requests"). Sourcify
// takes it on its v2 endpoint (Sepolia and mainnet only). Etherscan takes it on API v2 with ETHERSCAN_API_KEY, which the
// script sends and never prints.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BLOCKSCOUT_API, ETHERSCAN_API, ETHERSCAN_CHAINS, ROOT, SOURCIFY_API, VERIFIERS, blockscoutStatus, etherscanStatus, loadRecords, sectionsOf, sourcifyStatus } from "./lib.mjs";

/** The compiler and settings of every contract of the project (foundry.toml pins the same). */
export const COMPILER = { version: "0.8.28", full: "v0.8.28+commit.7893614a", sourcify: "0.8.28+commit.7893614a", runs: 200, evm: "shanghai" };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The contracts of a record to verify: those with source whose source commit matches `commit` (either may be the longer). */
export function selectEntries(record, { commit, chain, only }) {
  const picked = [];
  for (const [, section] of sectionsOf(record)) {
    if (chain !== undefined && section.chain_id !== chain) continue;
    for (const entry of section.contracts) {
      if (entry.source === null || entry.source_commit === null) continue;
      if (!(commit.startsWith(entry.source_commit) || entry.source_commit.startsWith(commit))) continue;
      if (only !== undefined && !only.includes(entry.name.replace(/ \(.*\)$/, ""))) continue;
      picked.push({ section, entry });
    }
  }
  return picked;
}

/** The `--libraries path:Name:address` flags of a contract, from the same chain's list. */
export function libraryFlags(section, entry) {
  return (entry.libraries ?? []).flatMap((name) => {
    const library = section.contracts.find((candidate) => candidate.name === name);
    if (library === undefined || library.source === null) throw new Error(`${entry.name} links ${name}, which is not in the record of chain ${section.chain_id}`);
    return ["--libraries", `${library.source}:${library.address}`];
  });
}

/**
 * The constructor arguments (hex, no 0x) from the input of the creation transaction and the creation code.
 * The creation code of a contract that links libraries holds placeholders, which have the length of an address.
 */
export function constructorArgsOf(creationInput, creationCode) {
  const input = creationInput.replace(/^0x/, "");
  const code = creationCode.replace(/^0x/, "");
  if (input.length < code.length) throw new Error("the creation transaction is shorter than the creation code: it is not the transaction that created the contract");
  const args = input.slice(code.length);
  if (args.length % 64 !== 0) throw new Error("the data after the creation code is not a whole number of 32 byte words; set constructor_args in the record");
  return args;
}

function parseArguments(argv) {
  const options = { explorers: [...VERIFIERS] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${flag} needs a value`);
      return argv[index];
    };
    if (flag === "--pair") options.pair = value();
    else if (flag === "--commit") options.commit = value();
    else if (flag === "--chain") options.chain = Number(value());
    else if (flag === "--only") options.only = value().split(",");
    else if (flag === "--explorers") options.explorers = value().split(",");
    else if (flag === "--lib") options.lib = resolve(value());
    else if (flag === "--force") options.force = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--no-generate") options.noGenerate = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (options.pair === undefined || options.commit === undefined) throw new Error("--pair and --commit are required");
  const unknown = options.explorers.filter((name) => !VERIFIERS.includes(name));
  if (unknown.length > 0) throw new Error(`unknown explorer ${unknown.join(", ")}; the names are ${VERIFIERS.join(", ")}`);
  return options;
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// FORGE names the binary; otherwise the Foundry installer's folder when it exists, otherwise forge from PATH.
const FORGE = process.env.FORGE ?? (existsSync(join(homedir(), ".foundry/bin/forge")) ? join(homedir(), ".foundry/bin/forge") : "forge");
const forge = (cwd, args) => execFileSync(FORGE, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** A git worktree of the commit with the Foundry libraries linked in. Returns its folder. */
function makeWorktree(commit, libFolder) {
  const folder = mkdtempSync(join(tmpdir(), "verify-"));
  rmSync(folder, { recursive: true });
  git("worktree", "add", "--detach", folder, commit);
  const lib = join(folder, "lib");
  if (existsSync(lib) && readdirSync(lib).length === 0) rmSync(lib, { recursive: true });
  if (!existsSync(lib)) symlinkSync(libFolder, lib);
  return folder;
}

async function getJson(url, tries = 4) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status < 500) return await response.json();
    } catch {
      // try again
    }
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`no answer from ${new URL(url).host}`);
}

/** The creation transaction (hash and input) of an address, read from the Blockscout of its chain. */
async function creationOf(chainId, address) {
  const base = BLOCKSCOUT_API[chainId];
  const info = await getJson(`${base}/api/v2/addresses/${address}`);
  const hash = info.creation_transaction_hash ?? info.creation_tx_hash;
  if (!hash) throw new Error(`Blockscout has no creation transaction for ${address} (a contract made by a factory has none: set "created_by": "factory" in the record)`);
  const transaction = await getJson(`${base}/api/v2/transactions/${hash}`);
  if (typeof transaction.raw_input !== "string") throw new Error(`Blockscout gave no input for the creation transaction ${hash}`);
  return { hash, input: transaction.raw_input };
}

async function submitBlockscout(chainId, address, standardJson, args) {
  const url = `${BLOCKSCOUT_API[chainId]}/api/v2/smart-contracts/${address}/verification/via/standard-input`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const form = new FormData();
    form.set("compiler_version", COMPILER.full);
    form.set("license_type", "mit");
    if (args !== "") form.set("constructor_args", `0x${args}`);
    form.set("files[0]", new Blob([standardJson], { type: "application/json" }), "input.json");
    const response = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    const text = await response.text();
    if (response.status === 429 || /too many/i.test(text)) {
      await sleep(40_000);
      continue;
    }
    if (!response.ok) throw new Error(`Blockscout answered ${response.status}: ${text.slice(0, 300)}`);
    for (let poll = 0; poll < 24; poll += 1) {
      if ((await blockscoutStatus(chainId, address)) === true) return "verified";
      await sleep(5000);
    }
    return `submitted (${text.slice(0, 120)}), not shown as verified after 2 minutes`;
  }
  throw new Error("Blockscout kept answering Too many requests");
}

async function submitSourcify(chainId, address, standardJson, entry, creationHash) {
  const body = { stdJsonInput: JSON.parse(standardJson), compilerVersion: COMPILER.sourcify, contractIdentifier: entry.source, ...(creationHash ? { creationTransactionHash: creationHash } : {}) };
  const response = await fetch(`${SOURCIFY_API}/v2/verify/${chainId}/${address}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const answer = await response.json().catch(() => ({}));
  if (response.status === 409) return "already verified";
  if (!response.ok || !answer.verificationId) throw new Error(`Sourcify answered ${response.status}: ${JSON.stringify(answer).slice(0, 300)}`);
  for (let poll = 0; poll < 36; poll += 1) {
    await sleep(5000);
    const job = await getJson(`${SOURCIFY_API}/v2/verify/${answer.verificationId}`);
    if (job.isJobCompleted) return job.error ? `failed: ${JSON.stringify(job.error).slice(0, 300)}` : `verified (${job.contract?.match ?? "match"})`;
  }
  return "submitted, the job had not finished after 3 minutes";
}

async function submitEtherscan(chainId, address, standardJson, entry, args, key) {
  const form = new URLSearchParams({
    apikey: key,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: address,
    sourceCode: standardJson,
    codeformat: "solidity-standard-json-input",
    contractname: entry.source,
    compilerversion: COMPILER.full,
    constructorArguements: args,
  });
  const response = await fetch(`${ETHERSCAN_API}?chainid=${chainId}`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  const answer = await response.json().catch(() => ({}));
  if (answer.status !== "1") return `refused: ${String(answer.result ?? answer.message).slice(0, 200)}`;
  for (let poll = 0; poll < 24; poll += 1) {
    await sleep(5000);
    const check = await getJson(`${ETHERSCAN_API}?chainid=${chainId}&module=contract&action=checkverifystatus&guid=${encodeURIComponent(answer.result)}&apikey=${encodeURIComponent(key)}`);
    if (!/pending|queue/i.test(String(check.result))) return String(check.result);
  }
  return "submitted, not finished after 2 minutes";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const item = loadRecords().find((candidate) => candidate.pair === options.pair);
  if (item === undefined) throw new Error(`no record deploy/deployments/${options.pair}.json with a contracts list`);
  const picked = selectEntries(item.record, options);
  if (picked.length === 0) throw new Error(`no contract of ${options.pair} has source commit ${options.commit}`);
  const etherscanKey = process.env.ETHERSCAN_API_KEY ?? "";
  console.log(`${picked.length} contract(s) of ${options.pair} from commit ${options.commit}${options.dryRun ? " (dry run: nothing is submitted)" : ""}`);

  const libFolder = options.lib ?? join(dirname(resolve(git("rev-parse", "--path-format=absolute", "--git-common-dir"))), "lib");
  const worktree = makeWorktree(options.commit, libFolder);
  let failures = 0;
  try {
    for (const { section, entry } of picked) {
      const chainId = section.chain_id;
      const label = `${chainId} ${entry.name} ${entry.address}`;
      try {
        const libraries = libraryFlags(section, entry);
        const standardJson = forge(worktree, ["verify-contract", "--show-standard-json-input", entry.address, entry.source, "--compiler-version", COMPILER.version, "--num-of-optimizations", String(COMPILER.runs), "--evm-version", COMPILER.evm, ...libraries]);
        let args = "";
        let creationHash = null;
        if (typeof entry.constructor_args === "string") args = entry.constructor_args;
        else if (entry.created_by !== "factory") {
          const creation = await creationOf(chainId, entry.address);
          creationHash = creation.hash;
          args = constructorArgsOf(creation.input, forge(worktree, ["inspect", entry.source, "bytecode"]).trim());
        }
        const lines = [];
        for (const explorer of options.explorers) {
          const supported = explorer === "blockscout" ? BLOCKSCOUT_API[chainId] !== undefined : explorer === "etherscan" ? ETHERSCAN_CHAINS.has(chainId) : (await sourcifyStatus(chainId, entry.address)) !== "unsupported";
          if (!supported) {
            lines.push(`${explorer}: not supported on this chain`);
            continue;
          }
          if (explorer === "etherscan" && etherscanKey === "") {
            lines.push("etherscan: skipped, ETHERSCAN_API_KEY is not set");
            continue;
          }
          const status = explorer === "blockscout" ? await blockscoutStatus(chainId, entry.address) : explorer === "sourcify" ? await sourcifyStatus(chainId, entry.address) : await etherscanStatus(chainId, entry.address, etherscanKey);
          if (status === true && !options.force) {
            lines.push(`${explorer}: already verified`);
            continue;
          }
          if (options.dryRun) {
            lines.push(`${explorer}: would submit ${standardJson.length} bytes of standard JSON, ${args.length / 2} bytes of constructor arguments${libraries.length ? `, libraries ${libraries.filter((word) => word !== "--libraries").length}` : ""}`);
            continue;
          }
          const result = explorer === "blockscout" ? await submitBlockscout(chainId, entry.address, standardJson, args) : explorer === "sourcify" ? await submitSourcify(chainId, entry.address, standardJson, entry, creationHash) : await submitEtherscan(chainId, entry.address, standardJson, entry, args, etherscanKey);
          lines.push(`${explorer}: ${result}`);
          await sleep(15_000);
        }
        console.log(`${label}\n  ${lines.join("\n  ")}`);
      } catch (error) {
        failures += 1;
        console.log(`${label}\n  FAILED: ${error.message.split("\n")[0]}`);
      }
    }
  } finally {
    git("worktree", "remove", "--force", worktree);
  }

  if (!options.dryRun && !options.noGenerate) {
    const generate = spawnSync(process.execPath, [fileURLToPath(new URL("./generate.mjs", import.meta.url)), "--refresh"], { stdio: "inherit", env: process.env });
    if (generate.status !== 0) failures += 1;
  }
  if (failures > 0) {
    console.log(`${failures} failure(s)`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}
