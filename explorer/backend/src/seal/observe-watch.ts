/**
 * The fork observations of one chain whose deposit gate seals from a `ForkRegistry` (PulseChain; owner, 2026-11-11: "treat
 * it the same ... gpu is available"). PulseChain has no beacon roots, so its gate learns of a fork only from the registry,
 * and the registry only from a proof of the fork observation program. Once per epoch this watch asks whether the registry
 * is behind the chain (`observationNeed` of `@zkb/data`: the version the beacon node runs now is not the version of the
 * registry's newest observation). Only then it asks the GPU for a proof (`zk-bridge-prover fork-observation`, the remote
 * endpoints of the proving jobs), records its cost with the proving jobs of the chain's direction, simulates
 * `observe(proof, publicValues)` from the seal signer and sends it. A recorded shape outside the allowed set wakes the seal
 * watch of the chain, which seals from the registry.
 *
 * GPU use is bounded three ways: a proof only when the version changes (once per fork, plus one to seed an empty registry);
 * at most `maxProofsPerVersionPerDay` tries for one version, `retryMinutes` apart; and the 24 h GPU budget of the direction,
 * which a seed respects and a new fork passes (logged), because that proof is what lets the gate seal.
 */
import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import { isAllowedShape, observationNeed, observeCalldata, type ForkObservation, type ForkObservationPackage, type ProofDirection } from "@zk-bridge/shared";
import type { ObservationOutcome } from "@zk-bridge/shared/prover";
import type { Logger } from "../logger.ts";
import type { Storage } from "../storage.ts";
import { recordProveTiming } from "../requests/timings.ts";
import {
  failObservationAttempt,
  insertObservationAttempt,
  latestObservationProof,
  markObservationPosted,
  recentObservationAttempts,
  storeObservationProof,
  type ObservationWhy,
} from "./observations.ts";
import type { SealSender } from "./seal-watch.ts";

/** One day in milliseconds: the window of the per-version cap. */
const DAY_MILLISECONDS = 24 * 3_600_000;

/** What one check did. */
export type ObservationCheckOutcome =
  | { readonly kind: "not-needed"; readonly reason: string }
  /** A proof is due but waits: the spacing between tries, the cap per version, or the GPU budget. */
  | { readonly kind: "waiting"; readonly reason: string }
  | { readonly kind: "posted"; readonly hash: Hex; readonly success: boolean; readonly version: string; readonly shape: number }
  | { readonly kind: "failed"; readonly stage: "check" | "prove" | "simulate" | "send"; readonly error: string };

/** What the watch reads each epoch. */
export type ObservationFacts = { readonly activeVersion: Hex | null; readonly registry: ForkObservation };

/** The GPU budget of the direction now: null while it is not spent, else what was spent. */
export type BudgetState = { readonly spentUsd: number; readonly budgetUsd: number; readonly retryAfterSeconds: number } | null;

/** Input of {@link createObservationWatch}. */
export type ObservationWatchInput = {
  readonly chainId: number;
  readonly chainName: string;
  readonly registry: Address;
  /** The direction whose source is this chain: its GPU budget pays for the proof, and its timings record it. */
  readonly direction: ProofDirection;
  readonly storage: Storage;
  readonly now: () => number;
  readonly logger: Logger;
  /** The alert path: one line for a person. */
  readonly alert: (text: string) => void;
  readonly limits: { readonly retryMinutes: number; readonly maxProofsPerVersionPerDay: number };
  /** The version the beacon node runs now and what the registry last observed. */
  readonly readFacts: () => Promise<ObservationFacts>;
  /** The GPU budget of {@link ObservationWatchInput.direction}. */
  readonly budget: () => Promise<BudgetState>;
  /** One proof of the fork observation program for the registry. */
  readonly prove: () => Promise<ObservationOutcome>;
  /** The gas of `observe` from the signer; throws when the call would revert. */
  readonly simulate: (data: Hex) => Promise<bigint>;
  readonly send: SealSender;
  /** Told of a recorded observation. The module wakes the seal watch when the shape is not allowed. */
  readonly onRecorded: (event: { readonly shapeAllowed: boolean }) => void;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Proves one observation and stores it in `fork_observations`: the attempt row is written before the first await, so a
 * caller that passes `id` can name the job at once. The GPU time counts toward the direction's budget and shows in the
 * billing and the benchmarks, like a proving job. Logged; never throws.
 */
export async function proveObservation(input: {
  readonly id: string;
  readonly storage: Storage;
  readonly chainId: number;
  readonly registry: Address;
  readonly direction: ProofDirection;
  readonly version: Hex;
  readonly why: ObservationWhy;
  readonly now: () => number;
  readonly logger: Logger;
  readonly prove: () => Promise<ObservationOutcome>;
}): Promise<{ readonly id: string; readonly observation: ForkObservationPackage } | { readonly id: string; readonly stage: "prove" | "check"; readonly error: string }> {
  const { id, storage, chainId, registry, version, why, logger } = input;
  const startedAt = input.now();
  insertObservationAttempt(storage, { id, chainId, version, why, at: startedAt });
  logger.warn("observation_proving", { chainId, registry, version, why });
  let outcome: ObservationOutcome;
  try {
    outcome = await input.prove();
  } catch (error) {
    failObservationAttempt(storage, { id, error: "the prover could not make an observation proof", at: input.now() });
    logger.warn("observation_prove_failed", { chainId, registry, version, error });
    return { id, stage: "prove", error: messageOf(error) };
  }
  const provedAt = input.now();
  recordProveTiming(storage, { jobId: `observation-${id}`, direction: input.direction, startedAt, provedAt, timing: outcome.timing });
  const { observation } = outcome;
  if (observation.chainId !== chainId || observation.registry.toLowerCase() !== registry.toLowerCase()) {
    failObservationAttempt(storage, { id, error: "the proof is for another registry", at: provedAt });
    logger.error("observation_wrong_registry", { chainId, registry, provedChainId: observation.chainId, provedRegistry: observation.registry });
    return { id, stage: "check", error: "the proof is for another registry" };
  }
  storeObservationProof(storage, { id, observation, at: provedAt });
  logger.info("observation_proved", { chainId, registry, version: observation.observedVersion, asked: version, shape: observation.shape, foldSteps: observation.foldSteps, seconds: Math.round((provedAt - startedAt) / 1000) });
  return { id, observation };
}

/**
 * The watch of one chain. `check` never throws, and two checks never overlap, so a slow proof cannot become two.
 */
export function createObservationWatch(input: ObservationWatchInput): { check(): Promise<ObservationCheckOutcome | null> } {
  const { chainId, chainName, registry, logger, storage } = input;
  let running = false;
  let lastReason: string | null = null;

  const quietly = (reason: string): void => {
    if (reason !== lastReason) logger.info("observation_not_needed", { chainId, registry, reason });
    lastReason = reason;
  };

  /** Simulates and sends `observe` for a stored proof. */
  async function post(id: string, observation: ForkObservationPackage): Promise<ObservationCheckOutcome> {
    const shapeAllowed = isAllowedShape(observation.shape);
    const what = `fork version ${observation.observedVersion} (shape ${observation.shape}, ${shapeAllowed ? "allowed" : "not allowed"} by the gate)`;
    const data = observeCalldata(observation);
    let gas: bigint;
    try {
      gas = await input.simulate(data);
    } catch (error) {
      logger.error("observation_refused", { chainId, registry, version: observation.observedVersion, startHeadSlot: observation.startHeadSlot, error: messageOf(error) });
      input.alert(`The ${chainName} fork registry refuses the observation of ${what}: the simulation of observe() reverted. The next epoch tries again.`);
      return { kind: "failed", stage: "simulate", error: messageOf(error) };
    }
    try {
      const receipt = await input.send({ to: registry, data, gas });
      if (receipt.success) {
        markObservationPosted(storage, { id, transaction: receipt.hash });
        logger.error("observation_posted", { chainId, registry, hash: receipt.hash, version: observation.observedVersion, shape: observation.shape, shapeAllowed });
        input.alert(`The ${chainName} fork registry recorded ${what} by transaction ${receipt.hash}.`);
        input.onRecorded({ shapeAllowed });
      } else {
        logger.error("observation_reverted", { chainId, registry, hash: receipt.hash });
        input.alert(`The observation sent to the ${chainName} fork registry reverted on chain (transaction ${receipt.hash}); the next epoch tries again.`);
      }
      return { kind: "posted", hash: receipt.hash, success: receipt.success, version: observation.observedVersion, shape: observation.shape };
    } catch (error) {
      logger.error("observation_send_failed", { chainId, registry, error: messageOf(error) });
      input.alert(`The observation for the ${chainName} fork registry could not be sent (${messageOf(error)}); the next epoch tries again.`);
      return { kind: "failed", stage: "send", error: messageOf(error) };
    }
  }

  /** Proves an observation and stores it, or gives the outcome of a failed try (logged). */
  async function proveOne(version: Hex, why: ObservationWhy): Promise<{ id: string; observation: ForkObservationPackage } | { failed: ObservationCheckOutcome }> {
    if (why === "new-version") input.alert(`The ${chainName} chain runs fork version ${version}, which its fork registry does not hold: proving a fork observation on the GPU.`);
    const proven = await proveObservation({ id: randomUUID(), storage, chainId, registry, direction: input.direction, version, why, now: input.now, logger, prove: input.prove });
    if ("observation" in proven) return proven;
    if (proven.stage === "prove" && why === "new-version") input.alert(`The fork observation for ${chainName} could not be proven; it is tried again in ${input.limits.retryMinutes} minutes.`);
    return { failed: { kind: "failed", stage: "prove", error: proven.error } };
  }

  const run = async (): Promise<ObservationCheckOutcome> => {
    let facts: ObservationFacts;
    try {
      facts = await input.readFacts();
    } catch (error) {
      logger.warn("observation_check_failed", { chainId, registry, error: messageOf(error) });
      return { kind: "failed", stage: "check", error: messageOf(error) };
    }
    const need = observationNeed(facts);
    if (!need.needed) {
      quietly(need.detail);
      return { kind: "not-needed", reason: need.detail };
    }
    lastReason = null;
    // A proof we hold of this version, newer than the registry and never posted, is posted before any new proof.
    const held = latestObservationProof(storage, chainId);
    if (held !== null && held.postedTransaction === null && held.observation.observedVersion.toLowerCase() === need.version && BigInt(held.observation.observedAttestedSlot) > facts.registry.slot) {
      const outcome = await post(held.id, held.observation);
      if (outcome.kind !== "failed" || outcome.stage !== "simulate") return outcome;
    }
    const now = input.now();
    const recent = recentObservationAttempts(storage, { chainId, version: need.version, since: now - DAY_MILLISECONDS });
    if (recent.count >= input.limits.maxProofsPerVersionPerDay) {
      const reason = `${recent.count} observation proofs of version ${need.version} in 24 h, the most allowed`;
      quietly(reason);
      return { kind: "waiting", reason };
    }
    if (recent.latestAt !== null && now - recent.latestAt < input.limits.retryMinutes * 60_000) {
      const reason = `the last try for version ${need.version} started ${Math.round((now - recent.latestAt) / 60_000)} minutes ago; tries are ${input.limits.retryMinutes} minutes apart`;
      quietly(reason);
      return { kind: "waiting", reason };
    }
    const spent = await input.budget();
    if (spent !== null) {
      const fields = { chainId, direction: input.direction, budgetUsd: spent.budgetUsd, spentUsd: Math.round(spent.spentUsd * 10_000) / 10_000 };
      if (need.why === "first") {
        logger.warn("gpu_budget_spent", { ...fields, reason: "fork-observation", retryAfterSeconds: spent.retryAfterSeconds });
        const reason = `the 24 h GPU budget of $${spent.budgetUsd.toFixed(2)} for ${input.direction} is spent; the first observation waits ${spent.retryAfterSeconds} s`;
        quietly(reason);
        return { kind: "waiting", reason };
      }
      logger.warn("gpu_budget_bypassed", { ...fields, why: "safety: an observation of a new fork version lets the gate seal" });
    }
    const proven = await proveOne(need.version, need.why);
    if ("failed" in proven) return proven.failed;
    return post(proven.id, proven.observation);
  };

  return {
    async check() {
      if (running) return null;
      running = true;
      try {
        return await run();
      } finally {
        running = false;
      }
    },
  };
}
