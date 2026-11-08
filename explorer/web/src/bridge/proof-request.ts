/**
 * "Request a proof" on a waiting transfer (owner, 2026-11-07: "if a user requests a proof then it should be given one
 * if the finality is new"). The backend (`POST /requests`, no sign-in) starts a proof when the finality is new and its
 * indexer shows a transfer waiting; this file says what came of the request, in words a person reads.
 */
import type { MessageStatus } from "@zk-bridge/shared";
import type { ProofRequestAnswer } from "@zk-bridge/shared/backend-client";

/** A request can help only a transfer that is final on its source chain and not yet covered on its destination. */
export const canRequestProof = (status: MessageStatus): boolean => status === "waiting_for_finality";

/** What the page shows after a request: the words, and until when the button stays off (ms since 1970), if at all. */
export type ProofRequestView = { readonly tone: "ok" | "wait" | "error"; readonly text: string; readonly retryAt: number | null };

/** "45 s", "5 min 24 s", "3 h 40 min". */
export const waitText = (seconds: number): string => {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) {
    const rest = whole % 60;
    return `${Math.floor(whole / 60)} min${rest === 0 ? "" : ` ${rest} s`}`;
  }
  const minutes = Math.round((whole % 3600) / 60);
  return `${Math.floor(whole / 3600)} h${minutes === 0 ? "" : ` ${minutes} min`}`;
};

/** The words for a started proof: from recent proofs on the testnet GPU, about a minute or two, then the delivery. */
export const PROOF_STARTING_TEXT = "A proof is starting. About 1–2 min to prove, then delivery.";

/**
 * What a request's answer means for the person.
 *
 * @param answer The backend's answer, or null when it did not answer.
 * @param context The destination chain's name and the time now (ms since 1970).
 */
export const proofRequestView = (answer: ProofRequestAnswer | null, context: { readonly destinationName: string; readonly now: number }): ProofRequestView => {
  const later = (seconds: number) => context.now + Math.max(1, seconds) * 1000;
  if (answer === null) return { tone: "error", text: "The prover did not take the request. Try again in 1 min.", retryAt: later(60) };
  if (!("refused" in answer)) {
    return answer.joined === true
      ? { tone: "ok", text: "A proof for this direction is already running. If it does not reach this transfer, ask again when it lands, in about 2 min.", retryAt: later(120) }
      : { tone: "ok", text: PROOF_STARTING_TEXT, retryAt: null };
  }
  switch (answer.refused) {
    case "nothing-to-prove":
      return answer.why === "proof-pending"
        ? { tone: "ok", text: `A proof is already made and is landing on ${context.destinationName}. Delivery follows once it lands.`, retryAt: null }
        : { tone: "ok", text: `Already covered: the light client on ${context.destinationName} holds a head past this transfer. Delivery follows.`, retryAt: null };
    case "cannot-check":
      return { tone: "wait", text: `The prover could not check the chain. Try again in ${waitText(answer.retryAfterSeconds)}.`, retryAt: later(answer.retryAfterSeconds) };
    default: {
      const wait = waitText(answer.retryAfterSeconds);
      const retryAt = later(answer.retryAfterSeconds);
      if (answer.why === "same-finality") return { tone: "wait", text: `A proof to the newest finality is already made or running. The next finality comes in about ${wait}; ask again then.`, retryAt };
      if (answer.why === "gpu-budget") return { tone: "wait", text: `The prover's 24-hour GPU budget for this direction is used up. Try again in ${wait}.`, retryAt };
      return { tone: "wait", text: `Too many proof requests right now. Try again in ${wait}.`, retryAt };
    }
  }
};
