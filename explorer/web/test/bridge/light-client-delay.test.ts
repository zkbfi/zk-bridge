import { describe, expect, it } from "vitest";
import type { LightClientHead } from "@terminal/model/types";
import { lightClientDelay } from "../../src/bridge/bridge-model";

// Recorded from https://indexer.zkb.fi/api/heads (2026-10-30): the Sepolia light client on PulseChain v4 was 9504
// slots (95,690 s) behind.
const behind: LightClientHead = { side: "second", storedHeadSlot: 11194368n, finalizedSlot: 11203872n, lagSlots: 9504n, secondsPerSlot: 12, lastUpdateAt: 1793300844 };

describe("the light client a transfer waits for", () => {
  it("is the destination's head of the source chain; a lag over an hour is a delay worth naming", () => {
    expect(lightClientDelay([behind], "first")).toEqual({ seconds: 114048, text: "light client 32 h behind" });
  });

  it("is nothing when the destination's head is current or unknown", () => {
    expect(lightClientDelay([{ ...behind, lagSlots: 20n }], "first")).toBeNull();
    expect(lightClientDelay([{ ...behind, lagSlots: null }], "first")).toBeNull();
    expect(lightClientDelay([], "first")).toBeNull();
    // The head that the source chain stores does not delay this direction.
    expect(lightClientDelay([behind], "second")).toBeNull();
  });
});
