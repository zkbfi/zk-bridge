/**
 * The words of the fork section of Explore, from the shared verdict and the reads of the gate and the registry. Pure: the
 * numbers come from `@zk-bridge/shared`, this file only lays them out.
 */
import { formatDuration, utcText, type ForkCutoverVerdict, type ForkGateState, type ForkObservation } from "@zk-bridge/shared";

/** The one word that a route shows: `open`, `paused` or `unknown` (the beacon node or the light client could not be read). */
export const routeStatusOf = (verdict: ForkCutoverVerdict): "open" | "paused" | "unknown" => verdict.kind;

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
    case "unknown":
      return verdict.reason === "beacon-unreachable" ? "not known: the beacon node did not answer" : "not known: the light client head could not be read";
  }
};

/** When sends pause or resume, in one line. */
export const pauseLine = (verdict: ForkCutoverVerdict, nowSeconds: number, destinationName: string): string => {
  switch (verdict.kind) {
    case "open":
      return verdict.pausesAt === null || verdict.secondsToPause === null ? "no pause ahead" : `at ${utcText(verdict.pausesAt, nowSeconds)}, in ${formatDuration(verdict.secondsToPause)}`;
    case "paused":
      return `paused since ${utcText(verdict.pausedSince, nowSeconds)}; resumes once ${destinationName}'s light client head is past slot ${verdict.fork.slot}`;
    case "unknown":
      return "sends are offered, with a warning";
  }
};

/** The gate in one line: its mode and whether it is sealed. */
export const gateLine = (gate: ForkGateState): string => `${gate.sealed ? "sealed" : "not sealed"}, mode ${gate.mode}${gate.enforcing ? ", enforcing" : ", not enforcing"}`;

/** What the registry last observed, in one line: the version, the shape and the slot. */
export const observationLine = (observation: ForkObservation): string =>
  observation.observed
    ? `version ${observation.version}, shape ${observation.shape} (${observation.shapeAllowed ? "allowed" : "not allowed"}), slot ${observation.slot}`
    : "nothing observed yet";
