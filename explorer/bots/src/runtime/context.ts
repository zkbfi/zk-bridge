import { readFile } from "node:fs/promises";
import { loadProverSetup, setupFilePath, spawnRunner, type CommandRunner, type ProverSetup } from "@zk-bridge/shared/config";
import { PAIR_DEFINITIONS, beaconVariableName, loadPair, rpcVariableName, stateUrlsVariableName, urlSecrets, type Pair, type PairSide } from "@zk-bridge/shared";
import { BotConfigError, parseBotConfig, type BotConfig } from "../config/bot-config.ts";
import { createLogger, type Logger } from "../logging/logger.ts";
import { createSecretVault, openSecretStore, type Environment, type SecretVault } from "./secrets.ts";

/** Everything that both bots need before they start. */
export interface BotContext {
  readonly config: BotConfig;
  readonly setup: ProverSetup;
  readonly pair: Pair;
  readonly vault: SecretVault;
  readonly logger: Logger;
  readonly environment: Environment;
}

/** Input of {@link loadBotContext}. */
export interface LoadBotContextInput {
  readonly configPath: string;
  readonly environment: Environment;
  /** Receives each log line. The command line entry passes standard error. */
  readonly write: (line: string) => void;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
}

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new BotConfigError(`Cannot read the ${what} at ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BotConfigError(`The ${what} at ${path} is not valid JSON.`);
  }
}

/**
 * The environment that the pair registry reads: the endpoints of the setup file, resolved through the vault, over the
 * variables that the operator set. An endpoint in the setup file wins, because the dashboard validated it.
 */
async function pairEnvironment(setup: ProverSetup, environment: Environment, vault: SecretVault, sides: readonly number[]): Promise<Environment> {
  const resolved: Record<string, string | undefined> = { ...environment };
  for (const chainId of sides) {
    const endpoints = setup.chains[String(chainId)];
    const rpc = await vault.resolveOptional(endpoints?.rpc);
    const beacon = await vault.resolveOptional(endpoints?.beacon);
    const stateUrls = await vault.resolveOptional(endpoints?.stateUrls);
    if (rpc !== null) resolved[rpcVariableName(chainId)] = rpc;
    if (beacon !== null) resolved[beaconVariableName(chainId)] = beacon;
    if (stateUrls !== null) resolved[stateUrlsVariableName(chainId)] = stateUrls;
  }
  return resolved;
}

/**
 * Loads the bot configuration, the setup file, the secret store and the pair. After this call the logger removes every
 * secret that the vault resolved, so later code can log freely.
 *
 * @throws BotConfigError for a file that is missing or invalid.
 */
export async function loadBotContext(input: LoadBotContextInput): Promise<BotContext> {
  const config = parseBotConfig(await readJson(input.configPath, "bot configuration"));
  const run = input.run ?? spawnRunner;
  const store = await openSecretStore({
    settings: config.secretStore,
    environment: input.environment,
    platform: input.platform ?? process.platform,
    run,
  });
  const vault = createSecretVault({ store, environment: input.environment, run });
  const passwordVariable = config.secretStore.passwordVariable;
  const password = passwordVariable === undefined ? undefined : input.environment[passwordVariable];
  if (password !== undefined) vault.remember(password);
  const logger = createLogger({
    write: input.write,
    now: input.now ?? (() => new Date()),
    knownSecrets: vault.knownSecrets,
    minimumLevel: config.logLevel,
  });
  const setup = await loadProverSetup(config.setupFile ?? setupFilePath(input.environment));
  const deploymentPath = config.deploymentFile ?? input.environment.EXPLORER_DEPLOYMENT_FILE;
  if (deploymentPath === undefined || deploymentPath === "") {
    throw new BotConfigError("Set deploymentFile in the bot configuration, or the variable EXPLORER_DEPLOYMENT_FILE.");
  }
  const deployment = await readJson(deploymentPath, "deployment file");
  const definitionChains = pairChainIds(setup.pair);
  const environment = await pairEnvironment(setup, input.environment, vault, definitionChains);
  const pair = loadPair({ pairName: setup.pair, environment, deployment });
  // A list of state URLs is one value in the vault, so a single URL from it would not match. Each URL and its key-like
  // parts count as secrets of their own, whether the list came from the setup file or from the environment.
  for (const side of pair.sides) {
    for (const url of side.stateUrls) for (const piece of urlSecrets(url)) vault.remember(piece);
  }
  return { config, setup, pair, vault, logger, environment: input.environment };
}

function pairChainIds(pairName: string): readonly number[] {
  // An unknown pair gives no chain here, and `loadPair` then fails with a clear message.
  const definition = PAIR_DEFINITIONS.find((candidate) => candidate.name === pairName);
  return definition === undefined ? [] : definition.sides.map((side) => side.chainId);
}

/** The source and the destination side of a direction. The light client sits on the destination and tracks the source. */
export function sidesOfDirection(pair: Pair, direction: "first-to-second" | "second-to-first"): { source: PairSide; destination: PairSide } {
  const [first, second] = pair.sides;
  return direction === "first-to-second" ? { source: first, destination: second } : { source: second, destination: first };
}
