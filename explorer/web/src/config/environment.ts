import type { PairConfig } from "@terminal/model/types";
import { loadPair, type Pair } from "@zk-bridge/shared";
import { buildPairConfig, DEFAULT_PAIR_ID } from "@terminal/config/pairs";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { assertNoSecrets, ConfigurationError } from "./secret-scan";
import { parseRoute } from "../app/route";

/** Where the page reads its data from. `fixture` uses built-in sample data and simulated sends, with no network. */
export type DataMode = "live" | "fixture";

/** Everything that the page reads at build time from `VITE_` variables. */
export type WebConfiguration = {
  readonly dataMode: DataMode;
  /** The base URL of the indexer, without a trailing slash. Null when the variable is unset: the registry default then applies. */
  readonly indexerUrl: string | null;
  /** The base URL of the backend, without a trailing slash, or null. */
  readonly backendUrl: string | null;
  /** The base URL of the msgboard indexer, without a trailing slash, or null. */
  readonly msgboardIndexerUrl: string | null;
  /** The base URL of the archive, without a trailing slash, or null. */
  readonly archiveUrl: string | null;
  /** The base URL of the msgboard node, without a trailing slash, or null. */
  readonly msgboardUrl: string | null;
  readonly pairName: string;
  /** The pairs that this page has a deployment for, in the order of the configuration. The page opens one of them. */
  readonly availablePairs: readonly string[];
  /** The deployment text of each pair, when the release lists several (`VITE_EXPLORER_DEPLOYMENTS_JSON`), else null. */
  readonly deployments: Readonly<Record<string, string>> | null;
  /** Public RPC endpoint by chain identifier. */
  readonly rpcUrls: Readonly<Record<number, string>>;
  /** Inline deployment JSON, or null. */
  readonly deploymentJson: string | null;
  /** The URL of a deployment file, or null. */
  readonly deploymentUrl: string | null;
  /** Reserved for a future WalletConnect connector. The connector is not wired in yet. */
  readonly walletConnectProjectId: string | null;
};

/** The names of the variables. */
export const VARIABLES = {
  data: "VITE_EXPLORER_DATA",
  indexerUrl: "VITE_EXPLORER_INDEXER_URL",
  backendUrl: "VITE_EXPLORER_BACKEND_URL",
  msgboardIndexerUrl: "VITE_EXPLORER_MSGBOARD_INDEXER_URL",
  archiveUrl: "VITE_EXPLORER_ARCHIVE_URL",
  msgboardUrl: "VITE_EXPLORER_MSGBOARD_URL",
  pair: "VITE_EXPLORER_PAIR",
  rpcPrefix: "VITE_EXPLORER_RPC_URL_",
  deploymentUrl: "VITE_EXPLORER_DEPLOYMENT_URL",
  deploymentJson: "VITE_EXPLORER_DEPLOYMENT_JSON",
  deploymentsJson: "VITE_EXPLORER_DEPLOYMENTS_JSON",
  walletConnect: "VITE_WALLETCONNECT_PROJECT_ID",
} as const;

const present = (value: string | undefined): string | null => (value === undefined || value.trim() === "" ? null : value.trim());

const baseUrlOf = (value: string | undefined): string | null => present(value)?.replace(/\/$/, "") ?? null;

const rpcUrlsOf = (environment: Readonly<Record<string, string | undefined>>): Record<number, string> =>
  Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]): [number, string][] => {
      if (!name.startsWith(VARIABLES.rpcPrefix)) return [];
      const chainId = Number(name.slice(VARIABLES.rpcPrefix.length));
      const url = present(value);
      if (!Number.isInteger(chainId) || chainId <= 0 || url === null) return [];
      return [[chainId, url]];
    }),
  );

/**
 * Reads the map of deployments by pair name: one release can serve every pair it has a deployment for.
 *
 * @throws ConfigurationError when the text is not a JSON object of objects, or is empty.
 */
const deploymentsOf = (text: string | null): Record<string, string> | null => {
  if (text === null) return null;
  const refuse = (): never => {
    throw new ConfigurationError(`${VARIABLES.deploymentsJson} must be a JSON object that maps each pair name to its deployment.`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, value]) => typeof value !== "object" || value === null || Array.isArray(value))) return refuse();
  return Object.fromEntries(entries.map(([name, value]) => [name, JSON.stringify(value)]));
};

/**
 * The pairs the page opens on by default, best first: Ethereum and PulseChain, then, until that pair is deployed, the
 * Sepolia and PulseChain testnet v4 pair. A pair counts as live when the release carries its deployment file.
 */
export const PREFERRED_PAIRS = ["eth-pls", "sepolia-pls943"] as const;

/**
 * The pair to open when the address names none: the first preferred pair that the release has a deployment for, else
 * the release's first pair, else null.
 *
 * @param available The pairs that the release has deployments for, or null when it lists none.
 */
export const defaultPairOf = (available: readonly string[] | null): string | null => {
  const [first] = available ?? [];
  if (available === null || first === undefined) return null;
  return PREFERRED_PAIRS.find((name) => available.includes(name)) ?? first;
};

/**
 * Reads the configuration from the variables that Vite exposes.
 *
 * @param environment `import.meta.env`, or a test object.
 * @throws ConfigurationError when a value looks like a key, the data mode is unknown, or a live page has no deployment.
 */
export const readConfiguration = (environment: Readonly<Record<string, string | undefined>>): WebConfiguration => {
  const exposed = Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith("VITE_")));
  assertNoSecrets(exposed);
  const mode = present(environment[VARIABLES.data]) ?? "live";
  if (mode !== "live" && mode !== "fixture") {
    throw new ConfigurationError(`${VARIABLES.data} must be "live" or "fixture", not "${mode}".`);
  }
  const deployments = deploymentsOf(present(environment[VARIABLES.deploymentsJson]));
  const namedPair = present(environment[VARIABLES.pair]);
  const available = deployments === null ? null : Object.keys(deployments);
  if (available !== null && namedPair !== null && !available.includes(namedPair)) {
    throw new ConfigurationError(`${VARIABLES.pair} names ${namedPair}, but ${VARIABLES.deploymentsJson} has no deployment for it.`);
  }
  const pairName = namedPair ?? defaultPairOf(available) ?? DEFAULT_PAIR_ID;
  const configuration: WebConfiguration = {
    dataMode: mode,
    indexerUrl: baseUrlOf(environment[VARIABLES.indexerUrl]),
    backendUrl: baseUrlOf(environment[VARIABLES.backendUrl]),
    msgboardIndexerUrl: baseUrlOf(environment[VARIABLES.msgboardIndexerUrl]),
    archiveUrl: baseUrlOf(environment[VARIABLES.archiveUrl]),
    msgboardUrl: baseUrlOf(environment[VARIABLES.msgboardUrl]),
    pairName,
    availablePairs: available ?? [pairName],
    deployments,
    rpcUrls: rpcUrlsOf(environment),
    deploymentJson: deployments?.[pairName] ?? present(environment[VARIABLES.deploymentJson]),
    deploymentUrl: present(environment[VARIABLES.deploymentUrl]),
    walletConnectProjectId: present(environment[VARIABLES.walletConnect]),
  };
  if (mode === "live" && configuration.deploymentJson === null && configuration.deploymentUrl === null) {
    throw new ConfigurationError(`Set ${VARIABLES.deploymentUrl} or ${VARIABLES.deploymentJson} to the deployment file, or set ${VARIABLES.data}=fixture.`);
  }
  return configuration;
};

/**
 * Opens another pair of the release. The page builds its services for one pair, so a switch is a new page load.
 *
 * @param configuration The configuration.
 * @param pairName The requested pair, or null.
 * @returns The configuration for that pair, or the same configuration when the release has no deployment for it.
 */
export const selectPair = (configuration: WebConfiguration, pairName: string | null): WebConfiguration => {
  const text = pairName === null ? undefined : configuration.deployments?.[pairName];
  return text === undefined || pairName === null ? configuration : { ...configuration, pairName, deploymentJson: text };
};

/**
 * The pair that the address asks for: `?pair=<name>` first, then a `#/pair/<name>` route, else null.
 *
 * @param location The `search` and `hash` of `window.location`.
 */
export const requestedPair = (location: { readonly search: string; readonly hash: string }): string | null => {
  const fromQuery = present(new URLSearchParams(location.search).get("pair") ?? undefined);
  if (fromQuery !== null) return fromQuery;
  const route = parseRoute(location.hash);
  return route.name === "pair" ? route.pairId : null;
};

/** Fetches text. A test passes a fake. */
export type TextFetcher = (url: string) => Promise<string>;

const defaultFetcher: TextFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new ConfigurationError(`The deployment file answered ${response.status}.`);
  return response.text();
};

/**
 * Fetches the deployment file once and returns a configuration that holds its text inline. The page then reads the
 * file one time, for both the views and the RPC source. A configuration that holds the text already, and a fixture
 * page, come back unchanged.
 *
 * @param configuration The configuration.
 * @param fetcher Replaces `fetch`.
 */
export const withDeploymentText = async (configuration: WebConfiguration, fetcher: TextFetcher = defaultFetcher): Promise<WebConfiguration> => {
  if (configuration.dataMode === "fixture" || configuration.deploymentJson !== null) return configuration;
  return { ...configuration, deploymentJson: await fetcher(configuration.deploymentUrl ?? "") };
};

const readDeploymentText = async (configuration: WebConfiguration, fetcher: TextFetcher): Promise<string> =>
  configuration.deploymentJson ?? (await fetcher(configuration.deploymentUrl ?? ""));

/**
 * Builds the pair from the deployment file. A fixture page uses the built-in sample pair.
 *
 * @param configuration The configuration.
 * @param fetcher Replaces `fetch`.
 * @throws ConfigurationError when the deployment text is not JSON or does not describe the pair.
 */
export const loadPairConfig = async (configuration: WebConfiguration, fetcher: TextFetcher = defaultFetcher): Promise<PairConfig> => {
  if (configuration.dataMode === "fixture") return FIXTURE_PAIR;
  const text = await readDeploymentText(configuration, fetcher);
  try {
    return buildPairConfig(configuration.pairName, JSON.parse(text));
  } catch (error) {
    // `JSON.parse` and the pair builder throw Error objects only.
    throw new ConfigurationError(`The deployment file is not usable: ${(error as Error).message}`);
  }
};

/**
 * Builds the pair in the form that the RPC source needs: the addresses and the start blocks. It reads the same
 * deployment text as {@link loadPairConfig}. A chain with no RPC URL in the file gets an empty URL, because the
 * user can set one later. A fixture page needs no such pair and gets null.
 *
 * @param configuration The configuration.
 * @param fetcher Replaces `fetch`.
 * @throws ConfigurationError when the deployment text is not JSON or does not describe the pair.
 */
export const loadSharedPair = async (configuration: WebConfiguration, fetcher: TextFetcher = defaultFetcher): Promise<Pair | null> => {
  if (configuration.dataMode === "fixture") return null;
  const text = await readDeploymentText(configuration, fetcher);
  try {
    return loadPair({ pairName: configuration.pairName, environment: {}, deployment: JSON.parse(text), requireRpcUrl: false });
  } catch (error) {
    throw new ConfigurationError(`The deployment file is not usable: ${(error as Error).message}`);
  }
};
