import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { FEED_STATUSES, type FeedItem } from "@terminal/model/types";
import { dayStartOf, orbitLeftSeconds, orbitStepOf, orbitTracks, planetRadius, planetTone, toneKey } from "../../src/explore/orbit-model";
import { OrbitSampleStream, SAMPLE_TICK } from "../../src/explore/orbit-sample";

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
const base = { pair: FIXTURE_PAIR, delivered: [], priceOf, now: FIXTURE_NOW, dayStart: dayStartOf(FIXTURE_NOW) };

describe("status → step", () => {
  it("maps each status to the step the transfer waits at, and the end states off the track", () => {
    const mapped = Object.fromEntries(FEED_STATUSES.map((status) => [status, orbitStepOf({ status, destinationTransactionHash: null })]));
    expect(mapped).toEqual({ sent: 0, waiting_for_finality: 1, covered: 2, delivered: null, failed_call: null, release_failed: null });
  });

  it("puts a covered message whose delivery transaction is known at Delivering", () => {
    expect(orbitStepOf({ status: "covered", destinationTransactionHash: `0x${"9".repeat(64)}` as Hex })).toBe(3);
    expect(orbitStepOf({ status: "delivered", destinationTransactionHash: `0x${"9".repeat(64)}` as Hex })).toBeNull();
  });
});

describe("planets", () => {
  it("colours a token by a stable hash into four tones, a zkb copy like its origin", () => {
    const tone = planetTone(toneKey(usdc));
    expect([1, 2, 3, 4]).toContain(tone);
    expect(planetTone(toneKey(usdc))).toBe(tone);
    expect(planetTone(toneKey(FIXTURE_TOKENS[1]!))).toBe(tone); // zkbUSDC
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
    expect(orbitLeftSeconds(2, first, second, 10_000)).toBe(0);
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
    expect(out!.counts).toEqual([1, 1, 1, 0]);
    expect(out!.planets.map((planet) => Math.round(planet.radius))).toEqual([10, 14, 12]);
    expect(out!.planets.map((planet) => planet.icon)).toEqual(["icon:USDC", "icon:WETH", "icon:USDC"]);
    expect(out!.planets[0]!.usd).toBeCloseTo(250);
    expect(out!.deliveredToday).toBe(1);
    expect(back!.counts).toEqual([1, 0, 0, 0]);
    expect(back!.deliveredToday).toBe(0);
  });

  it("caps the planets drawn per step and counts the rest", () => {
    const many = Array.from({ length: 7 }, (_, index) => item({ sentAt: FIXTURE_NOW - index }));
    const [out] = orbitTracks({ ...base, inFlight: many, cap: 5 });
    expect(out!.planets).toHaveLength(7);
    expect(out!.drawn).toHaveLength(5);
    expect(out!.overflow).toEqual([2, 0, 0, 0]);
    // Oldest first.
    expect(out!.drawn[0]!.sentAt).toBe(FIXTURE_NOW - 6);
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
      expect(track.deliveredToday).toBeGreaterThan(0);
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
