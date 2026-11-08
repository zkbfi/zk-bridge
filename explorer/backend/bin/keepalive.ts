// The wiring of `zk-bridge-keepalive`: files, endpoints, viem, fetch and child processes. The logic is in
// src/keepalive (tested); this file only connects it to the real world. See docs/testnet-run.md,
// "Keeping the light clients alive".
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { beaconVariableName, handoffUrlsVariableName, loadPair, redactSecrets, rpcVariableName, stateUrlsVariableName, type Pair, type ProofDirection } from "@zk-bridge/shared";
import { createBackendClient } from "@zk-bridge/shared/backend-client";
import { fetchJsonResponse } from "@zk-bridge/shared";
import { postJsonResponse } from "@zk-bridge/shared/msgboard-http";
import { parseArguments, USAGE, type CliOptions } from "../src/keepalive/cli.ts";
import { describeInspection, inspect, marchOne, summarize, type MarchResult, type Reads, type Runtime, type Target } from "../src/keepalive/march.ts";
import { backendPath, localPath, type RunResult } from "../src/keepalive/paths.ts";
import { DEFAULT_POLICY, EXIT_READ_FAILED, VERDICT_EXIT_CODES, worseExitCode, type Policy } from "../src/keepalive/plan.ts";
import { fetchJsonGet, handoffSources, readHistoryFrom, readLightClient, readSource } from "../src/keepalive/sources.ts";

type BackendFile = {
  pair?: string;
  deploymentFile?: string;
  rpcUrls?: Record<string, string>;
  beaconUrls?: Record<string, string>;
  stateUrls?: Record<string, string[]>;
  handoffUrls?: Record<string, string[]>;
  handoffArchiveUrls?: string[];
  indexerUrl?: string;
  listen?: { host?: string; port?: number };
  limits?: { keepAliveSeconds?: number };
};

/** The handoff archive the backend of the file serves and reads (`handoffArchiveBases` in src/config.ts), for a planner outside it. */
function archiveBasesOf(file: BackendFile): string[] {
  const host = file.listen?.host === undefined || file.listen.host === "0.0.0.0" || file.listen.host === "::" ? "127.0.0.1" : file.listen.host;
  const own = file.listen === undefined ? [] : [`http://${host.includes(":") ? `[${host}]` : host}:${file.listen.port ?? 8787}/archive/handoffs`];
  const indexer = file.indexerUrl === undefined ? [] : [`${file.indexerUrl.replace(/\/+$/, "")}/api/proofs/handoffs`];
  return [...own, ...indexer, ...(file.handoffArchiveUrls ?? [])];
}

// Secrets (an RPC URL with a key in it) go to the child through its environment, never its arguments: the arguments of a
// running process are readable by every user of the machine (ps, /proc/<pid>/cmdline).
const runProgram = (command: string, args: readonly string[], timeoutMilliseconds: number, extraEnvironment: Readonly<Record<string, string>> = {}) =>
  new Promise<RunResult>((resolve) => {
    execFile(command, [...args], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMilliseconds, env: { ...process.env, ...extraEnvironment } }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

// Endpoints can carry a key (valve.city puts it in the path). Every line goes through the redactor with the known
// endpoints and VALVE_KEY, so an error from viem or fetch that quotes a URL does not print the key.
const secrets: string[] = [];
const out = (text: string): boolean => process.stdout.write(redactSecrets(text, secrets));
const err = (text: string): boolean => process.stderr.write(redactSecrets(text, secrets));

export async function main(argv: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  if (environment.VALVE_KEY) secrets.push(environment.VALVE_KEY);
  const parsed = parseArguments(argv, environment);
  if ("error" in parsed) {
    err(`zk-bridge-keepalive: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  const options: CliOptions = parsed;
  const file: BackendFile = options.backendConfig === undefined ? {} : (JSON.parse(readFileSync(options.backendConfig, "utf8")) as BackendFile);
  const deploymentPath = options.deployment ?? file.deploymentFile;
  if (deploymentPath === undefined) {
    err("zk-bridge-keepalive: name the deployment file with --deployment or --backend-config\n");
    return 2;
  }
  // Endpoints: the environment wins over the backend file.
  const endpoints: Record<string, string | undefined> = { ...environment };
  for (const [chainId, url] of Object.entries(file.rpcUrls ?? {})) endpoints[rpcVariableName(Number(chainId))] ??= url;
  for (const [chainId, url] of Object.entries(file.beaconUrls ?? {})) endpoints[beaconVariableName(Number(chainId))] ??= url;
  for (const [chainId, urls] of Object.entries(file.stateUrls ?? {})) endpoints[stateUrlsVariableName(Number(chainId))] ??= urls.join(",");
  for (const [chainId, urls] of Object.entries(file.handoffUrls ?? {})) endpoints[handoffUrlsVariableName(Number(chainId))] ??= urls.join(",");
  const archiveUrls = archiveBasesOf(file);
  const pair: Pair = loadPair({ pairName: options.pair ?? file.pair ?? "sepolia-pls943", environment: endpoints, deployment: JSON.parse(readFileSync(deploymentPath, "utf8")) });
  for (const side of pair.sides) {
    secrets.push(side.rpcUrl);
    if (side.beaconUrl !== null) secrets.push(side.beaconUrl);
    secrets.push(...(side.stateUrls ?? []), ...(side.handoffUrls ?? []));
  }
  secrets.push(...archiveUrls);
  const policy: Policy = {
    keepAliveSeconds: options.keepAliveHours !== undefined ? options.keepAliveHours * 3600 : (file.limits?.keepAliveSeconds ?? DEFAULT_POLICY.keepAliveSeconds),
    marginSeconds: options.marginHours * 3600,
  };

  const [first, second] = pair.sides;
  const sides = { "first-to-second": [first, second], "second-to-first": [second, first] } as const;
  const targets: Target[] = options.directions.map((direction: ProofDirection) => {
    const [source, destination] = sides[direction];
    return { direction, label: `${source.name} -> ${destination.name}`, lightClient: destination.contracts.lightClient, destinationChainId: destination.chainId };
  });
  const sideOfTarget = (target: Target) => sides[target.direction];
  const clients = new Map(pair.sides.map((side) => [side.chainId, createPublicClient({ transport: http(side.rpcUrl, { timeout: 30_000 }) })]));
  const get = fetchJsonGet();
  const beaconOf = (target: Target): string => {
    const url = sideOfTarget(target)[0].beaconUrl;
    if (url === null) throw new Error(`set ${beaconVariableName(sideOfTarget(target)[0].chainId)} to the beacon endpoint of chain ${sideOfTarget(target)[0].chainId}`);
    return url;
  };
  const reads: Reads = {
    lightClient: (target) => readLightClient(clients.get(target.destinationChainId) as ReturnType<typeof createPublicClient>, target.lightClient),
    source: (target) => readSource(get, beaconOf(target)),
    // Every source the prover would ask, in its order; stranded only when none has the period (src/keepalive/sources.ts).
    history: (target, periods, slotsPerPeriod) => {
      const source = sideOfTarget(target)[0];
      const sources = handoffSources(get, { chainId: source.chainId, beaconUrl: beaconOf(target), stateUrls: source.stateUrls ?? [], handoffUrls: source.handoffUrls ?? [], archiveUrls });
      return readHistoryFrom(sources, periods, slotsPerPeriod);
    },
  };
  const runtime: Runtime = {
    now: () => Math.floor(Date.now() / 1000),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log: (line) => err(`${new Date().toISOString()} ${line}\n`),
  };

  if (options.command === "status") {
    let exitCode = 0;
    const report: unknown[] = [];
    for (const target of targets) {
      try {
        const inspection = await inspect(target, reads, policy, runtime.now());
        exitCode = worseExitCode(exitCode, VERDICT_EXIT_CODES[inspection.assessment.verdict]);
        if (options.json) report.push({ ...target, ...inspection });
        else out(`${describeInspection(target, inspection).join("\n")}\n\n`);
      } catch (error) {
        exitCode = worseExitCode(exitCode, EXIT_READ_FAILED);
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) report.push({ ...target, error: message });
        else out(`${target.label}: cannot read: ${message}\n\n`);
      }
    }
    if (options.json) out(`${JSON.stringify({ exitCode, lightClients: report }, null, 2)}\n`);
    return exitCode;
  }

  let path;
  if (options.via === "backend") {
    const backend = createBackendClient({ baseUrl: options.backendUrl, fetchJson: fetchJsonResponse, postJson: postJsonResponse });
    path = backendPath(
      backend,
      { pair: pair.name, baseUrl: options.backendUrl, maxRetryWaitSeconds: options.maxRetryWaitSeconds, jobTimeoutSeconds: options.jobTimeoutMinutes * 60, pollSeconds: options.pollSeconds },
      runtime,
    );
  } else {
    if (options.prover === undefined || options.proverConfig === undefined || (options.execute && options.account === undefined)) {
      err("zk-bridge-keepalive: --via local needs --prover (or PROVER), --prover-config, and with --execute --account (or KEYSTORE_NAME)\n");
      return 2;
    }
    const account = options.account as string;
    path = localPath(
      { prover: options.prover, proverConfig: options.proverConfig, routes: options.routes },
      (command, args) => runProgram(command, args, options.jobTimeoutMinutes * 60_000),
      async (target, calldata) => {
        const rpcUrl = sideOfTarget(target)[1].rpcUrl;
        const result = await runProgram("cast", ["send", target.lightClient, "--data", calldata, "--account", account, "--json"], 15 * 60_000, { ETH_RPC_URL: rpcUrl });
        if (result.exitCode !== 0) return { ok: false, detail: `cast send exit code ${result.exitCode}` };
        const receipt = JSON.parse(result.stdout) as { transactionHash?: string; status?: string };
        return { ok: receipt.status === "0x1" || receipt.status === "1", detail: `transaction ${receipt.transactionHash ?? "unknown"} status ${receipt.status ?? "unknown"}` };
      },
    );
  }

  const results: MarchResult[] = [];
  for (const target of targets) {
    results.push(
      await marchOne({
        target,
        reads,
        path,
        policy,
        options: { execute: options.execute, maxProofs: options.maxProofs, headTimeoutSeconds: options.headTimeoutMinutes * 60, pollSeconds: options.pollSeconds },
        runtime,
      }),
    );
  }
  const summary = summarize(results);
  for (const alert of summary.alerts) err(`${alert}\n`);
  if (!options.execute) err("dry run: nothing was requested or sent; add --execute to act\n");
  return summary.exitCode;
}
