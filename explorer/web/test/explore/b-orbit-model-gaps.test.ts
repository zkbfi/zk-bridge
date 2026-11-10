import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";
import { estimatedFeeUsd, orbitTracks, stepSummary } from "../../src/explore/orbit-model";
import { OrbitSampleStream } from "../../src/explore/orbit-sample";

const usdc = FIXTURE_TOKENS[0]!;
const weth = FIXTURE_TOKENS[2]!;

const row = (id: number, over: Partial<FeedItem> = {}): FeedItem => ({
  id: `0x${id.toString(16).padStart(64, "0")}` as Hex,
  kind: "token",
  direction: "first-to-second",
  status: "covered",
  sender: `0x${"1".repeat(40)}` as Hex,
  recipient: `0x${"2".repeat(40)}` as Hex,
  token: usdc,
  amount: 100_000_000n,
  sentAt: FIXTURE_NOW - 60,
  deliveredAt: null,
  sourceTransactionHash: `0x${"3".repeat(64)}` as Hex,
  destinationTransactionHash: null,
  ...over,
});

const prices: Readonly<Record<string, number>> = { USDC: 1 };
const base = { pair: FIXTURE_PAIR, delivered: [], priceOf: (token: { readonly symbol: string }) => prices[token.symbol] ?? null, now: FIXTURE_NOW };

describe("planet order", () => {
  it("breaks a tie of step and send time by the transfer id, whichever order the feed gave them", () => {
    const ids = [3, 1, 2, 5, 4];
    const [out] = orbitTracks({ ...base, inFlight: ids.map((id) => row(id)) });
    expect(out!.planets.map((planet) => BigInt(planet.id))).toEqual([1n, 2n, 3n, 4n, 5n]);
    const [reversed] = orbitTracks({ ...base, inFlight: [...ids].reverse().map((id) => row(id)) });
    expect(reversed!.planets.map((planet) => BigInt(planet.id))).toEqual([1n, 2n, 3n, 4n, 5n]);
  });
});

describe("a transfer listed twice", () => {
  it("is drawn once, in its place by id", () => {
    const [out] = orbitTracks({ ...base, inFlight: [row(1), row(1), row(2)] });
    expect(out!.planets.map((planet) => BigInt(planet.id))).toEqual([1n, 2n]);
  });
});

describe("a fee estimate", () => {
  it("has none for a transfer worth nothing", () => {
    expect(estimatedFeeUsd(0, 10n ** 17n)).toBeNull();
  });
});

describe("a step's summary of messages and unpriced tokens", () => {
  it("groups messages under one line without an amount, sums amounts only where both sides have one, and puts unpriced lines last", () => {
    const dai = { ...usdc, symbol: "DAI", address: `0x${"d".repeat(40)}` as Hex };
    const rows = [
      row(1, { kind: "message", token: null, amount: null }),
      row(2, { kind: "message", token: null, amount: null }),
      row(3, { token: dai, amount: 5n }),
      row(4, { token: dai, amount: 7n }),
      row(5, { token: weth, amount: null }),
      row(6, { token: weth, amount: 10n ** 18n }),
      row(7, { token: usdc, amount: 100_000_000n }),
      row(8, { token: usdc, amount: null }),
    ];
    const [out] = orbitTracks({ ...base, inFlight: rows });
    const summary = stepSummary(out!, 2, FIXTURE_NOW);
    const lines = Object.fromEntries(summary.tokens.map((line) => [line.key, line]));
    expect(lines["message"]).toMatchObject({ token: null, count: 2, amount: null, usd: null, feesUsd: null });
    expect(lines[dai.address.toLowerCase()]).toMatchObject({ count: 2, amount: 12n, usd: null });
    // The first WETH row has no amount, so the line has none; the second does not turn it into a number.
    expect(lines[weth.address.toLowerCase()]).toMatchObject({ count: 2, amount: null });
    expect(lines[usdc.address.toLowerCase()]).toMatchObject({ count: 2, amount: 100_000_000n });
    // Priced first; unpriced after, the one with more transfers first.
    expect(summary.tokens[0]!.key).toBe(usdc.address.toLowerCase());
    expect(summary.tokens.slice(1).map((line) => line.count)).toEqual([2, 2, 2]);
    expect(summary.usd).toBeCloseTo(100);
  });

  it("orders unpriced lines by their transfer count", () => {
    const rows = [row(1, { kind: "message", token: null, amount: null }), row(2, { kind: "message", token: null, amount: null }), row(3, { kind: "message", token: null, amount: null }), row(4, { token: weth, amount: 1n })];
    const [out] = orbitTracks({ ...base, inFlight: rows });
    expect(stepSummary(out!, 2, FIXTURE_NOW).tokens.map((line) => line.count)).toEqual([3, 1]);
  });
});

describe("the sample stream with a token of no sample price", () => {
  it("sizes its amounts as if the token were worth one dollar", () => {
    const dai = { ...usdc, symbol: "DAI", address: `0x${"d".repeat(40)}` as Hex, decimals: 6 };
    const out = new OrbitSampleStream([dai]).at(1_800_000_000, FIXTURE_NOW);
    const sample = out.inFlight.find((item) => item.direction === "first-to-second")!;
    expect(sample.token).toEqual(dai);
    // $5 to $150,000 at a dollar a token and 6 decimals.
    expect(sample.amount!).toBeGreaterThanOrEqual(5_000_000n);
    expect(sample.amount!).toBeLessThanOrEqual(150_000_000_000n);
  });
});

describe("the sample stream after a long pause", () => {
  it("catches up only the last cycles instead of replaying the whole gap", () => {
    const stream = new OrbitSampleStream(FIXTURE_TOKENS);
    const wall = 1_800_000_000;
    stream.at(wall, FIXTURE_NOW);
    const later = stream.at(wall + 100_000, FIXTURE_NOW);
    expect(later.inFlight.length).toBeGreaterThan(0);
  });
});
