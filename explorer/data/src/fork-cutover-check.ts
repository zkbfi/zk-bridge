/**
 * The reads behind the fork cutover (`decideForkCutover` of `@zkb/core`): the head of the light client that follows a source
 * chain, the verdict for a route, the state of the fork gate and the fork registry of a chain, and the offer of the seal
 * call. One implementation for the dapp, the terminal and the status service.
 */
import { encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { compactMultiproofDescriptor, decideForkCutover, encodeForkEvidence, forkEvidenceFromMultiproof, forkProofGindices, isAllowedShape, normalizeAddress, type ForkCutoverVerdict, type SourceForks } from "@zkb/core";
import { beaconForkGateAbi, beaconLightClientAbi, forkRegistryAbi } from "./abis/index.js";
import { fetchSourceForks } from "./fork-cutover-source.js";
import { GATE_MODES, readEvidenceHeader, readGateStatus, type BeaconProofSource, type GateChainClient, type GateMode } from "./gate-evidence.js";

/** The finalized head slot that a light client stores, or null when it cannot be read. */
export async function readLightClientHead(client: Pick<PublicClient, "readContract">, lightClient: Address): Promise<bigint | null> {
  try {
    return BigInt((await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "head" })) as bigint);
  } catch {
    return null;
  }
}

/** The light client that follows a source chain: it lives on the destination chain. */
export type CutoverRoute = { readonly destinationChainId: number; readonly lightClient: Address };

/** The question a program asks before a send from a chain: is the route open, paused or unknown? */
export type ForkCutoverCheck = (sourceChainId: number) => Promise<ForkCutoverVerdict>;

/** What the decision reads from the chains: the source's beacon schedule and the destination light client's head. */
export type CutoverFacts = { readonly destinationChainId: number; readonly source: SourceForks; readonly lightClientHead: bigint | null };

/** Where the cutover facts are read from. */
export type CutoverReaders = {
  /** The route that a send from a chain takes, or null when the chain has none. */
  readonly routeOf: (sourceChainId: number) => CutoverRoute | null;
  /** A client of a chain that reads contracts. */
  readonly clientFor: (chainId: number) => Pick<PublicClient, "readContract">;
  /** The beacon endpoints of a chain in force now, in order. */
  readonly beaconUrlsFor: (chainId: number) => readonly string[];
  /** The `fetch` to use. Default: the global one. */
  readonly fetch?: typeof fetch;
};

/**
 * Reads what the decision needs for a send from a chain: the beacon node's fork schedule and the light client head. A program
 * that shows a countdown keeps these and decides again at each tick with `decideForkCutover`.
 *
 * @returns The facts, or null when the chain has no route.
 */
export async function readCutoverFacts(input: CutoverReaders & { readonly sourceChainId: number }): Promise<CutoverFacts | null> {
  const route = input.routeOf(input.sourceChainId);
  if (route === null) return null;
  const [source, lightClientHead] = await Promise.all([
    fetchSourceForks({ urls: input.beaconUrlsFor(input.sourceChainId), ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }),
    readLightClientHead(input.clientFor(route.destinationChainId), route.lightClient),
  ]);
  return { destinationChainId: route.destinationChainId, source, lightClientHead };
}

/**
 * The fork cutover check of a program that sends: {@link readCutoverFacts} and `decideForkCutover`. It sends nothing.
 *
 * @param input.nowSeconds The clock in seconds since 1970. Default: the system clock.
 */
export function createForkCutoverCheck(input: CutoverReaders & { readonly nowSeconds?: () => number }): ForkCutoverCheck {
  const now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  return async (sourceChainId) => {
    const facts = await readCutoverFacts({ ...input, sourceChainId });
    if (facts === null) return { kind: "open", next: null, pausesAt: null, secondsToPause: null };
    return decideForkCutover({ sourceChainId, ...facts, nowSeconds: now() });
  };
}

/** What a gate says about forks, read without the beacon chain: its mode, whether it is sealed, and its registry. */
export type ForkGateState = {
  readonly gate: Address;
  readonly mode: GateMode;
  readonly enforcing: boolean;
  readonly sealed: boolean;
  /** The `ForkRegistry` the gate consults, or null when it has none. */
  readonly forkRegistry: Address | null;
};

/** What a `ForkRegistry` last observed: the fork version, the state shape and the slot. */
export type ForkObservation = {
  readonly registry: Address;
  readonly version: Hex;
  readonly shape: number;
  readonly slot: bigint;
  /** Whether the shape is one that the gate allows. A registry that has observed nothing reads version 0x00000000 and shape 0. */
  readonly shapeAllowed: boolean;
  /** Whether anything was observed: a version other than zero. */
  readonly observed: boolean;
};

/**
 * Reads the fork state of a gate.
 *
 * @param input.client A client of the chain of the gate.
 * @param input.gate The `BeaconForkGate` address.
 */
export async function readForkGateState(input: { readonly client: Pick<PublicClient, "readContract">; readonly gate: Address }): Promise<ForkGateState> {
  const gate = normalizeAddress(input.gate);
  const read = (functionName: string): Promise<unknown> => input.client.readContract({ address: gate, abi: beaconForkGateAbi, functionName } as never);
  const [mode, enforcing, sealed, registry] = await Promise.all(["mode", "enforcing", "isSealed", "forkRegistry"].map(read));
  const modeName = GATE_MODES[Number(mode)];
  if (modeName === undefined) throw new Error(`the gate reports an unknown mode ${String(mode)}`);
  const registryAddress = normalizeAddress(registry as string);
  return { gate, mode: modeName, enforcing: enforcing as boolean, sealed: sealed as boolean, forkRegistry: registryAddress === zeroAddress ? null : registryAddress };
}

/**
 * Reads what a fork registry last observed (`latestObserved()`).
 *
 * @param input.client A client of the chain of the registry.
 * @param input.registry The `ForkRegistry` address.
 */
export async function readForkObservation(input: { readonly client: Pick<PublicClient, "readContract">; readonly registry: Address }): Promise<ForkObservation> {
  const registry = normalizeAddress(input.registry);
  const [version, shape, slot] = (await input.client.readContract({ address: registry, abi: forkRegistryAbi, functionName: "latestObserved" })) as readonly [Hex, number, bigint];
  return { registry, version, shape: Number(shape), slot: BigInt(slot), shapeAllowed: isAllowedShape(Number(shape)), observed: BigInt(version) !== 0n };
}

/** The disallowed depths that a seal proof is tried at, in order. Depth 8 is the next after the allowed 5, 6 and 7. */
export const SEAL_DEPTHS: readonly number[] = [8, 9];

/** The address that simulates a call when no account is connected: the call needs no balance. */
export const SIMULATION_ACCOUNT: Address = "0x000000000000000000000000000000000000dEaD";

/** The outcome of {@link offerSeal}. */
export type SealOffer =
  /** The gate is sealed already. */
  | { readonly kind: "sealed" }
  /** `seal(evidence)` simulated without a revert: it can be sent now. `via` names the evidence. */
  | { readonly kind: "ready"; readonly call: { readonly to: Address; readonly data: Hex }; readonly gas: bigint; readonly via: "registry" | "beacon" }
  /** No call would succeed now. `reason` says what was tried. */
  | { readonly kind: "unavailable"; readonly reason: string };

const sealData = (evidence: Hex): Hex => encodeFunctionData({ abi: beaconForkGateAbi, functionName: "seal", args: [evidence] });

/**
 * Whether `seal(evidence)` would succeed now, by simulating it. In a mode with a registry, empty evidence is tried first:
 * it succeeds when the registry shows a shape outside the allowed set. When a beacon node is given, evidence of a state of
 * a disallowed depth is built (the same header and proof path as the confirmation) and simulated. Nothing is sent.
 *
 * @param input.client A client of the chain of the gate.
 * @param input.gate The `BeaconForkGate` address.
 * @param input.account The sender of the simulation.
 * @param input.beacon The beacon node of that chain, or absent to try the registry path only.
 */
export async function offerSeal(input: {
  readonly client: GateChainClient;
  readonly gate: Address;
  readonly account: Address;
  readonly beacon?: BeaconProofSource;
}): Promise<SealOffer> {
  const gate = normalizeAddress(input.gate);
  const state = await readForkGateState({ client: input.client, gate });
  if (state.sealed) return { kind: "sealed" };
  const tried: string[] = [];
  const simulate = async (data: Hex, blockNumber?: bigint): Promise<bigint | null> => {
    try {
      return await input.client.estimateGas({ account: input.account, to: gate, data, ...(blockNumber === undefined ? {} : { blockNumber }) });
    } catch {
      return null;
    }
  };
  if (state.forkRegistry !== null) {
    const data = sealData("0x");
    const gas = await simulate(data);
    if (gas !== null) return { kind: "ready", call: { to: gate, data }, gas, via: "registry" };
    tried.push("the registry shows no shape outside the allowed set");
  }
  if (input.beacon === undefined) return { kind: "unavailable", reason: tried.length === 0 ? "no beacon endpoint is set to look for a state of a disallowed shape" : tried.join("; ") };
  try {
    const status = await readGateStatus({ client: input.client, gate });
    const { block, header } = await readEvidenceHeader({ client: input.client, beacon: input.beacon, status });
    for (const depth of SEAL_DEPTHS) {
      const descriptor = compactMultiproofDescriptor(forkProofGindices(depth));
      let encoded: Hex;
      try {
        const { leaves } = await input.beacon.stateProof(header.stateRoot, descriptor);
        encoded = encodeForkEvidence(forkEvidenceFromMultiproof({ timestamp: block.timestamp, header, shape: depth, descriptor, leaves }));
      } catch {
        continue;
      }
      const data = sealData(encoded);
      const gas = await simulate(data, block.number);
      if (gas !== null) return { kind: "ready", call: { to: gate, data }, gas, via: "beacon" };
    }
    tried.push("the beacon state has no disallowed shape");
  } catch (error) {
    tried.push(`the beacon evidence could not be built (${(error as Error).message})`);
  }
  return { kind: "unavailable", reason: tried.join("; ") };
}
