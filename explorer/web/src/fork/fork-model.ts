/**
 * The words of the fork section of Explore, from the shared verdict and the reads of the gate and the registry. Pure: the
 * numbers come from `@zk-bridge/shared`, this file only lays them out.
 */
import { formatDuration, isSealOnlyMode, utcText, type ForkCutoverVerdict, type ForkGateState, type ForkObservation } from "@zk-bridge/shared";

/**
 * The one word that a route shows: `open`, `paused`, `blocked` (no beacon node answered and no copy of the fork schedule is
 * at most seven days old) or `unknown` (the light client head could not be read after a fork).
 */
export const routeStatusOf = (verdict: ForkCutoverVerdict): "open" | "paused" | "blocked" | "unknown" => verdict.kind;

/** Which fork schedule a verdict used, in one line: the beacon node's now, or a saved copy and when it was fetched. */
export const scheduleLine = (verdict: ForkCutoverVerdict, nowSeconds: number): string => {
  if (verdict.kind === "blocked") return verdict.newestCopyAt === null ? "none: the beacon node did not answer and no copy is at hand" : `none: the newest copy, from ${utcText(verdict.newestCopyAt, nowSeconds)}, is more than 7 days old`;
  if (verdict.kind === "unknown" || verdict.schedule === undefined) return "from the beacon node";
  return `${verdict.schedule.origin === "cache" ? "the copy saved by this page" : "the copy bundled with this release"} at ${utcText(verdict.schedule.fetchedAt, nowSeconds)} (the beacon node did not answer)`;
};

/** The next fork of the source chain, in one line: name, epoch, time and countdown. */
export const nextForkLine = (verdict: ForkCutoverVerdict, nowSeconds: number): string => {
  switch (verdict.kind) {
    case "open":
      return verdict.next === null
        ? "none scheduled"
        : `${verdict.next.name}, epoch ${verdict.next.epoch}, ${utcText(verdict.next.time, nowSeconds)}, in ${formatDuration(verdict.next.time - nowSeconds)}`;
    case "paused":
      return verdict.fork.time > nowSeconds
        ? `${verdict.fork.name}, epoch ${verdict.fork.epoch}, ${utcText(verdict.fork.time, nowSeconds)}, in ${formatDuration(verdict.fork.time - nowSeconds)}`
        : `${verdict.fork.name}, epoch ${verdict.fork.epoch}, ${utcText(verdict.fork.time, nowSeconds)}, ${formatDuration(nowSeconds - verdict.fork.time)} ago`;
    case "blocked":
      return "not known: the beacon node did not answer";
    case "unknown":
      return "not known: the light client head could not be read";
  }
};

/** When sends pause or resume, in one line. */
export const pauseLine = (verdict: ForkCutoverVerdict, nowSeconds: number, destinationName: string): string => {
  switch (verdict.kind) {
    case "open":
      return verdict.pausesAt === null || verdict.secondsToPause === null ? "no pause ahead" : `at ${utcText(verdict.pausesAt, nowSeconds)}, in ${formatDuration(verdict.secondsToPause)}`;
    case "paused":
      return `paused since ${utcText(verdict.pausedSince, nowSeconds)}; resumes once ${destinationName}'s light client head is past slot ${verdict.fork.slot}`;
    case "blocked":
      return "refused until a beacon node answers";
    case "unknown":
      return "sends are offered, with a warning";
  }
};

/**
 * The gate in one line: its mode and whether it is sealed. A seal-only gate has one rule, the seal, so it says what it
 * admits instead of whether it enforces.
 */
export const gateLine = (gate: ForkGateState): string =>
  `${gate.sealed ? "sealed" : "not sealed"}, mode ${gate.mode}${isSealOnlyMode(gate.mode) ? ", admits every send until sealed" : gate.enforcing ? ", enforcing" : ", not enforcing"}`;

/** What the registry last observed, in one line: the version, the shape and the slot. */
export const observationLine = (observation: ForkObservation): string =>
  observation.observed
    ? `version ${observation.version}, shape ${observation.shape} (${observation.shapeAllowed ? "allowed" : "not allowed"}), slot ${observation.slot}`
    : "nothing observed yet";
