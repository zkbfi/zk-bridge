/**
 * The in-flight orbits' model (mockup design/ui/screens/inflight-orbits.html): which of the four steps each transfer in
 * flight waits at, its planet (the token's icon, sized by value, with a lettered fallback in a token tone) and the tracks
 * of a pair, one per direction. A planet is its token's icon (owner: "each bridge is just a single token address, so we
 * have enough information to visually show what is crossing the bridge and the size of it as well"); its size is its
 * dollar value on a log scale. Pure: the drawing lives in orbit-engine.ts.
 *
 * The steps (owner: "a proof posted in my mind is just that it shows up on a msgboard or that the client has it and has
 * validated it. not that it has been posted on chain. since anyone can post it on chain and they are incented to do so
 * during their own delivery"), from the statuses of explorer/shared/src/status.ts and the latest valid proof:
 *
 * | The transfer                                                         | Step        | It waits for              |
 * | -------------------------------------------------------------------- | ----------- | ------------------------- |
 * | `covered` (a stored head covers it), or a valid proof covers it      | Proof ready | a deliverer               |
 * | `waiting_for_finality`                                               | Final       | a proof that covers it    |
 * | `sent`                                                               | Sent        | finality on its chain     |
 * | `delivered`, `failed_call`, `release_failed`                         | none        | it has left the loop      |
 *
 * "A valid proof covers it": the latest proof of its direction (the msgboard indexer's, verified on intake, else the
 * msgboard node's; read as the proof panel reads it) ends at a slot whose time is at or after the send. There is no
 * step for a delivery under way: a delivery posts the proof and delivers in one transaction, so nothing reliable
 * tells it apart from "proof ready" until it lands.
 */
import type { ChainConfig, Direction, FeedItem, PairConfig, TokenInfo } from "@terminal/model/types";
import { DEFAULT_CAP_WAD, defaultFee, defaultFinalitySeconds, deliveryGasUsd, PROOF_COST_USD, stepDurations, timingStats, totalCostUsd, type CostInput } from "@zk-bridge/shared";
import type { DirectionTiming, Spread, WindowTiming } from "./explore-source";
import { chainsFor, transferSteps } from "../bridge/bridge-model";

/** The three steps of a lane, in order. */
export const ORBIT_STEPS = ["Sent", "Final", "Proof ready"] as const;

/** A step's index on a lane. */
export type OrbitStep = 0 | 1 | 2;

/** Counts per step. */
export type StepCounts = readonly [number, number, number];

/** What a transfer at each step waits for, for the list and screen readers. */
export const ORBIT_STEP_WORDS: Readonly<Record<OrbitStep, string>> = {
  0: "Sent, waiting for finality",
  1: "Final, waiting for a proof",
  2: "Proof ready, waiting for a deliverer",
};

/**
 * The step a transfer waits at, or null once it has left the loop (delivered or failed).
 *
 * @param item The transfer.
 * @param proofCovers Whether the latest valid proof of its direction covers it (absent: no proof known).
 */
export const orbitStepOf = (item: Pick<FeedItem, "status" | "direction" | "sentAt">, proofCovers?: (item: Pick<FeedItem, "direction" | "sentAt">) => boolean): OrbitStep | null => {
  switch (item.status) {
    case "covered":
      return 2;
    case "sent":
    case "waiting_for_finality":
      if (proofCovers?.(item) === true) return 2;
      return item.status === "sent" ? 0 : 1;
    default:
      return null;
  }
};

/** A latest valid proof's reach: the time of its new slot (genesis + newSlot × seconds per slot), per direction. */
export type ProofReach = Readonly<Partial<Record<Direction, number>>>;

/**
 * Whether a proof covers a send: the proof's new slot starts at or after the send's block time.
 *
 * @param reach The proofs' reach by direction.
 */
export const proofCoversWith =
  (reach: ProofReach) =>
  (item: Pick<FeedItem, "direction" | "sentAt">): boolean => {
    const until = reach[item.direction];
    return until !== undefined && until >= item.sentAt;
  };

/** One of the four planet colours (intensities of the ember hue): --zb-planet-1 … --zb-planet-4. */
export type PlanetTone = 1 | 2 | 3 | 4;

/** What a planet's colour is keyed on: the token's symbol without its zkb prefix, so a copy matches its origin. */
export const toneKey = (token: Pick<TokenInfo, "symbol"> | null): string => (token === null ? "message" : token.symbol.replace(/^zkb/i, "").toUpperCase());

/**
 * A stable colour for a token: an FNV-1a hash of its key into the four planet tones.
 *
 * @param key The token's key (see {@link toneKey}).
 */
export const planetTone = (key: string): PlanetTone => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash % 4) + 1) as PlanetTone;
};

/** A planet's radius: 7 at $10 or less, 16 at $100,000 or more, on a log scale between; 7 with no price. */
export const planetRadius = (usd: number | null): number => (usd === null || usd <= 10 ? 7 : 7 + 9 * Math.min(1, (Math.log10(usd) - 1) / 4));

/** One transfer in flight, as a planet. */
export type Planet = {
  readonly id: FeedItem["id"];
  readonly step: OrbitStep;
  readonly tone: PlanetTone;
  readonly radius: number;
  /** The token's icon (the app's icon source), or null for a message; the planet falls back to a lettered disc in its tone. */
  readonly icon: string | null;
  readonly usd: number | null;
  readonly token: TokenInfo | null;
  readonly amount: bigint | null;
  readonly source: ChainConfig;
  readonly destination: ChainConfig;
  readonly recipient: FeedItem["recipient"];
  readonly sentAt: number;
  /** Seconds left, from the step estimates; 0 means any moment. */
  readonly leftSeconds: number;
  /**
   * The fee the transfer pays its deliverer, in USD, or null without a price or a delivery cost. The feed does not
   * carry the signed fee, so it is the default fee rule's estimate (`estimated`).
   */
  readonly feeUsd: number | null;
  readonly feeEstimated: boolean;
  /**
   * When it reached its step, as far as the feed tells: Sent from the send; Final and Proof ready from the end of the
   * source's finality window (the feed has no time a proof covered it, so time at Proof ready reads high).
   */
  readonly reachedAt: number;
};

/** One direction's track. */
export type OrbitTrack = {
  readonly direction: Direction;
  readonly from: ChainConfig;
  readonly to: ChainConfig;
  /** Every transfer in flight, oldest first within each step. */
  readonly planets: readonly Planet[];
  /** The planets drawn: at most `cap` per step. */
  readonly drawn: readonly Planet[];
  /** Transfers in flight at each step. */
  readonly counts: StepCounts;
  /** Delivered in the last 24 hours and the last 7 days (from the indexer's aggregate, else from the delivered transfers given). */
  readonly delivered24h: number;
  readonly delivered7d: number;
  /** What one delivery on the destination costs in gas today, in USD, or null when unknown. */
  readonly deliveryGasUsd: number | null;
  /** How long deliveries took (the indexer's aggregate, else from the delivered transfers given), or null. */
  readonly timing: DirectionTiming | null;
};

/**
 * The planets drawn at most per step (owner: "anything beyond 32 at a single station, should only show the orbiting tokens
 * of the first 32. the counts can still increase, the stats can stay the same"): the 32 that arrived first (oldest
 * first, so planets don't swap in and out between polls). Counts and stats include every transfer.
 */
export const PLANET_CAP = 32;

/**
 * Seconds left for a transfer at a step, from the step estimates (bridge-model's transferSteps): what the steps after
 * the one it waits for take, or the whole estimate less its age when that is more.
 *
 * @param step The step it waits at.
 * @param source The source chain.
 * @param destination The destination chain.
 * @param ageSeconds Seconds since it was sent.
 */
export const orbitLeftSeconds = (step: OrbitStep, source: ChainConfig, destination: ChainConfig, ageSeconds: number): number => {
  const plan = transferSteps(source, destination).map((row) => row.seconds);
  const total = plan.reduce((sum, seconds) => sum + seconds, 0);
  // The plan's rows: sent, final, proof, the light client checks, delivered. Sent waits for final, Final for the proof,
  // Proof ready for the delivery (which posts the proof on the way).
  const waitsFor = [1, 2, 3][step]!;
  const after = plan.slice(waitsFor + 1).reduce((sum, seconds) => sum + seconds, 0);
  return Math.max(0, Math.round(Math.max(after, total - ageSeconds)));
};

/** The input of {@link orbitTracks}. */
export type OrbitInput = {
  readonly pair: PairConfig;
  /** Transfers in flight (any order; repeats are dropped). Ones that have left the track are ignored. */
  readonly inFlight: readonly FeedItem[];
  /** Delivered transfers; the 24 hour and 7 day counts come from them when `deliveredCounts` does not say. */
  readonly delivered: readonly FeedItem[];
  /** The indexer's delivered counts per direction (GET /api/delivered), or null when it has none. */
  readonly deliveredCounts?: ReadonlyMap<Direction, { readonly last24h: number; readonly last7d: number; readonly timing?: DirectionTiming | null }> | null;
  /** The delivery cost inputs of a destination chain (gas, base fee, priority fee, native price), or null. */
  readonly costOf?: (destinationChainId: number) => CostInput | null;
  /** Whether the latest valid proof of a transfer's direction covers it (see {@link proofCoversWith}). */
  readonly proofCovers?: (item: Pick<FeedItem, "direction" | "sentAt">) => boolean;
  /** A token's icon URL (TokenIcon's source), or null. */
  readonly iconOf?: (token: TokenInfo) => string | null;
  /** A token's dollar price, or null. */
  readonly priceOf: (token: TokenInfo) => number | null;
  /** Unix seconds now. */
  readonly now: number;
  readonly cap?: number;
};

const usdOf = (item: FeedItem, priceOf: (token: TokenInfo) => number | null): number | null => {
  if (item.token === null || item.amount === null) return null;
  const price = priceOf(item.token);
  if (price === null) return null;
  return (Number(item.amount) / 10 ** item.token.decimals) * price;
};

/**
 * The tracks of a pair: first to second, then second to first.
 *
 * @param input The transfers, prices and clock.
 */
export const orbitTracks = (input: OrbitInput): readonly OrbitTrack[] => {
  const cap = input.cap ?? PLANET_CAP;
  const seen = new Set<string>();
  const unique = input.inFlight.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  return (["first-to-second", "second-to-first"] as const).map((direction): OrbitTrack => {
    const { source, destination } = chainsFor(input.pair, direction);
    const cost = input.costOf?.(destination.chainId) ?? null;
    const totalCost = cost === null ? null : totalCostUsd(cost);
    const planets: Planet[] = [];
    for (const item of unique) {
      if (item.direction !== direction) continue;
      const step = orbitStepOf(item, input.proofCovers);
      if (step === null) continue;
      const usd = usdOf(item, input.priceOf);
      planets.push({
        id: item.id,
        step,
        tone: planetTone(toneKey(item.token)),
        radius: planetRadius(usd),
        icon: item.token === null ? null : (input.iconOf?.(item.token) ?? null),
        usd,
        token: item.token,
        amount: item.amount,
        source,
        destination,
        recipient: item.recipient,
        sentAt: item.sentAt,
        leftSeconds: orbitLeftSeconds(step, source, destination, input.now - item.sentAt),
        feeUsd: usd === null || totalCost === null ? null : estimatedFeeUsd(usd, totalCost),
        feeEstimated: true,
        reachedAt: step === 0 ? item.sentAt : item.sentAt + defaultFinalitySeconds(source.chainId),
      });
    }
    planets.sort((a, b) => a.step - b.step || a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const counts: [number, number, number] = [0, 0, 0];
    for (const planet of planets) counts[planet.step]++;
    const drawnPer: [number, number, number] = [0, 0, 0];
    const drawn = planets.filter((planet) => drawnPer[planet.step]! < cap && (drawnPer[planet.step]++, true));
    const within = (seconds: number): number => {
      const ids = new Set<string>();
      for (const item of input.delivered) if (item.direction === direction && item.deliveredAt !== null && item.deliveredAt >= input.now - seconds) ids.add(item.id);
      return ids.size;
    };
    const aggregate = input.deliveredCounts === undefined || input.deliveredCounts === null ? null : (input.deliveredCounts.get(direction) ?? { last24h: 0, last7d: 0 });
    return {
      direction,
      from: source,
      to: destination,
      planets,
      drawn,
      counts,
      delivered24h: aggregate?.last24h ?? within(86_400),
      delivered7d: aggregate?.last7d ?? within(7 * 86_400),
      deliveryGasUsd: cost === null ? null : fromE18(deliveryGasUsd(cost)),
      timing: aggregate?.timing ?? timingFrom(input.delivered.filter((item) => item.direction === direction), source.chainId, input.now),
    };
  });
};

/**
 * Timing from delivered transfers, when the indexer's aggregate is missing: the same definitions (shared
 * transfer-timing), with no covering time (the feed has none), so Proof ready reads 0 and Final takes its time.
 */
const timingFrom = (delivered: readonly FeedItem[], sourceChainId: number, now: number): DirectionTiming | null => {
  const done = delivered.filter((item) => item.deliveredAt !== null);
  if (done.length === 0) return null;
  const window = (seconds: number): WindowTiming => {
    const rows = done.filter((item) => item.deliveredAt! >= now - seconds).map((item) => stepDurations({ sentAt: item.sentAt, coveredAt: null, deliveredAt: item.deliveredAt!, finalitySeconds: defaultFinalitySeconds(sourceChainId) }));
    const spread = (values: readonly number[]): Spread => {
      const stats = timingStats(values);
      return { avg: stats.avg, median: stats.median, p90: stats.p90 };
    };
    return {
      count: rows.length,
      sentToDelivered: spread(rows.map((row) => row.total)),
      steps: [spread(rows.map((row) => row.sent)), spread(rows.map((row) => row.final)), spread(rows.map((row) => row.ready))],
    };
  };
  return { last24h: window(86_400), last7d: window(7 * 86_400) };
};

const fromE18 = (value: bigint): number => Number(value) / 1e18;
const toE18 = (value: number): bigint => BigInt(Math.round(value * 1e6)) * 10n ** 12n;

/**
 * The default fee rule's fee for a transfer (fee-rules' defaultFee at the Normal gas level, the default 1% cap), in USD.
 *
 * @param usd The transfer's value.
 * @param totalCostE18 Its delivery's total cost, USD × 1e18 (fee-rules' totalCostUsd).
 */
export const estimatedFeeUsd = (usd: number, totalCostE18: bigint): number | null => {
  const fee = defaultFee({ amountUsd: toE18(usd), costUsd: totalCostE18, capWad: DEFAULT_CAP_WAD }).feeUsd;
  return fee === null ? null : fromE18(fee);
};

/** The proof that one batch of deliveries shares ($0.025). */
export const PROOF_USD = fromE18(PROOF_COST_USD);

/** One token's line in a step's summary. */
export type StepTokenLine = {
  readonly key: string;
  readonly token: TokenInfo | null;
  readonly count: number;
  /** The summed amount in base units, or null for messages. */
  readonly amount: bigint | null;
  /** The summed value of the priced transfers, or null when none has a price. */
  readonly usd: number | null;
  /** The summed fees of the transfers with a fee, or null when none has one. */
  readonly feesUsd: number | null;
};

/** What a step's sun shows: its transfers by token, their fees (paid to the fee address) and what delivering them all costs. */
export type StepSummary = {
  readonly step: OrbitStep;
  readonly direction: Direction;
  readonly count: number;
  readonly usd: number | null;
  /** By token, most value first (unpriced last). */
  readonly tokens: readonly StepTokenLine[];
  readonly feesUsd: number | null;
  /** True when any fee is an estimate. */
  readonly feesEstimated: boolean;
  /** Delivering them all: N × one delivery's gas + one shared $0.025 proof; null without the gas. */
  readonly costUsd: number | null;
  /** How long the transfers here now have waited at this step (now − when they reached it), in seconds; null with none. */
  readonly waiting: { readonly avg: number; readonly median: number; readonly longest: number } | null;
  /** How long deliveries usually spent at this step: median and p90 of the last 24 hours, median of the last 7 days. */
  readonly usual: { readonly median24h: number | null; readonly p9024h: number | null; readonly median7d: number | null } | null;
  /** The wait now is longer than usual: its median is over the last 24 hours' p90. */
  readonly slower: boolean;
};

const add = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);

/**
 * A step's summary for its sun's tooltip.
 *
 * @param track The direction's track.
 * @param step The step.
 */
export const stepSummary = (track: OrbitTrack, step: OrbitStep, now: number): StepSummary => {
  const planets = track.planets.filter((planet) => planet.step === step);
  const lines = new Map<string, { token: TokenInfo | null; count: number; amount: bigint | null; usd: number | null; feesUsd: number | null }>();
  for (const planet of planets) {
    const key = planet.token === null ? "message" : planet.token.address.toLowerCase();
    const line = lines.get(key) ?? { token: planet.token, count: 0, amount: planet.amount === null ? null : 0n, usd: null, feesUsd: null };
    line.count++;
    if (line.amount !== null && planet.amount !== null) line.amount += planet.amount;
    line.usd = add(line.usd, planet.usd);
    line.feesUsd = add(line.feesUsd, planet.feeUsd);
    lines.set(key, line);
  }
  const tokens = [...lines.entries()].map(([key, line]) => ({ key, ...line })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.count - a.count);
  const usd = tokens.reduce<number | null>((sum, line) => add(sum, line.usd), null);
  const feesUsd = tokens.reduce<number | null>((sum, line) => add(sum, line.feesUsd), null);
  const costUsd = track.deliveryGasUsd === null || planets.length === 0 ? null : planets.length * track.deliveryGasUsd + PROOF_USD;
  const waits = planets.map((planet) => Math.max(0, now - planet.reachedAt));
  const stats = timingStats(waits);
  const waiting = stats.avg === null ? null : { avg: stats.avg, median: stats.median!, longest: Math.max(...waits) };
  const usual = track.timing === null ? null : { median24h: track.timing.last24h.steps[step].median, p9024h: track.timing.last24h.steps[step].p90, median7d: track.timing.last7d.steps[step].median };
  return {
    step,
    direction: track.direction,
    count: planets.length,
    usd,
    tokens,
    feesUsd,
    feesEstimated: planets.some((planet) => planet.feeUsd !== null && planet.feeEstimated),
    costUsd,
    waiting,
    usual,
    slower: waiting !== null && usual?.p9024h != null && waiting.median > usual.p9024h,
  };
};

/** The start of the local day containing `now`, in unix seconds. */
export const dayStartOf = (now: number): number => {
  const date = new Date(now * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
};
