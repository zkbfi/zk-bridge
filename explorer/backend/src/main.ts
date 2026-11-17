import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { redactError, type CommandRunner } from "@zk-bridge/shared/config";
import type { Pair } from "@zk-bridge/shared";
import { endpointKeyVariables, executeCommand, type CommandExecutor } from "@zk-bridge/shared/prover";
import { grindPreflight, type PreflightResult } from "@zk-bridge/shared/msgboard";
import { createApp } from "./app.ts";
import { BackendConfigError, MODULE_NAMES, endpointSecrets, loadBackendPair, parseBackendConfig, readSecrets, remoteEndpoints, warmupTarget, type BackendConfig, type ModuleName } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import type { BackendModuleContext, ModuleTable } from "./module.ts";
import * as archive from "./archive/module.ts";
import * as msgboardIndexer from "./msgboard-indexer/module.ts";
import * as requests from "./requests/module.ts";
import { createProverFactories } from "./requests/job-prover.ts";
import { createProofNeedReader, withoutIndexer } from "./requests/proof-need.ts";
import { openStorage } from "./storage.ts";
import { billingEndpoints, createBillingReader } from "./billing.ts";
import { createGpuGuard } from "./gpu-guard.ts";
import { createIdleHistory } from "./idle-history.ts";
import { createIdleTimeoutReader } from "./idle-timeout.ts";
import { createProverPing } from "./watch/ping.ts";
import { watchedDirections } from "./watch/module.ts";
import * as webhook from "./webhook/module.ts";
import * as seal from "./seal/module.ts";
import * as rpcProxy from "./rpc-proxy/module.ts";
import { asBotLogger } from "./seal/module.ts";
import { spawnRunner } from "@zk-bridge/shared/config";
import { createSecretVault } from "../../bots/src/runtime/secrets.ts";
import { openSigner } from "../../bots/src/signing/open-signer.ts";

/** The modules by name. A later task replaces the stub behind a name. */
export const MODULES: ModuleTable = {
  requests,
  webhook,
  "msgboard-indexer": msgboardIndexer,
  archive,
  seal,
  "rpc-proxy": rpcProxy,
};

/** The prover reads the source chain of each direction from a beacon endpoint, so a request run needs both. */
function requireBeaconUrls(config: BackendConfig, pair: Pair): void {
  for (const side of pair.sides) {
    if (side.beaconUrl === null) throw new BackendConfigError(`beaconUrls needs an entry for chain ${side.chainId} when the requests module runs`);
  }
}

/** A request run starts only when the chain indexer shows that a direction needs a proof, so the requests module needs it. */
function requireIndexerUrl(config: BackendConfig): string {
  if (config.indexerUrl === undefined) throw new BackendConfigError("indexerUrl is needed when the requests module runs: the backend asks the chain indexer whether a proof is needed");
  return config.indexerUrl;
}

/** Runs the test of the grind engine and logs what it found. */
async function testGrindEngine(preflight: () => Promise<PreflightResult>, logger: Logger): Promise<PreflightResult> {
  const result = await preflight();
  if (result.ok) logger.info("grind_preflight_passed", { durationMilliseconds: result.durationMilliseconds });
  else logger.error("grind_preflight_failed", { reason: result.reason, detail: result.detail });
  return result;
}

/** What a running backend offers its caller. */
export interface RunningBackend {
  /** The port that the server listens on. */
  readonly port: number;
  /** Stops the server, waits for the running jobs and closes the database. */
  stop(): Promise<void>;
}

/** Input of {@link startBackend}. */
export interface StartBackendInput {
  readonly config: BackendConfig;
  readonly pair: Pair;
  readonly enabled: readonly ModuleName[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executor?: CommandExecutor;
  readonly now?: () => number;
  readonly write?: (line: string) => void;
  /** The test of the grind engine. Default: {@link grindPreflight}. A test replaces it. */
  readonly preflight?: () => Promise<PreflightResult>;
  /** Runs the 1Password command for a secret reference of the seal signer. Default: a child process. A test replaces it. */
  readonly run?: CommandRunner;
}

/**
 * Starts the chosen modules and the server.
 *
 * @throws BackendConfigError when a secret variable that the configuration names is not set.
 */
export async function startBackend(input: StartBackendInput): Promise<RunningBackend> {
  const { config } = input;
  const secrets = readSecrets(config, input.environment);
  const now = input.now ?? Date.now;
  // The secrets of the seal signer, read by reference as the runner reads its own (environment or 1Password, no store).
  const vault = createSecretVault({ store: null, environment: input.environment, run: input.run ?? spawnRunner });
  const logger: Logger = createLogger({
    write: input.write ?? ((line) => process.stderr.write(`${line}\n`)),
    now,
    // The endpoints can carry keys, so every secret part of each one is removed from every line.
    knownSecrets: () => [...secrets.proverKeys.map((key) => key.value), secrets.webhookBearer, ...endpointSecrets(config, input.pair), ...vault.knownSecrets()],
  });
  if (input.enabled.includes("seal") && config.seal === undefined) throw new BackendConfigError("the seal module needs a seal section with a signer");
  const sealSettings = config.seal;
  if (input.enabled.includes("requests")) {
    requireBeaconUrls(config, input.pair);
    requireIndexerUrl(config);
    // A watch that is switched on but cannot run is a configuration error, before anything starts.
    watchedDirections(config, input.pair);
  }
  const readProofNeed =
    config.indexerUrl === undefined
      ? withoutIndexer
      : createProofNeedReader({ baseUrl: config.indexerUrl, pair: input.pair, keepAliveSeconds: config.limits.keepAliveSeconds });
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const storage = openStorage(config.databasePath);
  const provers = createProverFactories({
    config,
    pair: input.pair,
    executor: input.executor ?? executeCommand,
    secrets,
    path: input.environment.PATH ?? "/usr/bin:/bin",
    logger,
  });
  const pingProver = createProverPing({ ...warmupTarget(config, secrets), timeoutMilliseconds: config.watch.warmup.pingTimeoutSeconds * 1000 });
  const runpodEndpoints = billingEndpoints(config, secrets);
  const billing = runpodEndpoints.length === 0 ? undefined : createBillingReader({ endpoints: runpodEndpoints, now, logger, ttlMilliseconds: config.billing.refreshSeconds * 1000, retryMilliseconds: config.billing.retrySeconds * 1000 });
  const idleHistory = createIdleHistory(storage);
  const idleReader =
    runpodEndpoints.length === 0 ? undefined : createIdleTimeoutReader({ endpoints: runpodEndpoints, logger, onObserved: (seconds) => idleHistory.record(now(), seconds) });
  const gpuGuard = runpodEndpoints.length === 0 || !config.gpuGuard.enabled ? undefined : createGpuGuard({ endpoints: runpodEndpoints, settings: config.gpuGuard, now, logger });
  if (config.watch.warmup.syncIdleTimeout !== undefined) {
    logger.warn("config_deprecated", { key: "watch.warmup.syncIdleTimeout", detail: "ignored: the backend no longer writes the idle timeout; it is set in deploy/runpod/endpoints.json. Remove the key" });
  }
  // Before anything can be signed or ground: the webhook posts proofs with a proof of work. A failed engine is logged and
  // shown on /health, and the webhook refuses to grind; the other modules go on.
  const grindEngine = input.enabled.includes("webhook") ? await testGrindEngine(input.preflight ?? grindPreflight, logger) : undefined;
  const context: BackendModuleContext = {
    storage,
    config,
    pair: input.pair,
    prover: provers.utilityProver,
    proverForJob: provers.proverForJob,
    handoffProver: provers.utilityProver,
    forkProofProver: provers.utilityProver,
    observationProver: provers.observationProver,
    headProver: provers.observationProver,
    openingProver: provers.utilityProver,
    readProofNeed,
    now,
    logger,
    ...(grindEngine === undefined ? {} : { grindEngine }),
    pingProver,
    ...(billing === undefined ? {} : { billing }),
    ...(gpuGuard === undefined ? {} : { gpuGuardState: () => gpuGuard.state() }),
    ...(idleReader === undefined ? {} : { endpointIdleTimeoutSeconds: () => idleReader.endpointIdleTimeoutSeconds() }),
    ...(sealSettings === undefined ? {} : { openSealSigner: () => openSigner({ settings: sealSettings.signer, vault, logger: asBotLogger(logger) }) }),
  };
  const app = createApp({ context, modules: MODULES, enabled: input.enabled });
  // In the background: a slow or failing RunPod never delays start-up. The idle timeout is read again with the billing.
  const idleReading = idleReader?.start(config.billing.refreshSeconds * 1000);
  const guarding = gpuGuard?.start();
  const stoppers = await Promise.all(input.enabled.map((name) => MODULES[name].start(context)));
  const server = await new Promise<ReturnType<typeof serve> & { port: number }>((resolve) => {
    const listening = serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, (address) => resolve(Object.assign(listening, { port: address.port })));
  });
  logger.info("backend_started", { modules: input.enabled, port: server.port });
  return {
    port: server.port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(stoppers.map((stop) => stop()));
      await idleReading?.stop();
      await guarding?.stop();
      storage.close();
    },
  };
}

/** The values of the command line. */
export type BackendArguments = { readonly configPath: string; readonly modules: readonly ModuleName[] | null };

/**
 * Reads `--config <file>` and `--modules a,b`.
 *
 * @throws BackendConfigError when the file is not named, a module is unknown or an argument is not known.
 */
export function parseArguments(argv: readonly string[]): BackendArguments {
  let configPath: string | null = null;
  let modules: ModuleName[] | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new BackendConfigError(`${flag} needs a value`);
    if (flag === "--config") configPath = value;
    else if (flag === "--modules") modules = value.split(",").map((name) => parseModuleName(name));
    else throw new BackendConfigError(`unknown argument ${flag}`);
  }
  if (configPath === null) throw new BackendConfigError("name the configuration file with --config <file>");
  return { configPath, modules };
}

function parseModuleName(name: string): ModuleName {
  const known = MODULE_NAMES.find((candidate) => candidate === name);
  if (known === undefined) throw new BackendConfigError(`unknown module "${name}" (known: ${MODULE_NAMES.join(", ")})`);
  return known;
}

/** Replacements for the parts that touch the outside world. A test passes them. */
export interface MainOverrides {
  /** Ends the run. The default listens for SIGINT and SIGTERM. */
  readonly stopSignal?: AbortSignal;
  readonly executor?: CommandExecutor;
  readonly write?: (line: string) => void;
}

function valuesToHide(config: BackendConfig, environment: Readonly<Record<string, string | undefined>>): string[] {
  const named = [...endpointKeyVariables(remoteEndpoints(config)), config.webhookBearerVariable].map((name) => environment[name] ?? "");
  return [...named, ...endpointSecrets(config, null)].filter((value) => value !== "");
}

function signalFromProcess(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller.signal;
}

/**
 * The entry point: `--config <file> [--modules requests,webhook,msgboard-indexer,archive,seal,rpc-proxy]`.
 *
 * @returns The exit code. 0 after a stop signal, 1 after a configuration error.
 */
export async function main(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>, overrides: MainOverrides = {}): Promise<number> {
  const write = overrides.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  // Values that an error message must never show: the named variables and every endpoint (an endpoint can carry a key).
  let knownValues: string[] = [];
  try {
    const parsed = parseArguments(argv);
    const config = parseBackendConfig(await readFile(parsed.configPath, "utf8"));
    knownValues = valuesToHide(config, environment);
    const deployment: unknown = JSON.parse(await readFile(config.deploymentFile, "utf8"));
    const pair = loadBackendPair(config, deployment);
    const running = await startBackend({ config, pair, enabled: parsed.modules ?? config.modules, environment, executor: overrides.executor, write: overrides.write });
    const stopSignal = overrides.stopSignal ?? signalFromProcess();
    await new Promise<void>((resolve) => (stopSignal.aborted ? resolve() : stopSignal.addEventListener("abort", () => resolve(), { once: true })));
    await running.stop();
    return 0;
  } catch (error) {
    write(`zk-bridge-backend: ${redactError(error, knownValues)}`);
    return 1;
  }
}
