/**
 * The in-flight orbits' model (mockup design/ui/screens/inflight-orbits.html): which of the four steps each transfer in
 * flight waits at, its planet (token colour, size, a core for $1,000 or more, a ring for $10,000 or more) and the tracks
 * of a pair, one per direction. Pure: the drawing lives in orbit-engine.ts.
 *
 * The status → step mapping (statuses from explorer/shared/src/status.ts):
 *
 * | Status                                   | Step         | What the transfer waits for                        |
 * | ---------------------------------------- | ------------ | -------------------------------------------------- |
 * | `sent`                                   | Sent         | its block to become final on the source chain      |
 * | `waiting_for_finality`                   | Final        | final; waits for a light-client update to cover it |
 * | `covered`, no destination transaction    | Proof posted | a head covers it; waits for a deliverer            |
 * | `covered`, with a destination transaction | Delivering  | a delivery is seen; its outcome is not settled     |
 * | `delivered`, `failed_call`, `release_failed` | none     | it has left the track                              |
 *
 * The indexer has no status between `covered` and the end states, so Delivering holds only a covered message whose
 * delivery transaction the data source already knows while its status has not settled; with the indexer's answers it
 * is usually empty.
 */
import type { ChainConfig, Direction, FeedItem, PairConfig, TokenInfo } from "@terminal/model/types";
import { chainsFor, transferSteps } from "../bridge/bridge-model";

/** The four steps of the track, left to right. */
export const ORBIT_STEPS = ["Sent", "Final", "Proof posted", "Delivering"] as const;

/** A step's index on the track. */
export type OrbitStep = 0 | 1 | 2 | 3;

/** What a transfer at each step waits for, for the list and screen readers. */
export const ORBIT_STEP_WORDS: Readonly<Record<OrbitStep, string>> = {
  0: "Sent, waiting for finality",
  1: "Final, waiting for the proof",
  2: "Proof posted, waiting for a deliverer",
  3: "Delivering",
};

/**
 * The step a transfer waits at, or null once it has left the track (delivered or failed).
 *
 * @param item The transfer's status and destination transaction.
 */
export const orbitStepOf = (item: Pick<FeedItem, "status" | "destinationTransactionHash">): OrbitStep | null => {
  switch (item.status) {
    case "sent":
      return 0;
    case "waiting_for_finality":
      return 1;
    case "covered":
      return item.destinationTransactionHash === null ? 2 : 3;
    default:
      return null;
  }
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

/** A plain planet, one with a core ($1,000 or more) or one with a core and a ring ($10,000 or more). */
export type PlanetTier = "plain" | "core" | "ring";

/** The tier of a dollar value; no price is plain. */
export const planetTier = (usd: number | null): PlanetTier => (usd === null ? "plain" : usd >= 10_000 ? "ring" : usd >= 1_000 ? "core" : "plain");

/** A planet's radius: 7, growing a little with value (at most 9.5), so sizes stay close (owner: little size variation). */
export const planetRadius = (usd: number | null): number => (usd === null || usd <= 0 ? 7 : 7 + Math.min(2.5, Math.max(0, Math.log10(usd) - 1) * 0.8));

/** One transfer in flight, as a planet. */
export type Planet = {
  readonly id: FeedItem["id"];
  readonly step: OrbitStep;
  readonly tone: PlanetTone;
  readonly tier: PlanetTier;
  readonly radius: number;
  readonly usd: number | null;
  readonly token: TokenInfo | null;
  readonly amount: bigint | null;
  readonly source: ChainConfig;
  readonly destination: ChainConfig;
  readonly recipient: FeedItem["recipient"];
  readonly sentAt: number;
  /** Seconds left, from the step estimates; 0 means any moment. */
  readonly leftSeconds: number;
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
  readonly counts: readonly [number, number, number, number];
  /** Transfers at each step that are not drawn (the "+N" label). */
  readonly overflow: readonly [number, number, number, number];
  readonly deliveredToday: number;
};

/** The planets drawn at most per step. */
export const PLANET_CAP = 60;

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
  // The plan's rows: sent, final, proof, the light client checks, delivered. A step waits for the row after it.
  const waitsFor = [1, 2, 4, 4][step]!;
  const after = plan.slice(waitsFor + 1).reduce((sum, seconds) => sum + seconds, 0);
  return Math.max(0, Math.round(Math.max(after, total - ageSeconds)));
};

/** The input of {@link orbitTracks}. */
export type OrbitInput = {
  readonly pair: PairConfig;
  /** Transfers in flight (any order; repeats are dropped). Ones that have left the track are ignored. */
  readonly inFlight: readonly FeedItem[];
  /** Delivered transfers; those delivered at or after `dayStart` count as delivered today. */
  readonly delivered: readonly FeedItem[];
  /** A token's dollar price, or null. */
  readonly priceOf: (token: TokenInfo) => number | null;
  /** Unix seconds now. */
  readonly now: number;
  /** Unix seconds of the start of today. */
  readonly dayStart: number;
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
    const planets: Planet[] = [];
    for (const item of unique) {
      if (item.direction !== direction) continue;
      const step = orbitStepOf(item);
      if (step === null) continue;
      const usd = usdOf(item, input.priceOf);
      planets.push({
        id: item.id,
        step,
        tone: planetTone(toneKey(item.token)),
        tier: planetTier(usd),
        radius: planetRadius(usd),
        usd,
        token: item.token,
        amount: item.amount,
        source,
        destination,
        recipient: item.recipient,
        sentAt: item.sentAt,
        leftSeconds: orbitLeftSeconds(step, source, destination, input.now - item.sentAt),
      });
    }
    planets.sort((a, b) => a.step - b.step || a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const counts: [number, number, number, number] = [0, 0, 0, 0];
    for (const planet of planets) counts[planet.step]++;
    const drawnPer: [number, number, number, number] = [0, 0, 0, 0];
    const drawn = planets.filter((planet) => drawnPer[planet.step]! < cap && (drawnPer[planet.step]++, true));
    const overflow = counts.map((count) => Math.max(0, count - cap)) as unknown as [number, number, number, number];
    const deliveredIds = new Set<string>();
    for (const item of input.delivered) if (item.direction === direction && item.deliveredAt !== null && item.deliveredAt >= input.dayStart) deliveredIds.add(item.id);
    return { direction, from: source, to: destination, planets, drawn, counts, overflow, deliveredToday: deliveredIds.size };
  });
};

/** The start of the local day containing `now`, in unix seconds. */
export const dayStartOf = (now: number): number => {
  const date = new Date(now * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
};
