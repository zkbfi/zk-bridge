/**
 * The data and chain access of the page, built once from the configuration. Every component reads them through
 * `useServices`, so a test hands in fixtures and the page never reaches the network.
 */
import { createContext, useContext, type ReactNode } from "react";
import { createRpcChainAccess, type ChainAccess } from "@terminal/chain/chain-access";
import { createFixtureChainAccess } from "@terminal/chain/fixture-chain-access";
import { knownPairIds } from "@terminal/config/pairs";
import type { DataSource } from "@terminal/data/data-source";
import { createFixtureDataSource, FIXTURE_NOW } from "@terminal/data/fixtures";
import { createIndexerDataSource } from "@terminal/data/indexer-data-source";
import type { PairConfig } from "@terminal/model/types";
import type { WebConfiguration } from "../config/environment";
import { createFixtureIndexerClient } from "../data/fixture-indexer-client";
import { createIndexerClient, type IndexerClient } from "../data/indexer-client";

/** Everything that a component reads from outside React. */
export type Services = {
  readonly configuration: WebConfiguration;
  readonly pair: PairConfig;
  /** The pairs that the page knows by name, configured or not. */
  readonly knownPairs: readonly { readonly id: string; readonly label: string; readonly configured: boolean }[];
  readonly dataSource: DataSource;
  readonly indexer: IndexerClient;
  readonly chainAccess: ChainAccess;
  /** The clock in unix seconds. The fixture page pins it so that the sample data stays the same. */
  readonly now: () => number;
};

const KNOWN_PAIR_LABELS: Readonly<Record<string, string>> = {
  "eth-pls": "Ethereum and PulseChain",
  "sepolia-pls943": "Sepolia and PulseChain testnet v4",
};

const knownPairsOf = (pair: PairConfig): Services["knownPairs"] =>
  knownPairIds().map((id) => ({ id, label: KNOWN_PAIR_LABELS[id] ?? id, configured: id === pair.id }));

/**
 * Builds the services for a configuration and a pair.
 *
 * @param configuration The page configuration.
 * @param pair The configured pair.
 */
export const createServices = (configuration: WebConfiguration, pair: PairConfig): Services => {
  const base = { configuration, pair, knownPairs: knownPairsOf(pair) };
  if (configuration.dataMode === "fixture") {
    return {
      ...base,
      dataSource: createFixtureDataSource(),
      indexer: createFixtureIndexerClient({ pair }),
      chainAccess: createFixtureChainAccess(pair),
      now: () => FIXTURE_NOW,
    };
  }
  const environment = Object.fromEntries(
    [pair.first, pair.second].map((chain) => [chain.rpcEnvironmentVariable, configuration.rpcUrls[chain.chainId]]),
  );
  return {
    ...base,
    dataSource: createIndexerDataSource({ baseUrl: configuration.indexerUrl, pair }),
    indexer: createIndexerClient({ baseUrl: configuration.indexerUrl }),
    chainAccess: createRpcChainAccess(pair, environment),
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
