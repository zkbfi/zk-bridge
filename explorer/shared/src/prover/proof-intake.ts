import { keccak256, type Hex } from "viem";
import { ORACLE_PROOF_MESSAGE_VERSION, tryDecodeProofMessage, type ProofDirection, type ProofMessage } from "../proof-message.js";
import { CommandStartError, CommandTimeoutError } from "./execute-command.js";
import { ProverCommandError, ProverOutputError, type ProverBinary } from "./prover-binary.js";
import type { LightClientHead, LightClientReader } from "./light-client.js";
import type { VerifyGuard } from "./verify-guard.js";

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
  | "head-in-future"
  | "verify-budget-exhausted"
  | "verify-unavailable"
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
  /**
   * The guard in front of the local check: it refuses a payload that already failed at this head, and caps the checks
   * per minute. Without a guard every payload that passes the cheap checks is checked. Pass one wherever the payloads
   * come from the public board.
   */
  readonly verifyGuard?: VerifyGuard;
  /** The source that the guard counts the check under, such as the board category of a direction. Default `unnamed`. */
  readonly verifySource?: string;
  /** Milliseconds since 1970, for the clock check of the new slot. Default `Date.now`. */
  readonly now?: () => number;
}

/** The slots that a new slot may be after the clock of the destination, for clock skew between hosts. */
export const FUTURE_SLOT_MARGIN = 2n;

/** The current slot of a light client clock at `nowMilliseconds`, 0 before genesis, as `BeaconClock.slotAt` reads it. */
function currentSlotOf(clock: NonNullable<LightClientHead["clock"]>, nowMilliseconds: number): bigint {
  const seconds = BigInt(Math.floor(nowMilliseconds / 1000));
  return seconds <= clock.genesisTime ? 0n : (seconds - clock.genesisTime) / clock.secondsPerSlot;
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
 * 5. The new slot is not after the clock of the light client (when the reader gives its clock settings).
 * 6. The verify guard, when given, admits the check (see `verify-guard.ts`).
 * 7. The Groth16 proof verifies locally for that key and those public values.
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
  if (state.clock !== undefined) {
    const currentSlot = currentSlotOf(state.clock, (input.now ?? Date.now)());
    if (message.newSlot > currentSlot + FUTURE_SLOT_MARGIN) {
      return { accept: false, reason: "head-in-future", detail: `slot ${message.newSlot} is after the current slot ${currentSlot} of the destination` };
    }
  }
  if (message.version === ORACLE_PROOF_MESSAGE_VERSION) return { accept: true, message };
  const guard = input.verifyGuard;
  const key = payloadKey(input.payload);
  const source = input.verifySource ?? "unnamed";
  if (guard !== undefined) {
    const admission = guard.admit({ key, head: state, newSlot: message.newSlot, source });
    if (admission.kind === "refused-before") return { accept: false, reason: "proof-does-not-verify", detail: "refused before at this head" };
    if (admission.kind === "dropped") {
      const whose = admission.scope === "all" ? "all sources" : "this source";
      return { accept: false, reason: "verify-budget-exhausted", detail: `the local proof checks of this minute are used up (${whose})` };
    }
  }
  try {
    await input.prover.verify({ programKey: message.programKey, publicValues: message.publicValues, proof: message.proof });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The verifier could not give an answer (it timed out, did not start, crashed or printed junk): nothing is known
    // about the proof, so the refusal may pass on a later look and is not remembered.
    if (isVerifierFailure(error)) return { accept: false, reason: "verify-unavailable", detail };
    // Only a definite refusal of the verifier is remembered for this head.
    if (isDefiniteRefusal(error)) guard?.refused({ key, head: state, source });
    return { accept: false, reason: "proof-does-not-verify", detail };
  }
  guard?.verified({ head: state, newSlot: message.newSlot, source });
  return { accept: true, message };
}

/** The exit code of `zk-bridge-prover verify` for a proof that does not verify (or has the wrong shape). */
export const VERIFY_REFUSED_EXIT_CODE = 1;

/** True when the verifier ran and refused the proof: `verify` exits with code 1 and reads no file or network. */
function isDefiniteRefusal(error: unknown): boolean {
  return error instanceof ProverCommandError && error.exitCode === VERIFY_REFUSED_EXIT_CODE;
}

/** True when the verifier gave no answer about the proof: a timeout, a start failure, a crash or a junk answer. */
function isVerifierFailure(error: unknown): boolean {
  if (error instanceof CommandTimeoutError || error instanceof CommandStartError || error instanceof ProverOutputError) return true;
  return error instanceof ProverCommandError && error.exitCode !== VERIFY_REFUSED_EXIT_CODE;
}

/** A key for a payload, so that the runner looks at a republished message once. */
export function payloadKey(payload: Hex): Hex {
  return keccak256(payload);
}
