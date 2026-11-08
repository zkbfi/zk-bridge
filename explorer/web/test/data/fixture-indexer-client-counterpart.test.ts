import { describe, expect, it, vi } from "vitest";

const TOKEN = { address: "0x00000000000000000000000000000000000010a1", symbol: "SOLO", decimals: 6, side: "first", counterpart: null } as const;

vi.mock("@terminal/data/fixtures", async (importOriginal) => {
  const original = await importOriginal<typeof import("@terminal/data/fixtures")>();
  return {
    ...original,
    buildFixtureFeed: (now: number) => original.buildFixtureFeed(now).map((item, index) => (index === 0 ? { ...item, kind: "token", token: TOKEN, amount: 5n, direction: "first-to-second" } : item)),
  };
});

describe("the fixture indexer client with a token that has no counterpart", () => {
  it("shows the same token on the destination chain", async () => {
    const { createFixtureIndexerClient } = await import("../../src/data/fixture-indexer-client");
    const { buildFixtureFeed, FIXTURE_NOW } = await import("@terminal/data/fixtures");
    const detail = await createFixtureIndexerClient().message(buildFixtureFeed(FIXTURE_NOW)[0]!.id);
    expect(detail?.transfer?.destinationToken?.address).toBe(TOKEN.address);
    expect(detail?.transfer?.sourceToken.address).toBe(TOKEN.address);
  });
});
