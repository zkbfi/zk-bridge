import { z } from "zod";

/** The state of the runner for one pair and direction: the items that need no second look. */
export const runnerStateSchema = z.object({
  schemaVersion: z.literal(1),
  /** Items that are delivered, by message identifier. The value is the transaction hash, or "elsewhere" when another runner delivered. */
  finished: z.record(z.string(), z.string()),
});

/** The state of the runner for one pair and direction. */
export type RunnerState = z.infer<typeof runnerStateSchema>;

/** The state of a runner that has done nothing yet. */
export const INITIAL_RUNNER_STATE: RunnerState = { schemaVersion: 1, finished: {} };
