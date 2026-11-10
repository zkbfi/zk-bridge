/**
 * The interface cutover before a fork (known-issues 1.5 and 1.6, red-team HB-02 window 2): a light client's program key
 * fixes the fork schedule it understands, and no contract can see a fork before it activates. A send in the last minutes
 * before a fork that the light client on the other chain cannot follow is stranded. The cure lives in the interface:
 * refuse sends from one hour (and at least three epochs) before the next scheduled fork of the source chain, until the
 * light client on the destination chain that follows the source has a finalized head past the fork's first slot.
 *
 * Owner, 2026-11-10 (mainnet readiness, A6): the interface stops offering the route before a fork that is scheduled and
 * resumes it once the destination light client is shown to follow the fork.
 *
 * One implementation for the dapp, the terminal and the status service. Pure: no I/O, no clock (the caller passes
 * `nowSeconds`), deterministic. The reads of the beacon node and the light client head are in `fork-cutover-source.ts`
 * and in `@zkb/data`.
 *
 * When the source chain's beacon node cannot be reached the verdict is `unknown` and the send is allowed with a warning
 * (see {@link isSendAllowed}); the reason is in `docs/audit/known-issues.md` 1.5.
 */
import { formatDuration } from "./format.js";

/** The lead before a fork in seconds: one hour. */
export const CUTOVER_LEAD_SECONDS = 3600;

/** The lead before a fork in epochs: at least three. The lead is the larger of the two. */
export const CUTOVER_LEAD_EPOCHS = 3;

/** The epoch that a beacon node reports for a fork that is not scheduled: 2^64 - 1. */
const FAR_FUTURE_EPOCH = 18446744073709551615n;

/** With the light client's head unreadable, a fork older than this (six hours) counts as followed. */
const UNREADABLE_HEAD_GRACE_SECONDS = 21_600;

/** The forks in their order, as the beacon chain names them. A schedule lists them in this order, so the position names the fork. */
export const FORK_NAMES: readonly string[] = ["Phase 0", "Altair", "Bellatrix", "Capella", "Deneb", "Electra", "Fulu", "Gloas", "Heze"];

/** The clock of a beacon chain, as the beacon node reports it: the start of slot 0 and the lengths of a slot and of an epoch. */
export type ForkCutoverClock = { readonly genesisTime: number; readonly secondsPerSlot: number; readonly slotsPerEpoch: number };

/** One scheduled fork of `GET /eth/v1/config/fork_schedule`. */
export type ForkScheduleEntry = { readonly version: string; readonly epoch: number; readonly name: string };

/** A fork placed on the clock. */
export type ForkMoment = { readonly version: string; readonly name: string; readonly epoch: number; readonly slot: number; readonly time: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The forks of a beacon node's `GET /eth/v1/config/fork_schedule` answer: entries that are not scheduled (epoch 2^64 - 1) are
 * dropped, the rest are sorted by epoch, and each is named by its position in the full list.
 *
 * @param body The parsed JSON of the answer.
 * @throws Error when the body is not a fork schedule.
 */
export const parseForkSchedule = (body: unknown): readonly ForkScheduleEntry[] => {
  const bad = (): never => {
    throw new Error("the beacon node sent a fork schedule of another form");
  };
  if (!isRecord(body) || !Array.isArray(body.data)) return bad();
  const entries: ForkScheduleEntry[] = [];
  body.data.forEach((item: unknown, index: number) => {
    if (!isRecord(item) || typeof item.current_version !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(item.current_version) || typeof item.epoch !== "string" || !/^[0-9]+$/.test(item.epoch)) {
      bad();
      return;
    }
    const epoch = BigInt(item.epoch);
    if (epoch >= FAR_FUTURE_EPOCH) return;
    entries.push({ version: item.current_version.toLowerCase(), epoch: Number(epoch), name: FORK_NAMES[index] ?? `fork ${item.current_version.toLowerCase()}` });
  });
  return entries.sort((left, right) => left.epoch - right.epoch);
};

/**
 * The genesis time of `GET /eth/v1/beacon/genesis`, in seconds since 1970.
 *
 * @throws Error when the body is not a genesis answer.
 */
export const parseBeaconGenesisTime = (body: unknown): number => {
  const time = isRecord(body) && isRecord(body.data) ? body.data.genesis_time : undefined;
  if (typeof time !== "string" || !/^[0-9]+$/.test(time)) throw new Error("the beacon node sent a genesis answer of another form");
  return Number(time);
};

/**
 * The slot and epoch lengths of `GET /eth/v1/config/spec`.
 *
 * @throws Error when the body is not a spec answer.
 */
export const parseBeaconSpec = (body: unknown): { readonly secondsPerSlot: number; readonly slotsPerEpoch: number } => {
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const secondsPerSlot = Number(data.SECONDS_PER_SLOT);
  const slotsPerEpoch = Number(data.SLOTS_PER_EPOCH);
  if (!(secondsPerSlot > 0) || !(slotsPerEpoch > 0)) throw new Error("the beacon node sent a spec answer of another form");
  return { secondsPerSlot, slotsPerEpoch };
};

/** The lead before a fork on a chain, in seconds: one hour or three epochs, whichever is longer. */
export const cutoverLeadSeconds = (clock: ForkCutoverClock): number => Math.max(CUTOVER_LEAD_SECONDS, CUTOVER_LEAD_EPOCHS * clock.slotsPerEpoch * clock.secondsPerSlot);

/** A fork on a chain's clock: its first slot and the second it starts. */
export const forkMomentOf = (entry: ForkScheduleEntry, clock: ForkCutoverClock): ForkMoment => {
  const slot = entry.epoch * clock.slotsPerEpoch;
  return { version: entry.version, name: entry.name, epoch: entry.epoch, slot, time: clock.genesisTime + slot * clock.secondsPerSlot };
};

/** What the source chain's beacon node told: its schedule and clock, or that it could not be reached. */
export type SourceForks =
  | { readonly kind: "known"; readonly forks: readonly ForkScheduleEntry[]; readonly clock: ForkCutoverClock }
  | { readonly kind: "unreachable"; readonly reason: string };

/** The inputs of {@link decideForkCutover}. */
export type ForkCutoverInput = {
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly source: SourceForks;
  /** The finalized head slot of the light client on the destination chain that follows the source, or null when it could not be read. */
  readonly lightClientHead: bigint | null;
  /** The time now, in seconds since 1970. */
  readonly nowSeconds: number;
};

/** The verdict for one direction. */
export type ForkCutoverVerdict =
  /** Sends are allowed. `next` is the next fork the destination light client has not followed, with the time its pause starts. */
  | { readonly kind: "open"; readonly next: ForkMoment | null; readonly pausesAt: number | null; readonly secondsToPause: number | null }
  /** Sends are refused: the pause started at `pausedSince` and lasts until the light client head is past `fork.slot`. */
  | { readonly kind: "paused"; readonly destinationChainId: number; readonly fork: ForkMoment; readonly pausedSince: number; readonly lightClientHead: bigint | null; readonly leadSeconds: number }
  /** The schedule or the head could not be read. Sends are allowed, with a warning. */
  | { readonly kind: "unknown"; readonly reason: "beacon-unreachable" | "light-client-unreadable"; readonly detail: string };

/** Whether the interface offers sends: everything but `paused`. */
export const isSendAllowed = (verdict: ForkCutoverVerdict): boolean => verdict.kind !== "paused";

/**
 * Decides whether sends from the source chain are allowed. Takes the earliest scheduled fork whose first slot the
 * destination light client's finalized head has not passed. From the lead before it, sends are paused; the pause ends
 * when the head is past the first slot. A fork at epoch 0 is the genesis fork and is skipped.
 *
 * @param input The schedule, the head of the destination light client and the time.
 */
export const decideForkCutover = (input: ForkCutoverInput): ForkCutoverVerdict => {
  const { source, lightClientHead, nowSeconds } = input;
  if (source.kind === "unreachable") return { kind: "unknown", reason: "beacon-unreachable", detail: source.reason };
  const lead = cutoverLeadSeconds(source.clock);
  for (const entry of source.forks) {
    if (entry.epoch === 0) continue;
    const fork = forkMomentOf(entry, source.clock);
    if (lightClientHead !== null && lightClientHead > BigInt(fork.slot)) continue;
    // With no head to compare, a fork six hours or more in the past counts as followed: only a recent one leaves the question open.
    if (lightClientHead === null && fork.time + UNREADABLE_HEAD_GRACE_SECONDS < nowSeconds) continue;
    const pausesAt = fork.time - lead;
    if (nowSeconds < pausesAt) return { kind: "open", next: fork, pausesAt, secondsToPause: pausesAt - nowSeconds };
    if (lightClientHead === null && nowSeconds >= fork.time) return { kind: "unknown", reason: "light-client-unreadable", detail: "the light client's head could not be read" };
    return { kind: "paused", destinationChainId: input.destinationChainId, fork, pausedSince: pausesAt, lightClientHead, leadSeconds: lead };
  }
  return { kind: "open", next: null, pausesAt: null, secondsToPause: null };
};

/**
 * A time as text in UTC: `14:02 UTC`, or `2026-11-14 14:02 UTC` when it is a day or more away from `nowSeconds`.
 *
 * @param seconds The time in seconds since 1970.
 * @param nowSeconds The time now.
 */
export const utcText = (seconds: number, nowSeconds: number): string => {
  const iso = new Date(seconds * 1000).toISOString();
  return Math.abs(seconds - nowSeconds) >= 86_400 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : `${iso.slice(11, 16)} UTC`;
};

const leadText = (seconds: number): string => (seconds % 3600 === 0 ? `${seconds / 3600} h` : formatDuration(seconds));

/** The words that every program shows for a verdict. */
export type ForkCutoverText = {
  /** What happens, with the numbers. Null when no fork is ahead. */
  readonly headline: string | null;
  /** The countdown line before the pause, or null. */
  readonly countdown: string | null;
  /** Whether a send is offered. */
  readonly sendable: boolean;
};

/**
 * The copy of a verdict: what happens and when, in hard numbers.
 *
 * @param verdict The verdict.
 * @param names The names of the source and destination chains.
 * @param nowSeconds The time now.
 */
export const forkCutoverText = (verdict: ForkCutoverVerdict, names: { readonly source: string; readonly destination: string }, nowSeconds: number): ForkCutoverText => {
  switch (verdict.kind) {
    case "open": {
      if (verdict.next === null || verdict.pausesAt === null || verdict.secondsToPause === null) return { headline: null, countdown: null, sendable: true };
      const lead = leadText(verdict.next.time - verdict.pausesAt);
      return {
        headline: `Sends from ${names.source} pause at ${utcText(verdict.pausesAt, nowSeconds)}, ${lead} before the ${verdict.next.name} fork (epoch ${verdict.next.epoch}) at ${utcText(verdict.next.time, nowSeconds)}. They resume once ${names.destination}'s light client follows the fork.`,
        countdown: `Sends pause in ${formatDuration(verdict.secondsToPause)}`,
        sendable: true,
      };
    }
    case "paused": {
      const head = verdict.lightClientHead === null ? "is not known" : `is slot ${verdict.lightClientHead}`;
      const when = verdict.fork.time > nowSeconds ? `starts in ${formatDuration(verdict.fork.time - nowSeconds)}` : `started ${formatDuration(nowSeconds - verdict.fork.time)} ago`;
      return {
        headline: `Sends from ${names.source} are paused since ${utcText(verdict.pausedSince, nowSeconds)}: the ${verdict.fork.name} fork (epoch ${verdict.fork.epoch}) ${when}. They resume once ${names.destination}'s light client's finalized head is past slot ${verdict.fork.slot}; it ${head} now.`,
        countdown: null,
        sendable: false,
      };
    }
    case "unknown":
      return {
        headline:
          verdict.reason === "beacon-unreachable"
            ? `${names.source}'s beacon node did not answer, so the next fork of ${names.source} is not known. Sends are offered; a send just before a fork would be stranded.`
            : `${names.destination}'s light client head could not be read, so whether it follows the latest ${names.source} fork is not known. Sends are offered; a send just before a fork would be stranded.`,
        countdown: null,
        sendable: true,
      };
  }
};
