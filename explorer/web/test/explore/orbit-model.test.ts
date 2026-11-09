import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { DELIVERY_DEFAULT } from "@zk-bridge/shared";
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { FEED_STATUSES, type FeedItem } from "@terminal/model/types";
import { estimatedFeeUsd, orbitLeftSeconds, orbitStepOf, orbitTracks, planetRadius, planetTone, PLANET_CAP, PROOF_USD, proofCoversWith, stepSummary, toneKey } from "../../src/explore/orbit-model";
import { OrbitSampleStream, SAMPLE_TICK } from "../../src/explore/orbit-sample";
import { defaultFinalitySeconds } from "@zk-bridge/shared";

const usdc = FIXTURE_TOKENS[0]!; // USDC, 6 decimals, first side
const weth = FIXTURE_TOKENS[2]!; // WETH, 18 decimals, first side
const wpls = FIXTURE_TOKENS[4]!; // WPLS, second side

let seq = 0;
const item = (over: Partial<FeedItem> = {}): FeedItem => {
  seq++;
  return {
    id: `0x${seq.toString(16).padStart(64, "0")}` as Hex,
    kind: "token",
    direction: "first-to-second",
    status: "sent",
    sender: `0x${"1".repeat(40)}` as Hex,
    recipient: `0x${"2".repeat(40)}` as Hex,
    token: usdc,
    amount: 250_000_000n,
    sentAt: FIXTURE_NOW - 60,
    deliveredAt: null,
    sourceTransactionHash: `0x${"3".repeat(64)}` as Hex,
    destinationTransactionHash: null,
    ...over,
  };
};

const prices: Readonly<Record<string, number>> = { USDC: 1, WETH: 3000, WPLS: 0.00003 };
const priceOf = (token: { readonly symbol: string }): number | null => prices[token.symbol.replace(/^zkb/i, "")] ?? null;
const base = { pair: FIXTURE_PAIR, delivered: [], priceOf, now: FIXTURE_NOW };

describe("status → step", () => {
  const at = { direction: "first-to-second" as const, sentAt: 1_000 };

  it("maps each status to the step the transfer waits at, and the end states off the loop", () => {
    const mapped = Object.fromEntries(FEED_STATUSES.map((status) => [status, orbitStepOf({ status, ...at })]));
    expect(mapped).toEqual({ sent: 0, waiting_for_finality: 1, covered: 2, delivered: null, release_failed: null });
  });

  it("puts a transfer at Proof ready once a valid proof of its direction reaches its send, before any head covers it", () => {
    const covers = proofCoversWith({ "first-to-second": 1_000 });
    expect(orbitStepOf({ status: "waiting_for_finality", ...at }, covers)).toBe(2);
    expect(orbitStepOf({ status: "sent", ...at }, covers)).toBe(2);
    // A proof that ends before the send, or one of the other direction, does not.
    expect(orbitStepOf({ status: "waiting_for_finality", ...at, sentAt: 1_001 }, covers)).toBe(1);
    expect(orbitStepOf({ status: "waiting_for_finality", ...at, direction: "second-to-first" }, covers)).toBe(1);
    expect(orbitStepOf({ status: "delivered", ...at }, covers)).toBeNull();
  });

  it("takes the proof's reach into the tracks", () => {
    const rows = [item({ status: "waiting_for_finality", sentAt: FIXTURE_NOW - 600 }), item({ status: "waiting_for_finality", sentAt: FIXTURE_NOW - 60 })];
    const [out] = orbitTracks({ ...base, inFlight: rows, proofCovers: proofCoversWith({ "first-to-second": FIXTURE_NOW - 300 }) });
    expect(out!.counts).toEqual([0, 1, 1]);
  });
});

describe("planets", () => {
  it("colours a token by a stable hash into four tones, a bridged copy like its origin", () => {
    const tone = planetTone(toneKey(usdc));
    expect([1, 2, 3, 4]).toContain(tone);
    expect(planetTone(toneKey(usdc))).toBe(tone);
    expect(planetTone(toneKey(FIXTURE_TOKENS[1]!))).toBe(tone); // zUSDC
    expect(toneKey({ symbol: "ZRX" })).toBe("ZRX"); // native, though it starts with the copy prefix
    expect(toneKey({ symbol: "zZRX", isBridgedCopy: true })).toBe("ZRX");
    const tones = new Set(["USDC", "WETH", "DAI", "PLS", "HEX", "WBTC", "USDT", "message"].map(planetTone));
    expect(tones.size).toBeGreaterThan(1);
  });

  it("sizes a planet by value on a log scale: 7 at $10 or less, 16 at $100,000 or more", () => {
    expect(planetRadius(null)).toBe(7);
    expect(planetRadius(5)).toBe(7);
    expect(planetRadius(10)).toBe(7);
    expect(planetRadius(1_000)).toBeCloseTo(11.5);
    expect(planetRadius(100_000)).toBe(16);
    expect(planetRadius(1e9)).toBe(16);
  });

  it("estimates time left from the step estimates", () => {
    const { first, second } = FIXTURE_PAIR;
    // Just sent: the whole estimate is ahead.
    expect(orbitLeftSeconds(0, first, second, 0)).toBeGreaterThan(600);
    // Overdue at Sent: what comes after finality is still ahead.
    expect(orbitLeftSeconds(0, first, second, 10_000)).toBeGreaterThan(100);
    // Overdue at Proof ready: only the delivery is ahead.
    expect(orbitLeftSeconds(2, first, second, 10_000)).toBe(DELIVERY_DEFAULT.typical);
  });
});

describe("tracks", () => {
  it("builds one track per direction with counts per step, prices, sizes and icons", () => {
    const rows = [
      item({ status: "sent" }),
      item({ status: "waiting_for_finality", token: weth, amount: 4n * 10n ** 18n }), // $12,000
      item({ status: "covered", amount: 2_500_000_000n }), // $2,500
      item({ status: "delivered", deliveredAt: FIXTURE_NOW - 10 }),
      item({ status: "sent", direction: "second-to-first", token: wpls, amount: 10n ** 18n }),
    ];
    const [out, back] = orbitTracks({ ...base, inFlight: [...rows, rows[0]!], delivered: [rows[3]!], iconOf: (token) => `icon:${token.symbol}` });
    expect(out!.from.chainId).toBe(FIXTURE_PAIR.first.chainId);
    expect(out!.counts).toEqual([1, 1, 1]);
    expect(out!.planets.map((planet) => Math.round(planet.radius))).toEqual([10, 14, 12]);
    expect(out!.planets.map((planet) => planet.icon)).toEqual(["icon:USDC", "icon:WETH", "icon:USDC"]);
    expect(out!.planets[0]!.usd).toBeCloseTo(250);
    expect([out!.delivered24h, out!.delivered7d]).toEqual([1, 1]);
    expect(back!.counts).toEqual([1, 0, 0]);
    expect([back!.delivered24h, back!.delivered7d]).toEqual([0, 0]);
  });

  it("draws the first 32 at a step (oldest first) and still counts and sums them all", () => {
    expect(PLANET_CAP).toBe(32);
    const many = Array.from({ length: 40 }, (_, index) => item({ status: "covered", sentAt: FIXTURE_NOW - 1_000 + index }));
    const [out] = orbitTracks({ ...base, inFlight: many });
    expect(out!.planets).toHaveLength(40);
    expect(out!.counts).toEqual([0, 0, 40]);
    expect(out!.drawn).toHaveLength(32);
    // The 32 that arrived first, so a later arrival never pushes a drawn one out.
    expect(out!.drawn.map((planet) => planet.sentAt)).toEqual(many.slice(0, 32).map((row) => row.sentAt));
    // Stats cover every transfer, drawn or not.
    expect(stepSummary(out!, 2, FIXTURE_NOW).count).toBe(40);
  });

  it("has no price → no dollar value and the smallest planet; no icon source → no icon", () => {
    const [out] = orbitTracks({ ...base, inFlight: [item()], priceOf: () => null });
    expect(out!.planets[0]).toMatchObject({ usd: null, radius: 7, icon: null });
  });
});

describe("the sample stream", () => {
  const wall = 1_800_000_000;
  const stepsOf = (sample: { readonly inFlight: readonly FeedItem[]; readonly delivered: readonly FeedItem[] }) => {
    const [out, back] = orbitTracks({ ...base, inFlight: sample.inFlight, delivered: sample.delivered });
    return [out!, back!];
  };

  it("has transfers at every step in both directions and delivers some today; the same start gives the same transfers", () => {
    const one = new OrbitSampleStream(FIXTURE_TOKENS).at(wall, FIXTURE_NOW);
    for (const track of stepsOf(one)) {
      expect(track.planets.length).toBeGreaterThan(8);
      expect(track.counts.filter((count) => count > 0).length).toBeGreaterThanOrEqual(3);
      expect(track.delivered24h).toBeGreaterThan(0);
    }
    expect(new OrbitSampleStream(FIXTURE_TOKENS).at(wall, FIXTURE_NOW)).toEqual(one);
  });

  it("moves in batches like the chain: a proof posting moves every transfer at Final at once, and the lanes are offset", () => {
    const stream = new OrbitSampleStream(FIXTURE_TOKENS);
    stream.at(wall, FIXTURE_NOW);
    let moves = 0;
    let previous = stepsOf(stream.at(wall, FIXTURE_NOW));
    const lockstep: boolean[] = [];
    for (let tick = 1; tick <= 16; tick++) {
      const next = stepsOf(stream.at(wall + tick * SAMPLE_TICK, FIXTURE_NOW));
      const changed = next.map((track, lane) => {
        const before = new Map(previous[lane]!.planets.map((planet) => [planet.id, planet.step]));
        return track.planets.filter((planet) => before.has(planet.id) && before.get(planet.id) !== planet.step).length;
      });
      // Some ticks move several transfers at once.
      moves = Math.max(moves, ...changed);
      lockstep.push(changed[0]! > 0 === changed[1]! > 0);
      previous = next;
    }
    expect(moves).toBeGreaterThanOrEqual(3);
    expect(lockstep.includes(false)).toBe(true);
  });
});

describe("delivered counts", () => {
  it("counts the last 24 hours and 7 days from the delivered transfers, or takes the indexer's aggregate when given", () => {
    const delivered = [
      item({ status: "delivered", deliveredAt: FIXTURE_NOW - 100 }),
      item({ status: "delivered", deliveredAt: FIXTURE_NOW - 2 * 86_400 }),
      item({ status: "delivered", deliveredAt: FIXTURE_NOW - 8 * 86_400 }),
    ];
    const [out] = orbitTracks({ ...base, inFlight: [], delivered });
    expect([out!.delivered24h, out!.delivered7d]).toEqual([1, 2]);
    const counts = new Map([["first-to-second" as const, { last24h: 40, last7d: 300 }]]);
    const [withAggregate, back] = orbitTracks({ ...base, inFlight: [], delivered, deliveredCounts: counts });
    expect([withAggregate!.delivered24h, withAggregate!.delivered7d]).toEqual([40, 300]);
    // A direction the aggregate does not list delivered nothing.
    expect([back!.delivered24h, back!.delivered7d]).toEqual([0, 0]);
  });
});

describe("a step's summary", () => {
  const weth = FIXTURE_TOKENS[2]!;
  // One delivery: 200,000 gas × 1 gwei × $3,000 per ETH = $0.60.
  const cost = { gasUsed: 200_000n, baseFeeWei: 10n ** 9n, priorityFeeWei: 0n, nativePriceE18: 3000n * 10n ** 18n, level: 1 as const };

  it("groups by token with counts, amounts, values and fees, most value first, and prices the batch's delivery", () => {
    const rows = [
      item({ status: "covered", amount: 100_000_000n }), // 100 USDC
      item({ status: "covered", amount: 50_000_000n }), // 50 USDC
      item({ status: "covered", token: weth, amount: 10n ** 18n }), // 1 WETH, $3,000
      item({ status: "sent" }),
    ];
    const [out] = orbitTracks({ ...base, inFlight: rows, costOf: () => cost });
    expect(out!.deliveryGasUsd).toBeCloseTo(0.6);
    const summary = stepSummary(out!, 2, FIXTURE_NOW);
    expect(summary.count).toBe(3);
    expect(summary.usd).toBeCloseTo(3150);
    expect(summary.tokens.map((line) => [line.token?.symbol, line.count, line.amount, Math.round(line.usd!)])).toEqual([
      ["WETH", 1, 10n ** 18n, 3000],
      ["USDC", 2, 150_000_000n, 150],
    ]);
    const fees = out!.planets.filter((planet) => planet.step === 2).map((planet) => planet.feeUsd!);
    expect(summary.feesUsd).toBeCloseTo(fees.reduce((a, b) => a + b, 0));
    expect(summary.feesEstimated).toBe(true);
    expect(summary.costUsd).toBeCloseTo(3 * 0.6 + PROOF_USD);
    expect(summary).not.toHaveProperty("profitUsd");
  });

  it("has no fees or cost without prices or a delivery cost", () => {
    const [out] = orbitTracks({ ...base, inFlight: [item({ status: "covered" })], priceOf: () => null });
    const summary = stepSummary(out!, 2, FIXTURE_NOW);
    expect([summary.usd, summary.feesUsd, summary.costUsd]).toEqual([null, null, null]);
    expect(stepSummary(out!, 1, FIXTURE_NOW)).toMatchObject({ count: 0, tokens: [], costUsd: null });
  });

  it("estimates a fee with the default fee rule: the curve's share, at least twice the cost, at most 1%", () => {
    // $1,000: the curve is 0.1% from $500, $1.00; twice a $0.10 cost is only $0.20.
    expect(estimatedFeeUsd(1000, 10n ** 17n)).toBeCloseTo(1);
    // $5 with a $10 cost: capped at 1% = $0.05.
    expect(estimatedFeeUsd(5, 10n * 10n ** 18n)).toBeCloseTo(0.05);
  });
});

describe("time at a step", () => {
  const finality = defaultFinalitySeconds(FIXTURE_PAIR.first.chainId);
  const spread = (median: number, p90: number) => ({ avg: null, median, p90 });
  const window = (finalMedian: number, finalP90: number) => ({ count: 10, sentToDelivered: spread(1000, 1500), steps: [spread(finality, finality), spread(finalMedian, finalP90), spread(30, 90)] as const });

  it("measures the wait of the transfers at a step from when they reached it, against the usual time there", () => {
    // At Final (reached at sent + finality): waiting 100, 200 and 600 s.
    const rows = [100, 200, 600].map((wait) => item({ status: "waiting_for_finality", sentAt: FIXTURE_NOW - finality - wait }));
    const timing = { last24h: window(150, 400), last7d: window(170, 500) };
    const [out] = orbitTracks({ ...base, inFlight: rows, deliveredCounts: new Map([["first-to-second" as const, { last24h: 10, last7d: 10, timing }]]) });
    const summary = stepSummary(out!, 1, FIXTURE_NOW);
    expect(summary.waiting).toEqual({ avg: 300, median: 200, longest: 600 });
    expect(summary.usual).toEqual({ median24h: 150, p9024h: 400, median7d: 170 });
    // The median wait (200 s) is within the usual p90 (400 s).
    expect(summary.slower).toBe(false);
    const [late] = orbitTracks({ ...base, inFlight: rows, deliveredCounts: new Map([["first-to-second" as const, { last24h: 10, last7d: 10, timing: { last24h: window(60, 120), last7d: window(60, 120) } }]]) });
    expect(stepSummary(late!, 1, FIXTURE_NOW).slower).toBe(true);
  });

  it("falls back to the delivered transfers for the timing when the indexer gives none", () => {
    const delivered = [
      item({ status: "delivered", sentAt: FIXTURE_NOW - 2_000, deliveredAt: FIXTURE_NOW - 800 }),
      item({ status: "delivered", sentAt: FIXTURE_NOW - 3_000, deliveredAt: FIXTURE_NOW - 1_000 }),
    ];
    const [out, back] = orbitTracks({ ...base, inFlight: [], delivered });
    expect(out!.timing!.last24h.count).toBe(2);
    expect(out!.timing!.last24h.sentToDelivered).toEqual({ avg: 1_600, median: 1_600, p90: 1_920 });
    // No covering time in the feed: the Sent step is the finality window, the rest is Final.
    expect(out!.timing!.last24h.steps[0].median).toBe(finality);
    expect(out!.timing!.last24h.steps[2].median).toBe(0);
    expect(back!.timing).toBeNull();
  });
});
