/**
 * The chain and beacon reads of the route steps: the fork registry's own light client, whether a bridge takes deposits,
 * the gas price, a simulated gas, and the fork facts of a registry. One implementation over viem and the global fetch; a
 * test passes its own (`BackendModuleContext.stepChain`).
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import {
  SIMULATION_ACCOUNT,
  activeForkVersion,
  beaconLightClientAbi,
  fetchSourceForks,
  forkRegistryAbi,
  messageBridgeAbi,
  readForkObservation,
  type GateChainClient,
  type PairSide,
} from "@zk-bridge/shared";
import type { ObservationFacts } from "../seal/observe-watch.ts";
import type { StartingHead } from "@zk-bridge/shared/prover";

/** The fork registry's own light client (a light client of the chain on the chain itself). */
export type RegistryLightClient = {
  readonly lightClient: Address;
  readonly head: StartingHead;
  readonly programKey: Hex;
  readonly slotsPerPeriod: number;
  readonly genesisTime: number;
  readonly secondsPerSlot: number;
};

/** The time of a slot of a light client, in milliseconds since 1970. */
export const slotTimeOf = (state: Pick<RegistryLightClient, "genesisTime" | "secondsPerSlot">, slot: number): number => (state.genesisTime + slot * state.secondsPerSlot) * 1000;

/** One sync committee period of a light client, in milliseconds. */
export const periodMillisecondsOf = (state: Pick<RegistryLightClient, "slotsPerPeriod" | "secondsPerSlot">): number => state.slotsPerPeriod * state.secondsPerSlot * 1000;

/** The reads. Each throws when its endpoint fails. */
export interface StepChainReads {
  /** The light client of a registry: its head, the root and the next committee hash of the head, its program key and its clock. */
  registryLightClient(side: PairSide, registry: Address): Promise<RegistryLightClient>;
  /** Whether the bridge of a side takes deposits (`depositsOpen()`). */
  depositsOpen(side: PairSide): Promise<boolean>;
  /** The gas price of a side now, in wei. */
  gasPrice(side: PairSide): Promise<bigint>;
  /** The gas of a call from a neutral account, or null when it reverts. */
  simulate(side: PairSide, call: { readonly to: Address; readonly data: Hex }): Promise<bigint | null>;
  /** The fork version the chain runs (from its beacon node) and what its registry last observed. */
  forkFacts(side: PairSide, registry: Address, nowMilliseconds: number): Promise<ObservationFacts>;
}

/** The reads over viem (each side's RPC endpoint) and the global fetch (its beacon node). */
export function createStepChainReads(input: { readonly clientOf?: (side: PairSide) => PublicClient } = {}): StepChainReads {
  const clients = new Map<number, PublicClient>();
  const clientOf =
    input.clientOf ??
    ((side: PairSide) => {
      const known = clients.get(side.chainId);
      if (known !== undefined) return known;
      const created = createPublicClient({ transport: http(side.rpcUrl) }) as PublicClient;
      clients.set(side.chainId, created);
      return created;
    });
  return {
    async registryLightClient(side, registry) {
      const client = clientOf(side);
      const lightClient = (await client.readContract({ address: registry, abi: forkRegistryAbi, functionName: "lightClient" })) as Address;
      const blockNumber = await client.getBlockNumber();
      const read = (functionName: "head" | "slotsPerPeriod" | "genesisTime" | "secondsPerSlot" | "programVKey") =>
        client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName, blockNumber }) as Promise<bigint | number | Hex>;
      const [head, slotsPerPeriod, genesisTime, secondsPerSlot, programKey] = await Promise.all([read("head"), read("slotsPerPeriod"), read("genesisTime"), read("secondsPerSlot"), read("programVKey")]);
      const slot = Number(head);
      const period = BigInt(slot) / BigInt(slotsPerPeriod);
      const [root, nextCommitteeHash] = await Promise.all([
        client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "headers", args: [BigInt(slot)], blockNumber }) as Promise<Hex>,
        client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "syncCommittees", args: [period + 1n], blockNumber }) as Promise<Hex>,
      ]);
      return { lightClient, head: { slot, root, nextCommitteeHash }, programKey: programKey as Hex, slotsPerPeriod: Number(slotsPerPeriod), genesisTime: Number(genesisTime), secondsPerSlot: Number(secondsPerSlot) };
    },
    async depositsOpen(side) {
      return (await clientOf(side).readContract({ address: side.contracts.bridge, abi: messageBridgeAbi, functionName: "depositsOpen" })) as boolean;
    },
    gasPrice: (side) => clientOf(side).getGasPrice(),
    async simulate(side, call) {
      try {
        return await clientOf(side).estimateGas({ account: SIMULATION_ACCOUNT, to: call.to, data: call.data });
      } catch {
        return null;
      }
    },
    async forkFacts(side, registry, nowMilliseconds) {
      const forks = await fetchSourceForks({ urls: side.beaconUrl === null ? [] : [side.beaconUrl] });
      if (forks.kind !== "known") throw new Error(forks.reason);
      const observed = await readForkObservation({ client: clientOf(side) as unknown as GateChainClient, registry });
      return { activeVersion: activeForkVersion(forks.forks, forks.clock, Math.floor(nowMilliseconds / 1000)), registry: observed };
    },
  };
}
