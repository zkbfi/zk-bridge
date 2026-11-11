/**
 * The auto-seal of the deposit gate of one chain (decision of 2026-11-10, seal-only gate: "the backend watcher posts that
 * proof in the first blocks of such a fork"). Once per epoch it asks `offerSeal` of `@zkb/data`, the same code as the
 * dapp's "Seal the gate" button: a seal from the fork registry (`seal("")`, PulseChain) or from beacon evidence of a state of
 * a shape the gate does not allow (`seal(evidence)`, Ethereum), each simulated from the signer. Only a call whose
 * simulation succeeded is sent. Everything it finds is logged; a ready seal, its outcome and a sealed gate also go to the
 * alert path.
 */
import type { Address, Hex } from "viem";
import type { SealOffer } from "@zk-bridge/shared";
import type { Logger } from "../logger.ts";

/** What one check did. */
export type SealCheckOutcome =
  | { readonly kind: "sealed" }
  | { readonly kind: "not-needed"; readonly reason: string }
  | { readonly kind: "sent"; readonly hash: Hex; readonly success: boolean; readonly via: "registry" | "beacon" }
  | { readonly kind: "failed"; readonly stage: "check" | "send"; readonly error: string };

/** The send of a simulated call: the transaction port of the runner, with its fee terms and the receipt wait. */
export type SealSender = (call: { readonly to: Address; readonly data: Hex; readonly gas: bigint }) => Promise<{ readonly hash: Hex; readonly success: boolean }>;

/** Input of {@link createSealWatch}. */
export type SealWatchInput = {
  readonly chainId: number;
  readonly chainName: string;
  readonly gate: Address;
  /** `offerSeal` for this chain's gate, from the signer's address. */
  readonly offer: () => Promise<SealOffer>;
  readonly send: SealSender;
  readonly logger: Logger;
  /** The alert path: one line for a person. */
  readonly alert: (text: string) => void;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The watch of one chain. `check` never throws, and two checks never overlap (a check that starts while one runs does
 * nothing), so a slow send cannot become two seals.
 */
export function createSealWatch(input: SealWatchInput): { check(): Promise<SealCheckOutcome | null> } {
  const { chainId, chainName, gate, logger } = input;
  let running = false;
  let reportedSealed = false;
  let lastReason: string | null = null;

  const run = async (): Promise<SealCheckOutcome> => {
    let offer: SealOffer;
    try {
      offer = await input.offer();
    } catch (error) {
      logger.warn("seal_check_failed", { chainId, gate, error: messageOf(error) });
      return { kind: "failed", stage: "check", error: messageOf(error) };
    }
    if (offer.kind === "sealed") {
      if (!reportedSealed) {
        reportedSealed = true;
        logger.error("seal_gate_sealed", { chainId, gate });
        input.alert(`The ${chainName} deposit gate is sealed: it refuses every send for good. Retire the route (docs/hardened-build-contract.md, "Seal-only gate").`);
      }
      return { kind: "sealed" };
    }
    if (offer.kind === "unavailable") {
      if (offer.reason !== lastReason) logger.info("seal_not_needed", { chainId, gate, reason: offer.reason });
      lastReason = offer.reason;
      return { kind: "not-needed", reason: offer.reason };
    }
    logger.error("seal_ready", { chainId, gate, via: offer.via, gas: offer.gas.toString() });
    input.alert(`The ${chainName} chain shows a fork the route cannot follow (${offer.via === "registry" ? "the fork registry" : "beacon evidence"}): sending seal() to its deposit gate.`);
    try {
      const receipt = await input.send({ ...offer.call, gas: offer.gas });
      if (receipt.success) {
        logger.error("seal_sent", { chainId, gate, hash: receipt.hash, via: offer.via });
        input.alert(`The ${chainName} deposit gate is sealed by transaction ${receipt.hash}.`);
      } else {
        logger.error("seal_reverted", { chainId, gate, hash: receipt.hash, via: offer.via });
        input.alert(`The seal of the ${chainName} deposit gate reverted on chain (transaction ${receipt.hash}); the next epoch tries again.`);
      }
      return { kind: "sent", hash: receipt.hash, success: receipt.success, via: offer.via };
    } catch (error) {
      logger.error("seal_send_failed", { chainId, gate, error: messageOf(error) });
      input.alert(`The seal of the ${chainName} deposit gate could not be sent (${messageOf(error)}); the next epoch tries again.`);
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
