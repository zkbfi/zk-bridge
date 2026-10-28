/**
 * The data and chain access of the page, built once from the configuration. Every component reads them through
 * `useServices`, so a test hands in fixtures and the page never reaches the network.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ChainAccess } from "@terminal/chain/chain-access";
import { createFixtureChainAccess } from "@terminal/chain/fixture-chain-access";
import { knownPairIds } from "@terminal/config/pairs";
import type { DataSource } from "@terminal/data/data-source";
import { createFixtureDataSource, FIXTURE_NOW } from "@terminal/data/fixtures";
import { createConnectionRuntime, type ConnectionRuntime } from "@terminal/data/connection-runtime";
import type { PairConfig } from "@terminal/model/types";
import type { ExplorerConnectionInput, ExplorerConnection, Pair } from "@zk-bridge/shared";
import { loadUserConnections, type ConnectionStorage } from "../config/connection-storage";
import type { WebConfiguration } from "../config/environment";
import { createFixtureIndexerClient } from "../data/fixture-indexer-client";
import { createFallbackIndexerClient, type IndexerClient } from "../data/indexer-client";

/** Everything that a component reads from outside React. */
export type Services = {
  readonly configuration: WebConfiguration;
  readonly pair: PairConfig;
  /** The pairs that the page knows by name, configured or not. */
  readonly knownPairs: readonly { readonly id: string; readonly label: string; readonly configured: boolean }[];
  readonly dataSource: DataSource;
  readonly indexer: IndexerClient;
  readonly chainAccess: ChainAccess;
  /** The live connections with their fallback, or null on a fixture page. */
  readonly connection: ConnectionRuntime | null;
  /** The clock in unix seconds. The fixture page pins it so that the sample data stays the same. */
  readonly now: () => number;
};

const KNOWN_PAIR_LABELS: Readonly<Record<string, string>> = {
  "eth-pls": "Ethereum and PulseChain",
  "sepolia-pls943": "Sepolia and PulseChain testnet v4",
};

const knownPairsOf = (pair: PairConfig): Services["knownPairs"] =>
  knownPairIds().map((id) => ({ id, label: KNOWN_PAIR_LABELS[id] ?? id, configured: id === pair.id }));

/** What a live page needs besides the configuration. A fixture page needs none of it. */
export type LiveServicesOptions = {
  /** The pair with the addresses and the start blocks that the RPC source needs. */
  readonly sharedPair: Pair | null;
  /** Where the settings of the user live. Null: no storage. */
  readonly storage?: ConnectionStorage | null;
  /** Options for every connection, such as the clock. A test uses it. */
  readonly connectionOptions?: Partial<ExplorerConnectionInput>;
  /** Replaces the connection factory. A test uses it. */
  readonly createConnection?: (input: ExplorerConnectionInput) => ExplorerConnection;
};

/**
 * Builds the services for a configuration and a pair.
 *
 * @param configuration The page configuration.
 * @param pair The configured pair.
 * @param live The shared pair and the storage of a live page.
 * @throws When a live page has no shared pair.
 */
export const createServices = (configuration: WebConfiguration, pair: PairConfig, live: LiveServicesOptions = { sharedPair: null }): Services => {
  const base = { configuration, pair, knownPairs: knownPairsOf(pair) };
  if (configuration.dataMode === "fixture") {
    return {
      ...base,
      dataSource: createFixtureDataSource(),
      indexer: createFixtureIndexerClient({ pair }),
      chainAccess: createFixtureChainAccess(pair),
      connection: null,
      now: () => FIXTURE_NOW,
    };
  }
  if (live.sharedPair === null) throw new Error("A live page needs the pair in its shared form.");
  const connection = createConnectionRuntime({
    pair,
    sharedPair: live.sharedPair,
    environment: {
      indexerUrl: configuration.indexerUrl,
      backendUrl: configuration.backendUrl,
      msgboardIndexerUrl: configuration.msgboardIndexerUrl,
      archiveUrl: configuration.archiveUrl,
      msgboardUrl: configuration.msgboardUrl,
      rpcUrls: configuration.rpcUrls,
    },
    user: loadUserConnections(live.storage ?? null),
    ...(live.createConnection === undefined ? {} : { createConnection: live.createConnection }),
    ...(live.connectionOptions === undefined ? {} : { connectionOptions: live.connectionOptions }),
  });
  return {
    ...base,
    dataSource: connection.dataSource,
    indexer: createFallbackIndexerClient(connection),
    chainAccess: connection.chainAccess,
    connection,
    now: () => Math.floor(Date.now() / 1000),
  };
};

const ServicesContext = createContext<Services | null>(null);

/** Props of {@link ServicesProvider}. */
export type ServicesProviderProps = { readonly services: Services; readonly children: ReactNode };

/**
 * Provides the services.
 *
 * @param props The services and the children.
 */
export const ServicesProvider = ({ services, children }: ServicesProviderProps) => (
  <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
);

/**
 * The services of the page.
 *
 * @throws When no provider wraps the component.
 */
export const useServices = (): Services => {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error("useServices needs a ServicesProvider above it.");
  return services;
};
