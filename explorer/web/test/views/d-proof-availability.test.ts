import { describe, expect, it } from "vitest";
import { deliverAvailability, postUpdateAvailability, requestProofAvailability, type AvailabilityInput } from "../../src/views/proof-panel-model";

const delivered: AvailabilityInput = { stage: "delivered", backendSet: true, walletConnected: true, proof: null, delivery: null };

describe("the buttons of a delivered message", () => {
  it("offers no proof, because none is needed", () => {
    expect(requestProofAvailability(delivered)).toEqual({ enabled: false, reason: "The message is delivered. No proof is needed." });
  });

  it("offers no light client update, because none is needed", () => {
    expect(postUpdateAvailability(delivered)).toEqual({ enabled: false, reason: "The message is delivered. The light client update is not needed." });
  });

  it("offers no second delivery, because the message runs only once", () => {
    expect(deliverAvailability(delivered)).toEqual({ enabled: false, reason: "The message is already delivered. It runs only once." });
  });
});
