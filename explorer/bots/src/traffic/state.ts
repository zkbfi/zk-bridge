import { z } from "zod";

/** What the traffic bot remembers of one direction. */
export const trafficDirectionStateSchema = z.object({
  /** The slot of the last attempt. A slot is attempted once: a skip and a send both count. */
  lastSlot: z.number().int(),
  /** When that attempt started, in milliseconds since 1970. */
  lastAttemptAtMilliseconds: z.number().int(),
});

/** The state file of the traffic bot: the last attempted slot of each direction. */
export const trafficStateSchema = z.object({
  schemaVersion: z.literal(1),
  directions: z.object({
    "first-to-second": trafficDirectionStateSchema.nullable(),
    "second-to-first": trafficDirectionStateSchema.nullable(),
  }),
});

/** The parsed state. */
export type TrafficState = z.infer<typeof trafficStateSchema>;

/** The state of a bot that never sent. */
export const INITIAL_TRAFFIC_STATE: TrafficState = { schemaVersion: 1, directions: { "first-to-second": null, "second-to-first": null } };
