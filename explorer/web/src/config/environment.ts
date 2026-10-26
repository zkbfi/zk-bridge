import type { PairConfig } from "@terminal/model/types";
import { loadPair, type Pair } from "@zk-bridge/shared";
import { buildPairConfig, DEFAULT_PAIR_ID } from "@terminal/config/pairs";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { assertNoSecrets, ConfigurationError } from "./secret-scan";

/** Where the page reads its data from. `fixture` uses built-in sample data and simulated sends, with no network. */
export type DataMode = "live" | "fixture";

/** Everything that the page reads at build time from `VITE_` variables. */
export type WebConfiguration = {
  readonly dataMode: DataMode;
  /** The base URL of the indexer, without a trailing slash. Null when the variable is unset: the registry default then applies. */
  readonly indexerUrl: string | null;
  readonly pairName: string;
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
  pair: "VITE_EXPLORER_PAIR",
  rpcPrefix: "VITE_EXPLORER_RPC_URL_",
  deploymentUrl: "VITE_EXPLORER_DEPLOYMENT_URL",
  deploymentJson: "VITE_EXPLORER_DEPLOYMENT_JSON",
  walletConnect: "VITE_WALLETCONNECT_PROJECT_ID",
} as const;

const present = (value: string | undefined): string | null => (value === undefined || value.trim() === "" ? null : value.trim());

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
  const configuration: WebConfiguration = {
    dataMode: mode,
    indexerUrl: present(environment[VARIABLES.indexerUrl])?.replace(/\/$/, "") ?? null,
    pairName: present(environment[VARIABLES.pair]) ?? DEFAULT_PAIR_ID,
    rpcUrls: rpcUrlsOf(environment),
    deploymentJson: present(environment[VARIABLES.deploymentJson]),
    deploymentUrl: present(environment[VARIABLES.deploymentUrl]),
    walletConnectProjectId: present(environment[VARIABLES.walletConnect]),
  };
  if (mode === "live" && configuration.deploymentJson === null && configuration.deploymentUrl === null) {
    throw new ConfigurationError(`Set ${VARIABLES.deploymentUrl} or ${VARIABLES.deploymentJson} to the deployment file, or set ${VARIABLES.data}=fixture.`);
  }
  return configuration;
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
