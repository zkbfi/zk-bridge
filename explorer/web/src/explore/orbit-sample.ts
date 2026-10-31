/**
 * Sample transfers in flight for the sample data (VITE_EXPLORER_DATA=fixture), so the orbits have planets to show. A
 * steady stream: one transfer may start in each direction every 30 seconds of the wall clock, and each one's step comes
 * from its age, so on every poll new ones appear at Sent, some move a step on and the oldest leave as delivered.
 * Deterministic for a given clock.
 */
import type { Direction, FeedItem, PairConfig, TokenInfo } from "@terminal/model/types";
import type { Hex } from "viem";

/** Seconds between possible starts, per direction. */
const CADENCE = 30;

/** Seconds a sample transfer waits at each step, per direction (Ethereum finality is slower than PulseChain's). */
const STEP_SECONDS: Readonly<Record<Direction, readonly [number, number, number, number]>> = {
  "first-to-second": [480, 180, 150, 90],
  "second-to-first": [420, 180, 150, 90],
};

const mix = (value: number): number => {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
};

const hex = (value: number, width: number): string => value.toString(16).padStart(width, "0").slice(-width);

/** A dollar size spread from $5 to $40,000, most of them small. */
const unitsFor = (draw: number): number => Math.exp(Math.log(5) + ((draw % 10_000) / 10_000) * (Math.log(40_000) - Math.log(5)));

/** Sample dollar prices, matching use-prices' sample prices. */
const SAMPLE_USD: Readonly<Record<string, number>> = { USDC: 1, WETH: 3000, ETH: 3000, WPLS: 0.00003, PLS: 0.00003 };

/**
 * The sample transfers in flight, and those delivered today, at a wall clock.
 *
 * @param pair The pair.
 * @param tokens The pair's tokens.
 * @param wallSeconds The wall clock in unix seconds (it drives the stream).
 * @param now The page's clock in unix seconds (sent times are relative to it).
 */
export const orbitSample = (pair: PairConfig, tokens: readonly TokenInfo[], wallSeconds: number, now: number): { readonly inFlight: readonly FeedItem[]; readonly delivered: readonly FeedItem[] } => {
  const inFlight: FeedItem[] = [];
  const delivered: FeedItem[] = [];
  (["first-to-second", "second-to-first"] as const).forEach((direction, d) => {
    const steps = STEP_SECONDS[direction];
    const life = steps.reduce((sum, seconds) => sum + seconds, 0);
    const side = direction === "first-to-second" ? "first" : "second";
    const own = tokens.filter((token) => token.side === side);
    const latest = Math.floor(wallSeconds / CADENCE);
    // Starts within one life are in flight; the 30 before them were delivered recently.
    for (let slot = latest; slot > latest - Math.ceil(life / CADENCE) - 30; slot--) {
      const seed = mix(slot * 2 + d + 1);
      if (seed % 10 >= 7) continue;
      const age = wallSeconds - slot * CADENCE - (seed % CADENCE) * 0.5;
      if (age < 0) continue;
      let at = 0;
      let elapsed = age;
      while (at < 4 && elapsed >= steps[at]! * (0.6 + ((seed >>> (at * 3)) % 9) / 10)) elapsed -= steps[at]! * (0.6 + ((seed >>> (at * 3)) % 9) / 10), at++;
      const token = own.length === 0 ? null : own[(seed >>> 8) % own.length]!;
      const price = token === null ? null : (SAMPLE_USD[token.symbol.replace(/^zkb/i, "")] ?? 1);
      const units = price === null ? 0 : unitsFor(mix(seed)) / price;
      const amount = token === null ? null : BigInt(Math.max(1, Math.round(units * 1e6))) * 10n ** BigInt(Math.max(0, token.decimals - 6));
      const id = `0x${hex(0x0b17, 4)}${hex(d, 4)}${hex(slot, 16)}${"0".repeat(40)}` as Hex;
      const sentAt = Math.round(now - age);
      const item: FeedItem = {
        id,
        kind: token === null ? "message" : "token",
        direction,
        status: at === 0 ? "sent" : at === 1 ? "waiting_for_finality" : at < 4 ? "covered" : "delivered",
        sender: `0x${hex(mix(seed + 1), 8)}${"1".repeat(32)}` as Hex,
        recipient: `0x${hex(mix(seed + 2), 8)}${"2".repeat(24)}${hex(mix(seed + 3), 8)}` as Hex,
        token,
        amount,
        sentAt,
        deliveredAt: at === 4 ? Math.min(now, Math.round(sentAt + life)) : null,
        sourceTransactionHash: `0x${hex(mix(seed + 4), 8)}${"3".repeat(56)}` as Hex,
        destinationTransactionHash: at >= 3 ? (`0x${hex(mix(seed + 5), 8)}${"4".repeat(56)}` as Hex) : null,
      };
      (at === 4 ? delivered : inFlight).push(item);
    }
  });
  return { inFlight, delivered };
};
