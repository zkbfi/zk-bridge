import { afterAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const withRegistry = process.env.EXPLORER_DEPLOYMENT_FILE;

afterAll(() => {
  process.env.EXPLORER_DEPLOYMENT_FILE = withRegistry;
});

describe("a pair without a fork registry", () => {
  it("registers the gate handlers but not the registry handler, because the contract does not exist", async () => {
    process.env.EXPLORER_DEPLOYMENT_FILE = fileURLToPath(new URL("./support/deployment-without-registry.json", import.meta.url));
    vi.resetModules();
    const { handlers } = await import("./support/fake-registry");
    await import("../../src/handlers/chain");
    expect(handlers.has("BeaconForkGate:ForkConfirmed")).toBe(true);
    expect(handlers.has("ForkRegistry:ForkObserved")).toBe(false);
  });
});
