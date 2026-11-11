/**
 * What the fork surfaces read: the cutover facts of a route, the gate and registry state of a chain, and the offer of the
 * seal call. A live page reads the chains and the beacon nodes of Settings; the sample page reads nothing. Every function
 * is the shared implementation of `@zk-bridge/shared` (`readCutoverFacts`, `readForkGateState`, `offerSeal`).
 */
import type { Address } from "viem";
import {
  createBeaconProofSource,
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
};

/** The sample page: it reads no chain. */
export const fixtureForkPort: ForkPort = {
  facts: async () => null,
  chainState: async () => ({ gate: null, observation: null }),
  sealOffer: async () => ({ kind: "unavailable", reason: "the sample page reads no chain" }),
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
    sealOffer: async (chainId, account) => {
      const chain = chainOf(chainId);
      if (chain.contracts.gate === null) return { kind: "unavailable", reason: `${chain.name} has no deposit gate` };
      const sources = beaconUrlsFor(connection.resolved(), chainId).map((url) => createBeaconProofSource({ url }));
      const beacon = fallbackBeaconSource(sources, { noneText: `${NO_BEACON_ENDPOINT_TEXT} (Settings, Beacon endpoints)` });
      return offerSeal({ client: clientFor(chainId), gate: chain.contracts.gate, account, beacon });
    },
  };
};
