import { z } from "zod";

/** The plan of one clock hour of a direction. */
export const trafficPlanSchema = z.object({
  hour: z.number().int(),
  count: z.number().int().nonnegative(),
  times: z.array(z.number().int()),
  sent: z.array(z.boolean()),
});

/**
 * What the traffic bot remembers of one direction. A file from before the hourly plans (it held `lastSlot`) still
 * loads: its unknown fields are dropped and the plan is empty.
 */
export const trafficDirectionStateSchema = z.object({
  /** The plan of the current hour. Written before the first send of the hour, and updated before each send. */
  plan: trafficPlanSchema.nullable().default(null),
  /** When the last attempt started, in milliseconds since 1970. */
  lastAttemptAtMilliseconds: z.number().int().nullable().default(null),
});

/** The state file of the traffic bot: the plan of each direction. */
export const trafficStateSchema = z.object({
  schemaVersion: z.literal(1),
  directions: z.object({
    "first-to-second": trafficDirectionStateSchema.nullable(),
    "second-to-first": trafficDirectionStateSchema.nullable(),
  }),
});

/** The parsed state. */
export type TrafficState = z.infer<typeof trafficStateSchema>;
/** The state of one direction. */
export type TrafficDirectionState = z.infer<typeof trafficDirectionStateSchema>;

/** The state of a bot that never sent. */
export const INITIAL_TRAFFIC_STATE: TrafficState = { schemaVersion: 1, directions: { "first-to-second": null, "second-to-first": null } };
