import { z } from "zod";

const weiText = z.string().regex(/^\d+$/, "must be a whole number of wei, as text");

/** Wei that the runner reserved or spent on layout calls. The runner charges the reservation before it broadcasts. */
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
  /** The unrecovered losses of the rolling window. */
  prerequisiteLosses: z.array(prerequisiteLossEntrySchema).default([]),
});

/** The state of the runner for one pair and direction. */
export type RunnerState = z.infer<typeof runnerStateSchema>;

/** The part of the state that records layout spend. */
export type PrerequisiteBudgetState = Pick<RunnerState, "prerequisiteSpend" | "prerequisiteLosses">;

/** The state of a runner that has done nothing yet. */
export const INITIAL_RUNNER_STATE: RunnerState = { schemaVersion: 1, finished: {}, prerequisiteSpend: [], prerequisiteLosses: [] };
