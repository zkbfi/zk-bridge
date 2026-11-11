// Fakes of the route steps: a pair whose second side has a fork registry, the chain reads, the provers and the archive.
import type { Address, Hex } from "viem";
import type { ForkObservation, ForkObservationPackage, Pair } from "@zk-bridge/shared";
import type { ForkObservationProver, HeadProver, ObservationOutcome, OpeningPackage, OpeningProver, ProveOutcome } from "@zk-bridge/shared/prover";
import type { ArchiveService } from "../src/archive/build.ts";
import type { RegistryLightClient, StepChainReads } from "../src/steps/chain.ts";
import { makeProofPackage, PAIR } from "./support.ts";

export const REGISTRY: Address = "0x4444444444444444444444444444444444444444";
export const REGISTRY_LIGHT_CLIENT: Address = "0x5555555555555555555555555555555555555555";
export const V1: Hex = "0x0000036a";
export const V2: Hex = "0x0000036b";
export const MESSAGE: Hex = `0x${"cd".repeat(32)}`;

/** The pair of the tests, with a fork registry on PulseChain (the second side). */
export const REGISTRY_PAIR: Pair = {
  name: PAIR.name,
  sides: [PAIR.sides[0], { ...PAIR.sides[1], contracts: { ...PAIR.sides[1].contracts, forkRegistry: REGISTRY } }],
};

/** The registry's light client: head slot 1000 on a 10 s clock from 0, 8192 slots a period (22.75 h). */
export const registryState = (slot = 1_000): RegistryLightClient => ({
  lightClient: REGISTRY_LIGHT_CLIENT,
  head: { slot, root: `0x${"77".repeat(32)}`, nextCommitteeHash: `0x${"00".repeat(32)}` },
  programKey: `0x${"88".repeat(32)}`,
  slotsPerPeriod: 8192,
  genesisTime: 0,
  secondsPerSlot: 10,
});

export const registryAt = (version: Hex, slot: bigint): ForkObservation => ({ registry: REGISTRY, version, shape: 5, slot, shapeAllowed: true, observed: BigInt(version) !== 0n });

/** A fork observation package of version V2. */
export const observationPackage = (overrides: Partial<ForkObservationPackage> = {}): ForkObservationPackage => ({
  schemaVersion: 1,
  route: "pulsechain_to_ethereum",
  chainId: 369,
  registry: REGISTRY,
  lightClient: REGISTRY_LIGHT_CLIENT,
  programKey: `0x${"66".repeat(32)}`,
  startHeadSlot: 100,
  observedVersion: V2,
  shape: 5,
  observedAttestedSlot: 900,
  foldSteps: 3,
  publicValues: `0x${"00".repeat(256)}`,
  proof: "0x1234",
  observeCalldata: "0xabcd",
  backend: "remote",
  createdAt: "2026-11-11T00:00:00Z",
  ...overrides,
});

/** Chain reads that answer from fields a test changes. An Error value makes the read throw. */
export function fakeChain() {
  const state = {
    registry: registryState() as RegistryLightClient | Error,
    depositsOpen: false as boolean | Error,
    gasPrice: 10n as bigint | Error,
    simulate: 100_000n as bigint | null,
    facts: { activeVersion: V2, registry: registryAt(V1, 50n) } as { activeVersion: Hex | null; registry: ForkObservation } | Error,
  };
  const value = async <T>(answer: T | Error): Promise<T> => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const reads: StepChainReads = {
    registryLightClient: async () => value(state.registry),
    depositsOpen: async () => value(state.depositsOpen),
    gasPrice: async () => value(state.gasPrice),
    simulate: async () => state.simulate,
    forkFacts: async () => value(state.facts),
  };
  return { state, reads };
}

/** A prover whose calls wait until the test settles them. */
export function waitingProver<Result>() {
  const calls: unknown[] = [];
  const waiting: Array<{ resolve: (value: Result) => void; reject: (error: unknown) => void }> = [];
  return {
    calls,
    call(request: unknown): Promise<Result> {
      calls.push(request);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    settle(value: Result) {
      for (const entry of waiting.splice(0)) entry.resolve(value);
    },
    fail(error: unknown) {
      for (const entry of waiting.splice(0)) entry.reject(error);
    },
  };
}

/** The three provers of the steps over waiting fakes. */
export function stepProvers() {
  const head = waitingProver<ProveOutcome>();
  const observation = waitingProver<ObservationOutcome>();
  const opening = waitingProver<OpeningPackage>();
  const headProver: HeadProver = { proveFromHead: (request) => head.call(request) };
  const observationProver: ForkObservationProver = { forkObservation: (request) => observation.call(request) };
  const openingProver: OpeningProver = { openingProof: (request) => opening.call(request) };
  return { head, observation, opening, headProver, observationProver, openingProver };
}

/** A proof of the registry's light client from `startSlot`. */
export const registryProof = (startSlot = 1_000): ProveOutcome => ({ kind: "proof", proofPackage: { ...makeProofPackage(startSlot, startSlot + 64), programKey: `0x${"88".repeat(32)}`, publicValues: "0xabcd", proof: "0x1234" }, timing: { total_ms: 60_000 } as never });

/** An opening package for the bridge on Ethereum (the destination of second-to-first). */
export const openingPackage = (overrides: Partial<OpeningPackage> = {}): OpeningPackage => ({
  route: "ethereum_to_pulsechain",
  to: PAIR.sides[0].contracts.bridge,
  calldata: "0xfeed",
  chainId: 1,
  depositsOpen: false,
  remoteBlockNumber: 77,
  proof: { remoteSlot: 10, storedSlot: 20 },
  ...overrides,
});

/** An archive that holds the evidence a test puts in, and builds it on a cycle when `builds` is set. */
export function fakeArchive() {
  const evidence = new Map<string, string>();
  const state = { builds: null as { messageId: string; text: string } | null, cycles: 0, hold: null as Promise<void> | null };
  const archive: ArchiveService = {
    async runCycle() {
      state.cycles += 1;
      await state.hold;
      if (state.builds !== null) evidence.set(state.builds.messageId, state.builds.text);
    },
    async settled() {},
    readEvidence: (messageId) => evidence.get(messageId) ?? null,
    status: () => ({ entries: 0, withEvidence: 0, failing: 0, lastCycleError: null }),
  };
  return { archive, evidence, state };
}

/** Evidence of MESSAGE with `rows` layout rows. */
export const evidenceText = (rows = 0): string =>
  JSON.stringify({
    schemaVersion: 2,
    route: "ethereum_to_pulsechain",
    sourceTransactionHash: `0x${"11".repeat(32)}`,
    logIndex: 0,
    message: { messageId: MESSAGE, sender: `0x${"22".repeat(20)}`, executor: `0x${"33".repeat(20)}`, gasLimit: 0, sourceChainId: 1, destinationChainId: 369, data: "0x" },
    anchorSlot: 100,
    sourceSlot: 90,
    executeCalldata: "0x00",
    prerequisites: Array.from({ length: rows }, () => ({ function: "addLayout", reason: "row", to: `0x${"44".repeat(20)}`, data: "0x01" })),
  });
