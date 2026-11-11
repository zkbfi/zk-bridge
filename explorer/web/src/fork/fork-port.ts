/**
 * What the fork surfaces read: the cutover facts of a route, the gate and registry state of a chain, the offer of the
 * seal call, and the offer of the backend's newest fork observation proof. A live page reads the chains, the beacon nodes
 * and the backend of Settings; the sample page reads nothing. Every function is the shared implementation of
 * `@zk-bridge/shared` (`readCutoverFacts`, `readForkGateState`, `offerSeal`, `offerObservation`).
 */
import type { Address } from "viem";
import { createBackendClient } from "@zk-bridge/shared/backend-client";
import { postJsonResponse } from "@zk-bridge/shared/msgboard-http";
import {
  createBeaconProofSource,
  fetchJsonResponse,
  forkRegistryAbi,
  offerObservation,
  fallbackBeaconSource,
  NO_BEACON_ENDPOINT_TEXT,
  offerSeal,
  readCutoverFacts,
  readForkGateState,
  readForkObservation,
  type CutoverFacts,
  type ForkGateState,
  type ForkObservation,
  type ForkScheduleStore,
  type GateChainClient,
  type JsonFetcher,
  type ObservationOffer,
  type SealOffer,
} from "@zk-bridge/shared";
import { cutoverRouteOf } from "@terminal/app/fork-cutover";
import { beaconUrlsFor } from "@terminal/config/default-beacon";
import type { ConnectionRuntime } from "@terminal/data/connection-runtime";
import type { PairConfig } from "@terminal/model/types";

/** The gate and the registry of one chain. Each is null when it cannot be read or the chain has none. */
export type ForkChainState = { readonly gate: ForkGateState | null; readonly observation: ForkObservation | null };

/** The reads of the fork surfaces. */
export type ForkPort = {
  /** What the decision reads for a send from a chain, or null when nothing is read (the sample page) or the chain has no route. */
  facts(sourceChainId: number): Promise<CutoverFacts | null>;
  /** The gate and the registry of a chain. */
  chainState(chainId: number): Promise<ForkChainState>;
  /** Whether `seal(evidence)` would succeed now on the gate of a chain, from this account. */
  sealOffer(chainId: number, account: Address): Promise<SealOffer>;
  /**
   * Whether `observe(proof, publicValues)` of the backend's newest observation proof of a chain would succeed now on its
   * registry and add a newer slot, from this account.
   */
  observeOffer(chainId: number, registry: Address, account: Address): Promise<ObservationOffer>;
  /**
   * The `ForkRegistry` of a chain and its light client, from trusted sources only: the registry of the deployment, else
   * the one the chain's configured gate names on chain; the light client read with `lightClient()` from that registry.
   * Null when the chain has none or a read fails. A backend answer never names them.
   */
  registryOf(chainId: number): Promise<{ readonly registry: Address; readonly lightClient: Address } | null>;
};

/** The sample page: it reads no chain. */
export const fixtureForkPort: ForkPort = {
  facts: async () => null,
  chainState: async () => ({ gate: null, observation: null }),
  sealOffer: async () => ({ kind: "unavailable", reason: "the sample page reads no chain" }),
  observeOffer: async () => ({ kind: "unavailable", reason: "the sample page reads no chain" }),
  registryOf: async () => null,
};

const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/**
 * The fork port of a live page.
 *
 * @param input.pair The pair.
 * @param input.connection The live connections: the flow clients and the beacon endpoints in force.
 */
export const createForkPort = (input: {
  readonly pair: PairConfig;
  readonly connection: Pick<ConnectionRuntime, "resolved" | "chainAccess">;
  /** Where the last fork schedule of each chain is kept, for when the beacon node does not answer. Absent: only the bundled copy. */
  readonly scheduleStore?: ForkScheduleStore | undefined;
  /** How the backend is read. Default: the page's JSON fetch. */
  readonly fetchJson?: JsonFetcher;
}): ForkPort => {
  const { pair, connection } = input;
  // The flow client of a live page is a viem public client; its type names only what the flow needs.
  const clientFor = (chainId: number) => connection.chainAccess.flowClient(chainId) as unknown as GateChainClient;
  const chainOf = (chainId: number) => (pair.first.chainId === chainId ? pair.first : pair.second);
  return {
    facts: (sourceChainId) =>
      readCutoverFacts({
        sourceChainId,
        routeOf: cutoverRouteOf(pair),
        clientFor,
        beaconUrlsFor: (chainId) => beaconUrlsFor(connection.resolved(), chainId),
        scheduleStore: input.scheduleStore,
      }),
    chainState: async (chainId) => {
      const chain = chainOf(chainId);
      const gate = chain.contracts.gate === null ? null : await attempt(() => readForkGateState({ client: clientFor(chainId), gate: chain.contracts.gate as Address }));
      const registry = chain.contracts.forkRegistry ?? gate?.forkRegistry ?? null;
      const observation = registry === null ? null : await attempt(() => readForkObservation({ client: clientFor(chainId), registry }));
      return { gate, observation };
    },
    registryOf: async (chainId) => {
      const chain = chainOf(chainId);
      const gate = (chain.contracts.forkRegistry ?? null) !== null || chain.contracts.gate === null ? null : await attempt(() => readForkGateState({ client: clientFor(chainId), gate: chain.contracts.gate as Address }));
      const registry = chain.contracts.forkRegistry ?? gate?.forkRegistry ?? null;
      if (registry === null) return null;
      const lightClient = await attempt(() => clientFor(chainId).readContract({ address: registry, abi: forkRegistryAbi, functionName: "lightClient" }) as Promise<Address>);
      return lightClient === null ? null : { registry, lightClient };
    },
    sealOffer: async (chainId, account) => {
      const chain = chainOf(chainId);
      if (chain.contracts.gate === null) return { kind: "unavailable", reason: `${chain.name} has no deposit gate` };
      const sources = beaconUrlsFor(connection.resolved(), chainId).map((url) => createBeaconProofSource({ url }));
      const beacon = fallbackBeaconSource(sources, { noneText: `${NO_BEACON_ENDPOINT_TEXT} (Settings, Beacon endpoints)` });
      return offerSeal({ client: clientFor(chainId), gate: chain.contracts.gate, account, beacon });
    },
    observeOffer: async (chainId, registry, account) => {
      const backend = connection.resolved().backendUrl;
      if (backend === null) return { kind: "unavailable", reason: "no backend is set (Settings, Backend), so no observation proof can be read" };
      const client = createBackendClient({ baseUrl: backend.value, fetchJson: input.fetchJson ?? fetchJsonResponse, postJson: postJsonResponse });
      let observation;
      try {
        observation = await client.latestForkObservation(chainId);
      } catch (error) {
        return { kind: "unavailable", reason: `the backend did not give an observation proof (${(error as Error).message})` };
      }
      return offerObservation({ client: clientFor(chainId), registry, observation, account });
    },
  };
};
