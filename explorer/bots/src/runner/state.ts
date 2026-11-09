import { z } from "zod";

const weiText = z.string().regex(/^\d+$/, "must be a whole number of wei, as text");

/**
 * Wei that the runner reserved or spent on one transaction. The runner charges the reservation before it broadcasts,
 * and replaces it with the actual cost at the receipt. Layout calls and deliveries use the same shape in separate lists.
 */
export const prerequisiteSpendEntrySchema = z.object({
  id: z.string().min(1),
  atMilliseconds: z.number().int().nonnegative(),
  wei: weiText,
});

/** Wei that layout calls cost for an item that was then not delivered. */
export const prerequisiteLossEntrySchema = z.object({
  atMilliseconds: z.number().int().nonnegative(),
  wei: weiText,
});

/** One charge of layout spend. */
export type PrerequisiteSpendEntry = z.infer<typeof prerequisiteSpendEntrySchema>;
/** One unrecovered loss. */
export type PrerequisiteLossEntry = z.infer<typeof prerequisiteLossEntrySchema>;

/** The state of the runner for one pair and direction: the items that need no second look, and the rolling spend. */
export const runnerStateSchema = z.object({
  schemaVersion: z.literal(1),
  /** Items that are delivered, by message identifier. The value is the transaction hash, or "elsewhere" when another runner delivered. */
  finished: z.record(z.string(), z.string()),
  /** The layout spend of the rolling window. A restart keeps it, so a restart cannot reset the daily budget. */
  prerequisiteSpend: z.array(prerequisiteSpendEntrySchema).default([]),
  /**
   * The spend of delivery transactions in the rolling window. It is a separate list on purpose: the daily budget and
   * the sweep cap of layout calls bound gifts to other senders, and the fee of a delivery repays delivery spend.
   * A state file from before this list existed parses with an empty list.
   */
  deliverySpend: z.array(prerequisiteSpendEntrySchema).default([]),
  /**
   * The wei that deliveries without a covering fee (the delayed unpaid rule, `deliverUnpaidAfterSeconds`) cost, from the
   * receipts, in the rolling window. The daily cap of unpaid spend reads it, so a restart cannot reset the cap.
   */
  unpaidSpend: z.array(prerequisiteSpendEntrySchema).default([]),
  /** The unrecovered losses of the rolling window. */
  prerequisiteLosses: z.array(prerequisiteLossEntrySchema).default([]),
  /**
   * Whether the bridge on the destination chain reported open. It opens for good, so once true the runner never checks
   * it again. A state file from before this field existed parses as closed, and the next check reads the chain.
   */
  depositsOpen: z.boolean().default(false),
});

/** The state of the runner for one pair and direction. */
export type RunnerState = z.infer<typeof runnerStateSchema>;

/** The part of the state that records spend and losses: the layout spend, the delivery spend and the unrecovered losses. */
export type PrerequisiteBudgetState = Pick<RunnerState, "prerequisiteSpend" | "deliverySpend" | "prerequisiteLosses">;

/** The state of a runner that has done nothing yet. */
export const INITIAL_RUNNER_STATE: RunnerState = { schemaVersion: 1, finished: {}, prerequisiteSpend: [], deliverySpend: [], unpaidSpend: [], prerequisiteLosses: [], depositsOpen: false };
