import { encodeProofMessage, type ProofDirection, type ProofMessage } from "@zk-bridge/shared";
import type { LightClientHead, LightClientReader } from "@zk-bridge/shared/prover";
import type { Hex } from "viem";
import type { Storage } from "../storage.ts";

/** How long the module trusts one read of the light client, in milliseconds. */
export const LIGHT_CLIENT_CACHE_MILLISECONDS = 12_000;

/** The head of the light client that a proof must start from. */
export type StoredHead = LightClientHead;

/** The one proof that the module keeps for a direction. */
export type StoredProof = {
  readonly pair: string;
  readonly direction: ProofDirection;
  readonly startSlot: bigint;
  readonly newSlot: bigint;
  /** The proof message as hex: the exact bytes that the board carried. */
  readonly payload: Hex;
  /** Milliseconds since 1970 at which the module first kept this proof. */
  readonly receivedAt: number;
};

/**
 * Chooses the proof to keep. The contract accepts an update only from its current head, so only a proof that starts at
 * the head is of use, and among those the one that reaches furthest wins. A candidate that ties the kept proof loses:
 * the first proof stays.
 *
 * @param current The proof kept now, or null.
 * @param candidate A proof message that already passed the proof check.
 * @param head The head of the light client now.
 * @param receivedAt When the candidate arrived, in milliseconds since 1970.
 * @returns `current` itself when it stays, the candidate as a stored proof when it wins, or null when neither starts at
 *   the head. Callers compare the result with `current` by identity to learn whether anything changed.
 */
export function chooseLatest(current: StoredProof | null, candidate: ProofMessage, head: StoredHead, receivedAt: number): StoredProof | null {
  const currentUsable = current !== null && current.startSlot === head.headSlot ? current : null;
  const candidateUsable = candidate.startSlot === head.headSlot && candidate.newSlot > head.headSlot;
  if (!candidateUsable) return currentUsable;
  if (currentUsable !== null && currentUsable.newSlot >= candidate.newSlot) return currentUsable;
  return {
    pair: candidate.pair,
    direction: candidate.direction,
    startSlot: candidate.startSlot,
    newSlot: candidate.newSlot,
    payload: encodeProofMessage(candidate),
    receivedAt,
  };
}

/**
 * Wraps a light client reader so that one read serves every caller for a short time. A failed read is not kept.
 *
 * @param reader The reader to wrap.
 * @param now The clock, in milliseconds.
 * @param lifetimeMilliseconds How long one read stays valid.
 */
export function cacheLightClientReader(reader: LightClientReader, now: () => number, lifetimeMilliseconds = LIGHT_CLIENT_CACHE_MILLISECONDS): LightClientReader {
  let kept: { readonly head: LightClientHead; readonly readAt: number } | null = null;
  return {
    async read() {
      if (kept !== null && now() - kept.readAt < lifetimeMilliseconds) return kept.head;
      const head = await reader.read();
      kept = { head, readAt: now() };
      return head;
    },
  };
}

type ProofRow = { start_slot: string; new_slot: string; body: string; stored_at: number };
type StoredBody = { pair: string; payload: Hex };

/**
 * Reads the kept proof of a direction from the `proofs` table.
 *
 * @param storage The backend database.
 * @param direction The direction.
 */
export function loadStoredProof(storage: Storage, direction: ProofDirection): StoredProof | null {
  const row = storage.database.prepare("SELECT start_slot, new_slot, body, stored_at FROM proofs WHERE direction = ?").get(direction) as ProofRow | undefined;
  if (row === undefined) return null;
  const body = JSON.parse(row.body) as StoredBody;
  return { pair: body.pair, direction, startSlot: BigInt(row.start_slot), newSlot: BigInt(row.new_slot), payload: body.payload, receivedAt: row.stored_at };
}

/**
 * Keeps a proof as the only proof of its direction.
 *
 * @param storage The backend database.
 * @param proof The proof to keep.
 */
export function saveStoredProof(storage: Storage, proof: StoredProof): void {
  const body: StoredBody = { pair: proof.pair, payload: proof.payload };
  storage.database
    .prepare("INSERT OR REPLACE INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES (?, NULL, ?, ?, ?, ?)")
    .run(proof.direction, proof.startSlot.toString(), proof.newSlot.toString(), JSON.stringify(body), proof.receivedAt);
}

/**
 * Deletes the kept proof of a direction.
 *
 * @param storage The backend database.
 * @param direction The direction.
 */
export function deleteStoredProof(storage: Storage, direction: ProofDirection): void {
  storage.database.prepare("DELETE FROM proofs WHERE direction = ?").run(direction);
}
