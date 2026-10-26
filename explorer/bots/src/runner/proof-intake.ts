import { keccak256, type Hex } from "viem";
import { tryDecodeProofMessage, type ProofDirection, type ProofMessage } from "@zk-bridge/shared";
import type { LightClientReader } from "../chain/light-client.ts";
import type { ProverBinary } from "../prover/prover-binary.ts";

/** Why a proof message is not used. */
export type ProofRefusal =
  | "undecodable"
  | "wrong-pair"
  | "wrong-direction"
  | "light-client-unreadable"
  | "program-key-mismatch"
  | "already-stored"
  | "start-slot-differs-from-head"
  | "start-root-differs-from-head"
  | "proof-does-not-verify";

/** The verdict on one message. */
export type ProofAssessment =
  | { readonly accept: true; readonly message: ProofMessage }
  | { readonly accept: false; readonly reason: ProofRefusal; readonly detail?: string };

/** Input of {@link assessProofPayload}. */
export interface AssessInput {
  readonly payload: Hex;
  readonly pairName: string;
  readonly direction: ProofDirection;
  readonly lightClient: LightClientReader;
  readonly prover: ProverBinary;
}

/**
 * Decides whether a message from the board is a proof that this runner can post now. The checks run from the cheapest
 * to the most costly, and the proof check runs last, because it spawns a process:
 *
 * 1. The payload decodes, and names this pair and direction.
 * 2. The program key equals `programVKey()` of the destination light client.
 * 3. The proof does not end at or before the stored head.
 * 4. The start slot and the start root equal the stored head.
 * 5. The Groth16 proof verifies locally for that key and those public values.
 *
 * The chain stays the final check: `update` verifies the proof again.
 */
export async function assessProofPayload(input: AssessInput): Promise<ProofAssessment> {
  const decoded = tryDecodeProofMessage(input.payload);
  if (!decoded.ok) return { accept: false, reason: "undecodable", detail: decoded.reason };
  const message = decoded.message;
  if (message.pair !== input.pairName) return { accept: false, reason: "wrong-pair" };
  if (message.direction !== input.direction) return { accept: false, reason: "wrong-direction" };
  let state;
  try {
    state = await input.lightClient.read();
  } catch (error) {
    return { accept: false, reason: "light-client-unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
  if (message.programKey.toLowerCase() !== state.programKey.toLowerCase()) return { accept: false, reason: "program-key-mismatch" };
  if (state.headSlot >= message.newSlot) return { accept: false, reason: "already-stored" };
  if (message.startSlot !== state.headSlot) return { accept: false, reason: "start-slot-differs-from-head" };
  if (message.startRoot.toLowerCase() !== state.headRoot.toLowerCase()) return { accept: false, reason: "start-root-differs-from-head" };
  try {
    await input.prover.verify({ programKey: message.programKey, publicValues: message.publicValues, proof: message.proof });
  } catch (error) {
    return { accept: false, reason: "proof-does-not-verify", detail: error instanceof Error ? error.message : String(error) };
  }
  return { accept: true, message };
}

/** A key for a payload, so that the runner looks at a republished message once. */
export function payloadKey(payload: Hex): Hex {
  return keccak256(payload);
}
