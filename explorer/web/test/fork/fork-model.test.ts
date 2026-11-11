import { describe, expect, it } from "vitest";
import type { ForkCutoverVerdict, ForkGateState, ForkObservation } from "@zk-bridge/shared";
import { gateLine, nextForkLine, observationLine, pauseLine, routeStatusOf, scheduleLine } from "../../src/fork/fork-model";

const fork = { version: "0x90000075", name: "Fulu", epoch: 500, slot: 16_000, time: 2_000_000 };
const open = (next: typeof fork | null): ForkCutoverVerdict => (next === null ? { kind: "open", next: null, pausesAt: null, secondsToPause: null } : { kind: "open", next, pausesAt: next.time - 3600, secondsToPause: next.time - 3600 - 1_990_000 });
const paused = (lightClientHead: bigint | null): ForkCutoverVerdict => ({ kind: "paused", destinationChainId: 943, fork, pausedSince: fork.time - 3600, lightClientHead, leadSeconds: 3600 });
const unknown = (): ForkCutoverVerdict => ({ kind: "unknown", reason: "light-client-unreadable", detail: "x" });
const blocked = (newestCopyAt: number | null): ForkCutoverVerdict => ({ kind: "blocked", reason: "no-fork-schedule", detail: "x", newestCopyAt });

describe("the words of the fork section", () => {
  it("names the status of a route", () => {
    expect([open(null), paused(1n), blocked(null), unknown()].map(routeStatusOf)).toEqual(["open", "paused", "blocked", "unknown"]);
  });

  it("says the next fork with its number, time and countdown", () => {
    expect(nextForkLine(open(null), 1_990_000)).toBe("none scheduled");
    expect(nextForkLine(open(fork), 1_990_000)).toMatch(/^Fulu, epoch 500, \d\d:\d\d UTC, in 2h 46m$/);
    expect(nextForkLine(paused(1n), 1_999_000)).toMatch(/^Fulu, epoch 500, \d\d:\d\d UTC, in 16m 40s$/);
    expect(nextForkLine(paused(1n), 2_000_100)).toMatch(/^Fulu, epoch 500, \d\d:\d\d UTC, 1m 40s ago$/);
    expect(nextForkLine(blocked(null), 0)).toBe("not known: the beacon node did not answer");
    expect(nextForkLine(unknown(), 0)).toBe("not known: the light client head could not be read");
  });

  it("says when sends pause and resume", () => {
    expect(pauseLine(open(null), 0, "PulseChain")).toBe("no pause ahead");
    expect(pauseLine(open(fork), 1_990_000, "PulseChain")).toMatch(/^at \d\d:\d\d UTC, in 1h 46m$/);
    expect(pauseLine(paused(null), 0, "PulseChain")).toMatch(/^paused since .* UTC; resumes once PulseChain's light client head is past slot 16000$/);
    expect(pauseLine(unknown(), 0, "PulseChain")).toBe("sends are offered, with a warning");
    expect(pauseLine(blocked(null), 0, "PulseChain")).toBe("refused until a beacon node answers");
  });

  it("says which fork schedule a verdict used", () => {
    const at = Date.UTC(2026, 10, 9, 8, 15) / 1000;
    expect(scheduleLine(open(null), at)).toBe("from the beacon node");
    expect(scheduleLine(unknown(), at)).toBe("from the beacon node");
    expect(scheduleLine({ kind: "open", next: null, pausesAt: null, secondsToPause: null, schedule: { origin: "cache", fetchedAt: at, liveFailure: "x" } }, at + 60)).toBe("the copy saved by this page at 08:15 UTC (the beacon node did not answer)");
    expect(scheduleLine({ ...(paused(1n) as Extract<ForkCutoverVerdict, { kind: "paused" }>), schedule: { origin: "bundled", fetchedAt: at, liveFailure: "x" } }, at + 60)).toBe("the copy bundled with this release at 08:15 UTC (the beacon node did not answer)");
    expect(scheduleLine(blocked(null), at)).toBe("none: the beacon node did not answer and no copy is at hand");
    expect(scheduleLine(blocked(at), at + 8 * 86_400)).toBe("none: the newest copy, from 2026-11-09 08:15 UTC, is more than 7 days old");
  });

  it("says the gate and the registry in one line each", () => {
    const gate = (over: Partial<ForkGateState>): ForkGateState => ({ gate: "0x1111111111111111111111111111111111111111", mode: "enforcing", enforcing: true, sealed: false, forkRegistry: null, ...over });
    expect(gateLine(gate({}))).toBe("not sealed, mode enforcing, enforcing");
    expect(gateLine(gate({ sealed: true, enforcing: false, mode: "detect-beacon-roots" }))).toBe("sealed, mode detect-beacon-roots, not enforcing");
    expect(gateLine(gate({ mode: "seal-only" }))).toBe("not sealed, mode seal-only, admits every send until sealed");
    expect(gateLine(gate({ mode: "seal-only-with-registry", sealed: true }))).toBe("sealed, mode seal-only-with-registry, admits every send until sealed");
    const observation = (over: Partial<ForkObservation>): ForkObservation => ({ registry: "0x2222222222222222222222222222222222222222", version: "0x90000075", shape: 6, slot: 99n, shapeAllowed: true, observed: true, ...over });
    expect(observationLine(observation({}))).toBe("version 0x90000075, shape 6 (allowed), slot 99");
    expect(observationLine(observation({ shapeAllowed: false, shape: 8 }))).toBe("version 0x90000075, shape 8 (not allowed), slot 99");
    expect(observationLine(observation({ observed: false }))).toBe("nothing observed yet");
  });
});
