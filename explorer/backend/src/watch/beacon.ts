/** Reads of the source beacon node that the finality feed needs, and the parsers of their answers. */
import { SYNC_COMMITTEE_SIZE } from "./decide.ts";

/** What one look at the source chain's finality found. */
export type FinalityReading = {
  /** The slot of the newest finalized header. */
  readonly finalizedSlot: number;
  /** The slot whose block carries the signatures over it, or null when unknown. */
  readonly signatureSlot: number | null;
  /** How many sync committee members signed, or null when unknown. */
  readonly participants: number | null;
};

const asSlot = (value: unknown): number | null => {
  const slot = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(slot) ? slot : null;
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** The number of set bits of `sync_committee_bits` (64 bytes of 0x hex), or null for any other value. */
export function countParticipants(bits: unknown): number | null {
  if (typeof bits !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${SYNC_COMMITTEE_SIZE / 4}}$`).test(bits)) return null;
  let count = 0;
  for (const digit of bits.slice(2)) {
    let nibble = Number.parseInt(digit, 16);
    while (nibble > 0) {
      count += nibble & 1;
      nibble >>= 1;
    }
  }
  return count;
}

/**
 * The reading in a light-client finality update: the body of `/eth/v1/beacon/light_client/finality_update` or the data
 * of a `light_client_finality_update` event (both `{version, data}`; a bare update is accepted too). Null when the
 * value has no finalized slot.
 */
export function readingFromFinalityUpdate(body: unknown): FinalityReading | null {
  const outer = record(body);
  const update = "finalized_header" in record(outer.data) ? record(outer.data) : outer;
  const finalizedSlot = asSlot(record(record(update.finalized_header).beacon).slot);
  if (finalizedSlot === null) return null;
  return {
    finalizedSlot,
    signatureSlot: asSlot(update.signature_slot),
    participants: countParticipants(record(update.sync_aggregate).sync_committee_bits),
  };
}

/** The slot of a header answer (`/eth/v1/beacon/headers/<id>`), or null. */
export function slotOfHeader(body: unknown): number | null {
  return asSlot(record(record(record(record(body).data).header).message).slot);
}

/** The participation of the sync aggregate in a block answer (`/eth/v2/beacon/blocks/<id>`), or null. */
export function participantsOfBlock(body: unknown): number | null {
  const aggregate = record(record(record(record(record(body).data).message).body).sync_aggregate);
  return countParticipants(aggregate.sync_committee_bits);
}

/** The slot of a `head` event, or null. */
export function slotOfHeadEvent(data: unknown): number | null {
  return asSlot(record(data).slot);
}
