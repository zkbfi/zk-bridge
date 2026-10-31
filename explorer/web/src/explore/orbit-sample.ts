/**
 * Sample transfers in flight for the sample data (VITE_EXPLORER_DATA=fixture), so the orbits have planets to show. It
 * behaves like the chain (owner: "multiple finalizations, proof postings, and deliverances will happen at the same
 * time"; mockup inflight-orbits.html, advance()): each direction runs its own cycle of events, one per tick, offset so
 * the two lanes don't move in lockstep —
 *
 * - finalize: 60–100 % of the transfers at Sent become final at once;
 * - prove: a new valid proof moves every transfer at Final to Proof ready;
 * - deliver: 2–6 leave Proof ready as delivered;
 * - arrive: 1–3 new transfers at Sent (and sometimes one between the other events).
 *
 * A stream keeps its state and advances to the wall clock on each read, so successive polls show the batches move.
 * Seeded, so a stream from the same start gives the same transfers.
 */
import type { Direction, FeedItem, PairConfig, TokenInfo } from "@terminal/model/types";
import type { Hex } from "viem";

/** Seconds per event. */
export const SAMPLE_TICK = 2;

const EVENTS = ["arrive", "arrive", "finalize", "arrive", "prove", "deliver", "arrive", "deliver"] as const;

/** Sample dollar prices, matching use-prices' sample prices. */
const SAMPLE_USD: Readonly<Record<string, number>> = { USDC: 1, WETH: 3000, ETH: 3000, WPLS: 0.00003, PLS: 0.00003 };

const hex = (value: number, width: number): string => (value >>> 0).toString(16).padStart(width, "0").slice(-width);

/** mulberry32: a small seeded generator in [0, 1). */
const generator = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Sample = {
  readonly n: number;
  step: 0 | 1 | 2;
  readonly sentWall: number;
  deliveredWall: number | null;
  readonly token: TokenInfo | null;
  readonly amount: bigint | null;
  readonly recipient: Hex;
};

type Lane = { readonly direction: Direction; readonly offset: number; readonly random: () => number; items: Sample[]; delivered: Sample[]; seq: number };

/** A stream of sample transfers for a pair. */
export class OrbitSampleStream {
  private readonly lanes: Lane[];
  private tick: number | null = null;

  constructor(
    private readonly tokens: readonly TokenInfo[],
    seed = 7,
  ) {
    this.lanes = (["first-to-second", "second-to-first"] as const).map((direction, index) => ({ direction, offset: index * 3, random: generator(seed * 31 + index), items: [], delivered: [], seq: 0 }));
  }

  /**
   * The sample transfers in flight, and those delivered recently, at a wall clock.
   *
   * @param wallSeconds The wall clock in unix seconds (it drives the stream).
   * @param now The page's clock in unix seconds (sent and delivery times are relative to it).
   */
  at(wallSeconds: number, now: number): { readonly inFlight: readonly FeedItem[]; readonly delivered: readonly FeedItem[] } {
    const target = Math.floor(wallSeconds / SAMPLE_TICK);
    if (this.tick === null) this.start(target);
    // After a long pause, catch up only the last few cycles.
    if (target - this.tick! > 80) this.tick = target - 80;
    while (this.tick! < target) this.advance(++this.tick!);
    const inFlight: FeedItem[] = [];
    const delivered: FeedItem[] = [];
    for (const lane of this.lanes) {
      for (const sample of lane.items) inFlight.push(this.feedItem(lane, sample, wallSeconds, now));
      for (const sample of lane.delivered) delivered.push(this.feedItem(lane, sample, wallSeconds, now));
    }
    return { inFlight, delivered };
  }

  private start(tick: number): void {
    this.tick = tick;
    const wall = tick * SAMPLE_TICK;
    for (const lane of this.lanes) {
      for (let k = 0; k < 24; k++) {
        const step = Math.min(2, Math.floor(lane.random() * 3)) as Sample["step"];
        lane.items.push(this.create(lane, step, wall - Math.round((step + lane.random()) * 120)));
      }
      for (let k = 0; k < 30; k++) {
        const sample = this.create(lane, 2, wall - 600 - k * 60);
        sample.deliveredWall = wall - k * 60;
        lane.delivered.push(sample);
      }
    }
  }

  private create(lane: Lane, step: Sample["step"], sentWall: number): Sample {
    const side = lane.direction === "first-to-second" ? "first" : "second";
    const own = this.tokens.filter((token) => token.side === side);
    const token = own.length === 0 ? null : own[Math.floor(lane.random() * own.length)]!;
    const price = token === null ? null : (SAMPLE_USD[token.symbol.replace(/^zkb/i, "")] ?? 1);
    // A dollar size spread from $5 to $150,000, most of them small.
    const usd = Math.exp(Math.log(5) + lane.random() ** 1.6 * (Math.log(150_000) - Math.log(5)));
    const amount = token === null || price === null ? null : BigInt(Math.max(1, Math.round((usd / price) * 1e6))) * 10n ** BigInt(Math.max(0, token.decimals - 6));
    const n = ++lane.seq;
    return { n, step, sentWall, deliveredWall: null, token, amount, recipient: `0x${hex(lane.random() * 2 ** 32, 8)}${"2".repeat(24)}${hex(lane.random() * 2 ** 32, 8)}` as Hex };
  }

  private advance(tick: number): void {
    const wall = tick * SAMPLE_TICK;
    for (const lane of this.lanes) {
      const event = EVENTS[(tick + lane.offset) % EVENTS.length]!;
      const at = (step: number): Sample[] => lane.items.filter((sample) => sample.step === step);
      const between = (low: number, high: number): number => low + lane.random() * (high - low);
      if (event === "finalize") {
        const sent = at(0);
        for (const sample of sent.slice(0, Math.max(1, Math.round(sent.length * between(0.6, 1))))) sample.step = 1;
      }
      if (event === "prove") for (const sample of at(1)) sample.step = 2;
      if (event === "deliver") {
        for (const sample of at(2).slice(0, Math.ceil(between(2, 6)))) {
          sample.deliveredWall = wall;
          lane.items = lane.items.filter((item) => item !== sample);
          lane.delivered = [sample, ...lane.delivered].slice(0, 200);
        }
      }
      const arrivals = event === "arrive" ? Math.round(between(1, 3)) : lane.random() < 0.4 ? 1 : 0;
      for (let k = 0; k < arrivals; k++) lane.items.push(this.create(lane, 0, wall));
    }
  }

  private feedItem(lane: Lane, sample: Sample, wallSeconds: number, now: number): FeedItem {
    const d = lane.direction === "first-to-second" ? 0 : 1;
    const sentAt = Math.round(now - (wallSeconds - sample.sentWall));
    const delivered = sample.deliveredWall !== null;
    return {
      id: `0x0b17${hex(d, 4)}${hex(sample.n, 16)}${"0".repeat(40)}` as Hex,
      kind: sample.token === null ? "message" : "token",
      direction: lane.direction,
      status: delivered ? "delivered" : sample.step === 0 ? "sent" : sample.step === 1 ? "waiting_for_finality" : "covered",
      sender: `0x${hex(sample.n * 7919, 8)}${"1".repeat(32)}` as Hex,
      recipient: sample.recipient,
      token: sample.token,
      amount: sample.amount,
      sentAt,
      deliveredAt: delivered ? Math.round(now - (wallSeconds - sample.deliveredWall!)) : null,
      sourceTransactionHash: `0x${hex(sample.n * 104729 + d, 8)}${"3".repeat(56)}` as Hex,
      destinationTransactionHash: delivered ? (`0x${hex(sample.n * 1299709 + d, 8)}${"4".repeat(56)}` as Hex) : null,
    };
  }
}

const streams = new WeakMap<PairConfig, { readonly key: string; readonly stream: OrbitSampleStream }>();

/**
 * The sample transfers at a wall clock, from one stream per pair and token list.
 *
 * @param pair The pair.
 * @param tokens The pair's tokens.
 * @param wallSeconds The wall clock in unix seconds.
 * @param now The page's clock in unix seconds.
 */
export const orbitSample = (pair: PairConfig, tokens: readonly TokenInfo[], wallSeconds: number, now: number): { readonly inFlight: readonly FeedItem[]; readonly delivered: readonly FeedItem[] } => {
  const key = tokens.map((token) => `${token.side}:${token.address}`).join(",");
  let entry = streams.get(pair);
  if (entry === undefined || entry.key !== key) {
    entry = { key, stream: new OrbitSampleStream(tokens) };
    streams.set(pair, entry);
  }
  return entry.stream.at(wallSeconds, now);
};
