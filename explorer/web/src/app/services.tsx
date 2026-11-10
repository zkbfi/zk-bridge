/**
 * The data and chain access of the page, built once from the configuration. Every component reads them through
 * `useServices`, so a test hands in fixtures and the page never reaches the network.
 */
import { createFixtureExploreSource } from "../explore/explore-fixture";
import { createIndexerExploreSource, type ExploreSource } from "../explore/explore-source";
import { createContext, useContext, type ReactNode } from "react";
import type { ChainAccess } from "@terminal/chain/chain-access";
import { createFixtureChainAccess } from "@terminal/chain/fixture-chain-access";
import { knownPairIds } from "@terminal/config/pairs";
import type { DataSource } from "@terminal/data/data-source";
import { createFixtureDataSource, FIXTURE_NOW } from "@terminal/data/fixtures";
import { createConnectionRuntime, type ConnectionRuntime } from "@terminal/data/connection-runtime";
import type { PairConfig } from "@terminal/model/types";
import { beaconLightClientAbi, migrateBoardUrls, type ExplorerConnectionInput, type ExplorerConnection, type Pair } from "@zk-bridge/shared";
import { loadUserConnections, type ConnectionStorage } from "../config/connection-storage";
import type { WebConfiguration } from "../config/environment";
import { createFixtureIndexerClient } from "../data/fixture-indexer-client";
import { createFallbackIndexerClient, type IndexerClient } from "../data/indexer-client";
import { NO_ENDPOINTS, realPanelTransport, type PanelEndpoints, type PanelTransport } from "../views/proof-panel-model";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { createProber, fixtureProber, type Prober } from "./service-probe";
import { createForkPort, fixtureForkPort, type ForkPort } from "../fork/fork-port";

/** Everything that a component reads from outside React. */
export type Services = {
  readonly configuration: WebConfiguration;
  readonly pair: PairConfig;
  /** The pairs that the page knows by name, configured or not. */
  /** Every pair the explorer knows. `configured`: this release has a deployment for it. `active`: the page runs on it. */
  readonly knownPairs: readonly { readonly id: string; readonly label: string; readonly configured: boolean; readonly active: boolean }[];
  readonly dataSource: DataSource;
  readonly indexer: IndexerClient;
  /** What Explore reads from the indexer beyond the data source. */
  readonly explore: ExploreSource;
  readonly chainAccess: ChainAccess;
  /** The live connections with their fallback, or null on a fixture page. */
  readonly connection: ConnectionRuntime | null;
  /** The endpoints in force now: the backend, the msgboard indexer, the archive and the msgboard node. Each one is null when unset. */
  readonly endpoints: () => PanelEndpoints;
  /** The network access of the proof panel. A test passes fakes. */
  readonly transport: PanelTransport;
  /** Reads the slot of the head that the light client on a chain stores now. It reads the chain, never the indexer. */
  readonly readLightClientHead: (chainId: number) => Promise<bigint>;
  /** The live check of an outside service, shared by Explore's Services rows and Settings. The sample page answers without a network. */
  readonly probe: Prober;
  /** What the fork surfaces read: the cutover facts, the gate and registry state, the seal offer. */
  readonly forks: ForkPort;
  /** The clock in unix seconds. The fixture page pins it so that the sample data stays the same. */
  readonly now: () => number;
};

const KNOWN_PAIR_LABELS: Readonly<Record<string, string>> = {
  "eth-pls": "Ethereum and PulseChain",
  "sepolia-pls943": "Sepolia and PulseChain testnet v4",
};

const knownPairsOf = (configuration: WebConfiguration, pair: PairConfig): Services["knownPairs"] =>
  knownPairIds().map((id) => ({
    id,
    label: KNOWN_PAIR_LABELS[id] ?? id,
    configured: id === pair.id || configuration.availablePairs.includes(id),
    active: id === pair.id,
  }));

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

/** The part of a viem public client that reads a contract. The flow client of a live page has it. */
type ContractReader = {
  readContract(parameters: { abi: typeof beaconLightClientAbi; address: `0x${string}`; functionName: "head" }): Promise<bigint>;
};

const readHeadSlot = async (connection: ConnectionRuntime, pair: PairConfig, chainId: number): Promise<bigint> => {
  const chain = [pair.first, pair.second].find((candidate) => candidate.chainId === chainId);
  if (chain === undefined) throw new Error(`Chain ${chainId} is not in the pair.`);
  // The flow client of a live page is a viem public client, so it reads contracts. Its type names only what the flow needs.
  const reader = connection.chainAccess.flowClient(chainId) as unknown as ContractReader;
  return reader.readContract({ abi: beaconLightClientAbi, address: chain.contracts.lightClient, functionName: "head" });
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
  const base = { configuration, pair, knownPairs: knownPairsOf(configuration, pair) };
  if (configuration.dataMode === "fixture") {
    return {
      ...base,
      dataSource: createFixtureDataSource(),
      indexer: createFixtureIndexerClient({ pair }),
      explore: createFixtureExploreSource(),
      chainAccess: createFixtureChainAccess(pair),
      connection: null,
      endpoints: () => NO_ENDPOINTS,
      transport: realPanelTransport,
      readLightClientHead: async () => {
        throw new Error("The sample page reads no chain.");
      },
      probe: fixtureProber,
      forks: fixtureForkPort,
      now: () => FIXTURE_NOW,
    };
  }
  if (live.sharedPair === null) throw new Error("A live page needs the pair in its shared form.");
  const connection = createConnectionRuntime({
    fallbackRpcUrl: defaultRpcUrl,
    pair,
    sharedPair: live.sharedPair,
    environment: {
      indexerUrl: configuration.indexerUrl,
      backendUrl: configuration.backendUrl,
      msgboardIndexerUrl: configuration.msgboardIndexerUrl,
      archiveUrl: configuration.archiveUrl,
      msgboardUrl: configuration.msgboardUrl,
      rpcUrls: configuration.rpcUrls,
      beaconUrls: configuration.beaconUrls,
    },
    // A saved single msgboard node becomes each chain's (owner, quote 87).
    user: migrateBoardUrls(loadUserConnections(live.storage ?? null), [pair.first.chainId, pair.second.chainId]),
    ...(live.createConnection === undefined ? {} : { createConnection: live.createConnection }),
    ...(live.connectionOptions === undefined ? {} : { connectionOptions: live.connectionOptions }),
  });
  return {
    ...base,
    dataSource: connection.dataSource,
    indexer: createFallbackIndexerClient(connection),
    explore: createIndexerExploreSource(() => connection.resolved().indexerUrl?.value ?? null),
    chainAccess: connection.chainAccess,
    connection,
    endpoints: () => connection.resolved(),
    transport: realPanelTransport,
    readLightClientHead: (chainId) => readHeadSlot(connection, pair, chainId),
    probe: createProber(),
    forks: createForkPort({ pair, connection }),
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
