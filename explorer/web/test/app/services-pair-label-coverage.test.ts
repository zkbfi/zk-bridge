import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { readConfiguration } from "../../src/config/environment";

vi.mock("@terminal/config/pairs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@terminal/config/pairs")>()), knownPairIds: () => ["eth-pls", "other-pair"] }));

describe("the known pairs of the services", () => {
  it("shows the identifier of a pair that has no name of its own, and marks only the configured pair", async () => {
    const { createServices } = await import("../../src/app/services");
    const services = createServices(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }), FIXTURE_PAIR);
    expect(services.knownPairs).toEqual([
      { id: "eth-pls", label: "Ethereum and PulseChain", configured: true },
      { id: "other-pair", label: "other-pair", configured: false },
    ]);
  });
});
