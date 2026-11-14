import { describe, expect, it } from "vitest";
import { forkPauseOf } from "../../src/fork/ForkCutoverLine";

const fork = { version: "0x06000000", name: "Fulu", epoch: 100, slot: 3200, time: 100 } as const;
const paused = { kind: "paused", destinationChainId: 2, fork, pausedSince: 1, lightClientHead: null, leadSeconds: 3600 } as const;
const open = { kind: "open", next: fork, pausesAt: null, secondsToPause: 10 } as const;

describe("forkPauseOf", () => {
  it("names the chain and the fork on the button, and carries the line with the numbers", () => {
    const view = { sourceChainId: 1, destinationChainId: 2, verdict: paused, text: { headline: "Sends resume after the fork.", countdown: null, sendable: false, scheduleNote: null }, nowSeconds: 0 } as const;
    expect(forkPauseOf(view, "Ethereum")).toEqual({ label: "Ethereum sends paused for the Fulu fork", detail: "Sends resume after the fork." });
  });

  it("leaves out the copy of the schedule that the pause was decided from (Explore's fork section names it)", () => {
    const view = { sourceChainId: 1, destinationChainId: 2, verdict: paused, text: { headline: "Paused.", countdown: null, sendable: false, scheduleNote: "From a copy." }, nowSeconds: 0 } as const;
    expect(forkPauseOf(view, "Ethereum")).toEqual({ label: "Ethereum sends paused for the Fulu fork", detail: "Paused." });
  });

  it("names the wait for a fork schedule on the button when no schedule can be used", () => {
    const blocked = { kind: "blocked", reason: "no-fork-schedule", detail: "x", newestCopyAt: null } as const;
    const view = { sourceChainId: 1, destinationChainId: 2, verdict: blocked, text: { headline: "Sends wait.", countdown: null, sendable: false, scheduleNote: null }, nowSeconds: 0 } as const;
    expect(forkPauseOf(view, "Ethereum")).toEqual({ label: "Ethereum sends wait for the fork schedule", detail: "Sends wait." });
  });

  it("gives nothing while the route is not paused", () => {
    const view = { sourceChainId: 1, destinationChainId: 2, verdict: open, text: { headline: "Soon.", countdown: "in 10s", sendable: true, scheduleNote: null }, nowSeconds: 0 } as const;
    expect(forkPauseOf(view, "Ethereum")).toBeNull();
  });
});
