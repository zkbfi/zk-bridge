import { describe, expect, it } from "vitest";
import type { LightClientHead } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { chainsFor, lightClientDelay, transferSteps, withLightClientStep } from "../../src/bridge/bridge-model";

// Recorded from https://indexer.zkb.fi/api/heads (2026-10-30): the light client on Sepolia (side "first"), which tracks
// PulseChain v4, was 9504 slots (95,690 s) behind; the one on PulseChain v4 reported no lag.
const onSepolia: LightClientHead = { side: "first", storedHeadSlot: 11194368n, finalizedSlot: 11203872n, lagSlots: 9504n, secondsPerSlot: 12, lastUpdateAt: 1793300844 };
const onPulseChain: LightClientHead = { side: "second", storedHeadSlot: null, finalizedSlot: null, lagSlots: null, secondsPerSlot: 12, lastUpdateAt: null };

describe("the light client a transfer waits for", () => {
  it("is the destination's head of the source chain; a lag over an hour is named (PulseChain → Sepolia here)", () => {
    expect(lightClientDelay([onSepolia, onPulseChain], "second")).toEqual({ seconds: 114048, text: "light client 32 h behind" });
  });

  it("is nothing when the destination's head is current or its lag unknown (Sepolia → PulseChain here)", () => {
    expect(lightClientDelay([onSepolia, onPulseChain], "first")).toBeNull();
    expect(lightClientDelay([{ ...onSepolia, lagSlots: 20n }], "second")).toBeNull();
    expect(lightClientDelay([], "second")).toBeNull();
  });
});

describe("the light client's age in the step list, not the time", () => {
  const { source, destination } = chainsFor(FIXTURE_PAIR, "second-to-first");
  it("adds a row that says how far behind it is and that it adds no wait; the total stays the plain estimate", () => {
    const steps = withLightClientStep(transferSteps(source, destination), lightClientDelay([onSepolia, onPulseChain], "second"));
    const row = steps.find((step) => /Light client is 32 h behind/.test(step.label));
    expect(row).toMatchObject({ estimate: "no added wait", seconds: 0 });
    expect(steps.reduce((sum, step) => sum + step.seconds, 0)).toBe(transferSteps(source, destination).reduce((sum, step) => sum + step.seconds, 0));
  });
  it("adds nothing without a delay", () => {
    expect(withLightClientStep(transferSteps(source, destination), null)).toEqual(transferSteps(source, destination));
  });
});
