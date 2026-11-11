import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { tokenMediatorAbi } from "@zk-bridge/shared";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";

describe("the fixture indexer client with a bridged copy that has no known counterpart", () => {
  it("falls back to the token's own address in the payload of the transfer", async () => {
    const base = buildFixtureFeed(FIXTURE_NOW).find((item) => item.token !== null && item.amount !== null)!;
    const item: FeedItem = { ...base, token: { ...base.token!, isBridgedCopy: true, counterpart: null } };
    const detail = (await createFixtureIndexerClient({ feed: [item] }).message(item.id))!;
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: detail.data! });
    expect(decoded.functionName).toBe("handleNativeTokens");
    expect(decoded.args?.[0]).toBe(item.token!.address);
  });

  it("uses the counterpart when it is known", async () => {
    const base = buildFixtureFeed(FIXTURE_NOW).find((item) => item.token !== null && item.amount !== null)!;
    const counterpart = `0x${"12".repeat(20)}` as const;
    const item: FeedItem = { ...base, token: { ...base.token!, isBridgedCopy: true, counterpart } };
    const detail = (await createFixtureIndexerClient({ feed: [item] }).message(item.id))!;
    expect(decodeFunctionData({ abi: tokenMediatorAbi, data: detail.data! }).args?.[0]?.toString().toLowerCase()).toBe(counterpart);
  });
});
