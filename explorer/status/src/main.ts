import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { redactError } from "@zk-bridge/shared/config";
import { createLogger } from "../../backend/src/logger.ts";
import { buildChecks } from "./checks/index.ts";
import { StatusConfigError, loadStatusPair, parseStatusConfig, resolveReference, secretValues } from "./config.ts";
import type { ChainClient, Deps } from "./deps.ts";
import { createChainClient, execProgram } from "./exec.ts";
import { createRunner } from "./runner.ts";
import { createServer } from "./server.ts";
import { openStore } from "./store.ts";

/** Replacements for the parts that touch the outside world. A test passes them. */
export interface MainOverrides {
  /** Ends the run. The default listens for SIGINT and SIGTERM. */
  readonly stopSignal?: AbortSignal;
  readonly write?: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly exec?: Deps["exec"];
  readonly client?: (rpcUrl: string, timeoutMilliseconds: number) => ChainClient;
  /** Called with the port once the server listens. */
  readonly onListening?: (port: number) => void;
}

/** Reads `--config <file>`. */
export function parseArguments(argv: readonly string[]): { readonly configPath: string } {
  let configPath: string | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new StatusConfigError(`${flag} needs a value`);
    if (flag !== "--config") throw new StatusConfigError(`unknown argument ${flag}`);
    configPath = value;
  }
  if (configPath === null) throw new StatusConfigError("name the configuration file with --config <file>");
  return { configPath };
}

function signalFromProcess(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller.signal;
}

/**
 * The entry point: `--config <file>`. Runs the checks every `intervalSeconds` and serves the page and the API on
 * `listen`.
 *
 * @returns The exit code. 0 after a stop signal, 1 after a configuration error.
 */
export async function main(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>, overrides: MainOverrides = {}): Promise<number> {
  const write = overrides.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  let secrets: string[] = [];
  try {
    const { configPath } = parseArguments(argv);
    const config = parseStatusConfig(await readFile(configPath, "utf8"));
    secrets = secretValues(config, environment);
    const deployment: unknown = JSON.parse(await readFile(config.deploymentFile, "utf8"));
    const pair = loadStatusPair(config, deployment, environment);
    const logger = createLogger({ write, now: Date.now, knownSecrets: () => secrets });
    const clients = new Map(pair.sides.map((side) => [side.chainId, (overrides.client ?? createChainClient)(side.rpcUrl, config.timeoutSeconds * 1000)] as const));
    const deps: Deps = {
      config,
      pair,
      fetch: overrides.fetch ?? globalThis.fetch,
      now: Date.now,
      exec: overrides.exec ?? execProgram,
      client: (chainId) => clients.get(chainId) as ChainClient,
      memory: new Map(),
      apiKey: config.runpod === undefined ? undefined : resolveReference(config.runpod.apiKey, environment),
      requestTimeoutMilliseconds: config.timeoutSeconds * 1000,
    };
    const checks = buildChecks(deps);
    mkdirSync(dirname(config.databasePath), { recursive: true });
    const store = openStore(config.databasePath);
    const runner = createRunner({
      checks,
      store,
      logger,
      now: Date.now,
      timeoutMilliseconds: config.timeoutSeconds * 1000,
      retentionMilliseconds: config.retentionDays * 86_400_000,
      secrets: () => secrets,
    });
    const app = createServer({ store, checks, now: Date.now, intervalSeconds: config.intervalSeconds });
    const server = await new Promise<ReturnType<typeof serve> & { port: number }>((resolve) => {
      const listening = serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, (address) => resolve(Object.assign(listening, { port: address.port })));
    });
    logger.info("status_started", { port: server.port, checks: checks.length, intervalSeconds: config.intervalSeconds });
    overrides.onListening?.(server.port);
    runner.start(config.intervalSeconds * 1000);
    const stopSignal = overrides.stopSignal ?? signalFromProcess();
    await new Promise<void>((resolve) => (stopSignal.aborted ? resolve() : stopSignal.addEventListener("abort", () => resolve(), { once: true })));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runner.stop();
    store.close();
    return 0;
  } catch (error) {
    write(`zk-bridge-status: ${redactError(error, secrets)}`);
    return 1;
  }
}
