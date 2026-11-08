import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { FeedItem, LightClientHead } from "@terminal/model/types";
import { durationText, exploreNumbers, lightClientCards, median, statusWord } from "../../src/explore/explore-model";

const item = (overrides: Partial<FeedItem>): FeedItem => ({
  id: `0x${"11".repeat(32)}`,
  kind: "token",
  direction: "first-to-second",
  status: "delivered",
  sender: "0x0000000000000000000000000000000000000001",
  recipient: "0x0000000000000000000000000000000000000002",
  token: null,
  amount: null,
  sentAt: 1_000,
  deliveredAt: 1_900,
  sourceTransactionHash: `0x${"22".repeat(32)}`,
  destinationTransactionHash: null,
  ...overrides,
});

describe("Explore's model", () => {
  it("gives every status one word", () => {
    expect(["sent", "waiting_for_finality", "covered", "delivered", "release_failed"].map((status) => statusWord(status as FeedItem["status"]))).toEqual(["sent", "waiting", "proven", "delivered", "failed"]);
  });

  it("writes durations short", () => {
    expect([30, 840, 95_690, 400_000].map(durationText)).toEqual(["30 s", "14 min", "27 h", "5 d"]);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("counts transfers in the last day, the median time of the delivered ones, and those in flight", () => {
    const now = 100_000;
    const feed = [item({ sentAt: now - 100, deliveredAt: now - 10 }), item({ sentAt: now - 200, deliveredAt: now - 50 }), item({ sentAt: now - 90_000, deliveredAt: null, status: "covered" })];
    expect(exploreNumbers(feed, now)).toEqual({ transfers24h: 2, medianSeconds: 120, inFlight: 1 });
    expect(exploreNumbers([], now)).toEqual({ transfers24h: 0, medianSeconds: null, inFlight: 0 });
  });

  it("makes a card per light client from the heads (recorded: the one on Sepolia 26 h behind, the other unknown)", () => {
    const heads: LightClientHead[] = [
      { side: "first", storedHeadSlot: 11194368n, finalizedSlot: 11203936n, lagSlots: 9568n, secondsPerSlot: 10, lastUpdateAt: 1793300844 },
      { side: "second", storedHeadSlot: null, finalizedSlot: 11471808n, lagSlots: null, secondsPerSlot: 12, lastUpdateAt: null },
    ];
    const [onFirst, onSecond] = lightClientCards(heads, FIXTURE_PAIR);
    expect(onFirst).toMatchObject({ holderChainId: FIXTURE_PAIR.first.chainId, trackedChainId: FIXTURE_PAIR.second.chainId, lagText: "27 h behind", behind: true, verifiedSlot: 11194368n });
    expect(onFirst!.title).toBe(`${FIXTURE_PAIR.first.name} checks ${FIXTURE_PAIR.second.name}`);
    expect(onSecond).toMatchObject({ lagText: "lag unknown", behind: false, fill: 0, verifiedSlot: null });
  });
});
