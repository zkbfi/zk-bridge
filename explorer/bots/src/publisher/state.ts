import { z } from "zod";

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const slotSchema = z.string().regex(/^\d+$/);

/** The latest proof that is still useful, kept so that a restart does not prove again. */
export const pendingProofSchema = z.object({
  /** The encoded proof message. */
  payload: hexSchema,
  startSlot: slotSchema,
  startRoot: hexSchema,
  newSlot: slotSchema,
  /** When the proof was made, in milliseconds since 1970. */
  madeAtMilliseconds: z.number().int(),
  /** When the message was last posted, or null while it was never posted. */
  lastPostedAtMilliseconds: z.number().int().nullable(),
  postCount: z.number().int().nonnegative(),
  messageHash: hexSchema.nullable(),
});

/** What the last run of the prover did. */
export const proveAttemptSchema = z.object({
  atMilliseconds: z.number().int(),
  outcome: z.enum(["proof", "up-to-date", "failed"]),
});

/** The state of the publisher for one pair and direction. */
export const publisherStateSchema = z.object({
  schemaVersion: z.literal(1),
  pending: pendingProofSchema.nullable(),
  lastProveAttempt: proveAttemptSchema.nullable(),
  lastProofMadeAtMilliseconds: z.number().int().nullable(),
});

/** The latest proof that is still useful. */
export type PendingProof = z.infer<typeof pendingProofSchema>;
/** The state of the publisher for one pair and direction. */
export type PublisherState = z.infer<typeof publisherStateSchema>;

/** The state of a publisher that has done nothing yet. */
export const INITIAL_PUBLISHER_STATE: PublisherState = {
  schemaVersion: 1,
  pending: null,
  lastProveAttempt: null,
  lastProofMadeAtMilliseconds: null,
};
