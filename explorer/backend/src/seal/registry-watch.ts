/**
 * The keep-alive of a fork registry's own light client (a light client of PulseChain on PulseChain), the backend's fallback
 * poster of the route step "registry light client update" (owner's planner call, 2026-11-11: "registry light client every
 * period (about 22.75 h)"). Anyone can post the update from the dapp; the backend posts it only when nobody did for one
 * sync committee period. Then a fold of the fork observation program stays short: it spans at most 64 periods.
 *
 * Once per epoch it reads the light client's head. Younger than one period: nothing. Older: it asks the step service for
 * the proof (joining a job that runs; the GPU budget is passed as a liveness proof, logged), waits for it, simulates
 * `update(proof, publicValues)` from the seal signer and sends it. A simulation that reverts means the head moved
 * (somebody posted first): nothing is sent.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { beaconLightClientAbi } from "@zk-bridge/shared";
import type { Logger } from "../logger.ts";
import { periodMillisecondsOf, slotTimeOf, type RegistryLightClient } from "../steps/chain.ts";
import type { StepService } from "../steps/service.ts";
import type { SealSender } from "./seal-watch.ts";

/** What one check did. */
export type RegistryCheckOutcome =
  | { readonly kind: "not-needed"; readonly headAgeSeconds: number }
  | { readonly kind: "waiting"; readonly reason: string }
  | { readonly kind: "posted"; readonly hash: Hex; readonly success: boolean; readonly newSlot: number }
  | { readonly kind: "failed"; readonly stage: "check" | "prove" | "simulate" | "send"; readonly error: string };

/** Input of {@link createRegistryKeepAlive}. */
export type RegistryKeepAliveInput = {
  readonly chainId: number;
  readonly chainName: string;
  readonly pair: string;
  readonly now: () => number;
  readonly logger: Logger;
  readonly alert: (text: string) => void;
  readonly readState: () => Promise<RegistryLightClient>;
  readonly service: StepService;
  /** The gas of a call from the signer; throws when the call would revert. */
  readonly simulate: (call: { readonly to: Address; readonly data: Hex }) => Promise<bigint>;
  readonly send: SealSender;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The watch of one registry. `check` never throws, and two checks never overlap. */
export function createRegistryKeepAlive(input: RegistryKeepAliveInput): { check(): Promise<RegistryCheckOutcome | null> } {
  const { chainId, logger } = input;
  const subject = String(chainId);
  let running = false;
  let quiet = false;

  const run = async (): Promise<RegistryCheckOutcome> => {
    let state: RegistryLightClient;
    try {
      state = await input.readState();
    } catch (error) {
      logger.warn("registry_keepalive_check_failed", { chainId, error: messageOf(error) });
      return { kind: "failed", stage: "check", error: messageOf(error) };
    }
    const headAgeSeconds = Math.round((input.now() - slotTimeOf(state, state.head.slot)) / 1000);
    if (headAgeSeconds * 1000 < periodMillisecondsOf(state)) {
      if (!quiet) logger.info("registry_keepalive_not_needed", { chainId, lightClient: state.lightClient, headSlot: state.head.slot, headAgeSeconds });
      quiet = true;
      return { kind: "not-needed", headAgeSeconds };
    }
    quiet = false;
    logger.warn("registry_keepalive_due", { chainId, lightClient: state.lightClient, headSlot: state.head.slot, headAgeSeconds });
    const answer = await input.service.submit({ kind: "registry-light-client-update", subject, caller: "backend", pair: input.pair, liveness: true });
    if ("invalid" in answer || "refused" in answer) {
      const reason = "invalid" in answer ? answer.invalid : `${answer.refused}${"detail" in answer && answer.detail !== undefined ? `: ${answer.detail}` : ""}`;
      logger.warn("registry_keepalive_waiting", { chainId, reason });
      return { kind: "waiting", reason };
    }
    await input.service.wait(answer.jobId);
    const proof = input.service.proof("registry-light-client-update", subject);
    if (proof === null || proof.kind !== "registry-light-client-update" || proof.startSlot !== state.head.slot) {
      const job = input.service.job(answer.jobId);
      const error = job?.error ?? "no proof from the light client's head";
      logger.warn("registry_keepalive_prove_failed", { chainId, jobId: answer.jobId, error });
      return { kind: "failed", stage: "prove", error };
    }
    const call = { to: proof.lightClient as Address, data: encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [proof.proof as Hex, proof.publicValues as Hex] }) };
    let gas: bigint;
    try {
      gas = await input.simulate(call);
    } catch (error) {
      logger.warn("registry_keepalive_refused", { chainId, startSlot: proof.startSlot, error: messageOf(error), detail: "the light client refuses the update: its head moved (someone posted first)" });
      return { kind: "failed", stage: "simulate", error: messageOf(error) };
    }
    try {
      const receipt = await input.send({ ...call, gas });
      if (receipt.success) logger.info("registry_keepalive_posted", { chainId, hash: receipt.hash, startSlot: proof.startSlot, newSlot: proof.newSlot });
      else {
        logger.error("registry_keepalive_reverted", { chainId, hash: receipt.hash });
        input.alert(`The update of the ${input.chainName} fork registry's light client reverted on chain (transaction ${receipt.hash}); the next epoch tries again.`);
      }
      return { kind: "posted", hash: receipt.hash, success: receipt.success, newSlot: proof.newSlot };
    } catch (error) {
      logger.error("registry_keepalive_send_failed", { chainId, error: messageOf(error) });
      input.alert(`The update of the ${input.chainName} fork registry's light client could not be sent (${messageOf(error)}); the next epoch tries again.`);
      return { kind: "failed", stage: "send", error: messageOf(error) };
    }
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
