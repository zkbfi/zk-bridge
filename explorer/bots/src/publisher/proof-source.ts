import type { ProofDirection } from "@zk-bridge/shared";
import type { ProveOutcome, ProverBinary } from "../prover/prover-binary.ts";

/**
 * Makes the proof of the next light client update for one direction. The publisher knows only this interface.
 *
 * Today one implementation exists: the prover binary with the remote backend, against a load balancing endpoint that
 * answers `POST /prove` when the proof is ready. A queue endpoint (submit, then poll, or a webhook) is another
 * implementation of the same interface. The publisher does not change when it arrives.
 */
export interface ProofSource {
  produce(request: { readonly direction: ProofDirection }): Promise<ProveOutcome>;
}

/** The proof source that runs `zk-bridge-prover prove` and waits for its handoff. */
export function createBinaryProofSource(binary: ProverBinary): ProofSource {
  return { produce: (request) => binary.prove(request) };
}
