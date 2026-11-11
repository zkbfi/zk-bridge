/**
 * Fork observations for a `ForkRegistry` (PulseChain; `docs/hardened-build-contract.md`, "Fork observation registry"):
 * the package that `zk-bridge-prover fork-observation` prints, the public view of the newest one that the backend serves
 * (`GET /fork-observations/:chainId/latest`), the rule that decides when an observation is worth a GPU proof, and the
 * offer of the `observe(proof, publicValues)` call, simulated first. One implementation for the backend and the dapp.
 */
import { z } from "zod";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { isAllowedShape, normalizeAddress, type ForkCutoverClock, type ForkScheduleEntry } from "@zkb/core";
import { forkRegistryAbi } from "./abis/index.js";
import type { ForkObservation } from "./fork-cutover-check.js";
import type { GateChainClient } from "./gate-evidence.js";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 20 bytes of 0x hex");
const wordSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x hex");
const hexSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x hex of whole bytes");
const versionSchema = z.string().regex(/^0x[0-9a-fA-F]{8}$/, "must be a 4-byte fork version");
const slotSchema = z.number().int().nonnegative();
/** The public values of the observation program: eight words. */
const publicValuesSchema = z.string().regex(/^0x[0-9a-fA-F]{512}$/, "must be the 256 bytes of an encoded observation");

/** What `zk-bridge-prover fork-observation` prints: one line of JSON. */
export const forkObservationPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    route: z.string().min(1),
    chainId: z.number().int().positive(),
    registry: addressSchema,
    lightClient: addressSchema,
    programKey: wordSchema,
    startHeadSlot: slotSchema,
    observedVersion: versionSchema,
    shape: z.number().int().min(0).max(255),
    observedAttestedSlot: slotSchema,
    foldSteps: z.number().int().min(0).max(64),
    publicValues: publicValuesSchema,
    proof: hexSchema,
    observeCalldata: hexSchema,
    backend: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

/** One package of the prover. */
export type ForkObservationPackage = z.infer<typeof forkObservationPackageSchema>;

/**
 * The newest observation proof of a chain, as the backend serves it. Every field is public: the proof is meant to be posted
 * by anyone. `postedTransaction` is the backend's own `observe` transaction, or null when it has not posted it.
 */
export const latestForkObservationSchema = z
  .object({
    chainId: z.number().int().positive(),
    registry: addressSchema,
    lightClient: addressSchema,
    programKey: wordSchema,
    startHeadSlot: slotSchema,
    observedVersion: versionSchema,
    shape: z.number().int().min(0).max(255),
    shapeAllowed: z.boolean(),
    observedAttestedSlot: slotSchema,
    foldSteps: z.number().int().min(0).max(64),
    publicValues: publicValuesSchema,
    proof: hexSchema,
    provedAt: z.number().int().nonnegative(),
    postedTransaction: wordSchema.nullable(),
  })
  .strict();

/** The newest observation proof of a chain. */
export type LatestForkObservation = z.infer<typeof latestForkObservationSchema>;

/** The public view of a package: the fields of {@link latestForkObservationSchema}. */
export const publicForkObservation = (input: { readonly package: ForkObservationPackage; readonly provedAt: number; readonly postedTransaction: Hex | null }): LatestForkObservation => {
  const { package: proven } = input;
  return {
    chainId: proven.chainId,
    registry: proven.registry,
    lightClient: proven.lightClient,
    programKey: proven.programKey,
    startHeadSlot: proven.startHeadSlot,
    observedVersion: proven.observedVersion.toLowerCase(),
    shape: proven.shape,
    shapeAllowed: isAllowedShape(proven.shape),
    observedAttestedSlot: proven.observedAttestedSlot,
    foldSteps: proven.foldSteps,
    publicValues: proven.publicValues,
    proof: proven.proof,
    provedAt: input.provedAt,
    postedTransaction: input.postedTransaction,
  };
};

/**
 * The fork version a beacon chain runs at `nowSeconds`: the scheduled fork with the highest epoch that has begun. Null
 * before the first scheduled fork (or with no fork).
 */
export const activeForkVersion = (forks: readonly ForkScheduleEntry[], clock: ForkCutoverClock, nowSeconds: number): Hex | null => {
  const elapsed = nowSeconds - clock.genesisTime;
  const epoch = elapsed < 0 ? -1 : Math.floor(elapsed / (clock.secondsPerSlot * clock.slotsPerEpoch));
  let active: ForkScheduleEntry | null = null;
  for (const fork of forks) if (fork.epoch <= epoch && (active === null || fork.epoch >= active.epoch)) active = fork;
  return active === null ? null : (active.version.toLowerCase() as Hex);
};

/** Whether an observation is worth a proof now, and why. */
export type ObservationNeed =
  /** `first`: the registry has observed nothing yet. `new-version`: the chain runs a version that the registry's newest observation does not name. */
  | { readonly needed: true; readonly why: "first" | "new-version"; readonly version: Hex }
  | { readonly needed: false; readonly why: "recorded" | "no-fork"; readonly detail: string };

/**
 * Whether the registry needs an observation: when the version the chain runs now differs from the version of the registry's
 * newest observation (or the registry holds none). The shape comes with the version: a fork that changes the state's
 * shape is a new version, so a version the registry holds already has its shape there. Nothing else asks for a proof:
 * an unchanged version never does, however old the observation.
 *
 * @param input.activeVersion The version the chain runs now ({@link activeForkVersion}), or null when none is scheduled.
 * @param input.registry What the registry last observed.
 */
export const observationNeed = (input: { readonly activeVersion: Hex | null; readonly registry: ForkObservation }): ObservationNeed => {
  const { activeVersion, registry } = input;
  if (activeVersion === null) return { needed: false, why: "no-fork", detail: "the beacon node schedules no fork that has begun" };
  const active = activeVersion.toLowerCase() as Hex;
  if (!registry.observed) return { needed: true, why: "first", version: active };
  if (registry.version.toLowerCase() === active) {
    return { needed: false, why: "recorded", detail: `the registry holds version ${active} (shape ${registry.shape}) from slot ${registry.slot}` };
  }
  return { needed: true, why: "new-version", version: active };
};

/** The calldata of `ForkRegistry.observe(proof, publicValues)`. */
export const observeCalldata = (observation: Pick<LatestForkObservation, "proof" | "publicValues">): Hex =>
  encodeFunctionData({ abi: forkRegistryAbi, functionName: "observe", args: [observation.proof as Hex, observation.publicValues as Hex] });

/** The outcome of {@link offerObservation}. */
export type ObservationOffer =
  /** `observe` simulated without a revert: it can be sent now. */
  | { readonly kind: "ready"; readonly call: { readonly to: Address; readonly data: Hex }; readonly gas: bigint; readonly observation: LatestForkObservation }
  /** Nothing to post, or the registry refuses it now. `reason` says which. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Whether `observe(proof, publicValues)` of an observation proof would succeed now and change what the registry shows, by
 * simulating it. An observation at or below the registry's newest slot adds nothing and is not offered. Nothing is sent.
 *
 * @param input.client A client of the chain of the registry.
 * @param input.registry The `ForkRegistry` address.
 * @param input.observation The newest observation proof, or null when there is none.
 * @param input.account The sender of the simulation.
 */
export async function offerObservation(input: {
  readonly client: Pick<GateChainClient, "readContract" | "estimateGas">;
  readonly registry: Address;
  readonly observation: LatestForkObservation | null;
  readonly account: Address;
}): Promise<ObservationOffer> {
  const { observation } = input;
  if (observation === null) return { kind: "unavailable", reason: "the backend holds no observation proof for this chain" };
  const registry = normalizeAddress(input.registry);
  if (normalizeAddress(observation.registry as Address) !== registry) return { kind: "unavailable", reason: "the observation proof is for another registry" };
  const [, , slot] = (await input.client.readContract({ address: registry, abi: forkRegistryAbi, functionName: "latestObserved" })) as readonly [Hex, number, bigint];
  if (BigInt(slot) >= BigInt(observation.observedAttestedSlot)) {
    return { kind: "unavailable", reason: `the registry already holds an observation at slot ${slot}, at or after this proof's slot ${observation.observedAttestedSlot}` };
  }
  const data = observeCalldata(observation);
  try {
    const gas = await input.client.estimateGas({ account: input.account, to: registry, data });
    return { kind: "ready", call: { to: registry, data }, gas, observation };
  } catch {
    return { kind: "unavailable", reason: `the registry refuses the proof now: its light client no longer stands at slot ${observation.startHeadSlot}, or the proof does not verify` };
  }
}
