import { keccak256, type Hex } from "viem";
import { ORACLE_PROOF_MESSAGE_VERSION, tryDecodeProofMessage, type ProofDirection, type ProofMessage } from "../proof-message.js";
import type { ProverBinary } from "./prover-binary.js";

/** What the proof check needs to know about the light client on the destination chain. */
export interface LightClientHead {
  readonly headSlot: bigint;
  readonly headRoot: Hex;
  readonly programKey: Hex;
}

/** Reads the light client on the destination chain. */
export interface LightClientReader {
  read(): Promise<LightClientHead>;
}

/** Why a proof message is not used. */
export type ProofRefusal =
  | "undecodable"
  | "oracle-proof-not-accepted"
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
  /**
   * Accept the oracle form of the proof message (version 2). Set it only where the destination verifier is the oracle
   * stand-in, for local testing. The default is strict. The local Groth16 check does not apply to an oracle proof,
   * so it is skipped for that form and the chain stays the check.
   */
  readonly acceptOracleProof?: boolean;
}

/** True when the first byte of the payload is the version of the oracle form. */
function isOracleVersion(payload: Hex): boolean {
  return payload.toLowerCase().startsWith(`0x0${ORACLE_PROOF_MESSAGE_VERSION}`);
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
  const acceptOracleProof = input.acceptOracleProof === true;
  const decoded = tryDecodeProofMessage(input.payload, { acceptOracleProof });
  if (!decoded.ok) {
    // Name the refusal of the oracle form, so an operator can tell it from a broken payload.
    if (decoded.reason === "wrong-version" && isOracleVersion(input.payload)) return { accept: false, reason: "oracle-proof-not-accepted" };
    return { accept: false, reason: "undecodable", detail: decoded.reason };
  }
  const message = decoded.message;
  // A second gate behind the decoder, which already refuses the oracle form when the option is off. The decoder
  // makes this line unreachable today; it stays so that a change of the decoder cannot open the gate alone.
  /* v8 ignore next 3 */
  if (message.version === ORACLE_PROOF_MESSAGE_VERSION && !acceptOracleProof) {
    return { accept: false, reason: "oracle-proof-not-accepted" };
  }
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
  if (message.version === ORACLE_PROOF_MESSAGE_VERSION) return { accept: true, message };
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
