import type { PairConfig } from "@terminal/model/types";
import { buildPairConfig, DEFAULT_PAIR_ID } from "@terminal/config/pairs";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { assertNoSecrets, ConfigurationError } from "./secret-scan";

/** Where the page reads its data from. `fixture` uses built-in sample data and simulated sends, with no network. */
export type DataMode = "live" | "fixture";

/** Everything that the page reads at build time from `VITE_` variables. */
export type WebConfiguration = {
  readonly dataMode: DataMode;
  /** The base URL of the indexer, without a trailing slash. */
  readonly indexerUrl: string;
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

/** The indexer address when none is set. */
export const DEFAULT_INDEXER_URL = "http://localhost:42069";

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
    indexerUrl: (present(environment[VARIABLES.indexerUrl]) ?? DEFAULT_INDEXER_URL).replace(/\/$/, ""),
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
 * Builds the pair from the deployment file. A fixture page uses the built-in sample pair.
 *
 * @param configuration The configuration.
 * @param fetcher Replaces `fetch`.
 * @throws ConfigurationError when the deployment text is not JSON or does not describe the pair.
 */
export const loadPairConfig = async (configuration: WebConfiguration, fetcher: TextFetcher = defaultFetcher): Promise<PairConfig> => {
  if (configuration.dataMode === "fixture") return FIXTURE_PAIR;
  const text = configuration.deploymentJson ?? (await fetcher(configuration.deploymentUrl ?? ""));
  try {
    return buildPairConfig(configuration.pairName, JSON.parse(text));
  } catch (error) {
    throw new ConfigurationError(`The deployment file is not usable: ${error instanceof Error ? error.message : String(error)}`);
  }
};
