/**
 * The interface cutover before a fork (known-issues 1.5 and 1.6, red-team HB-02 window 2): a light client's program key
 * fixes the fork schedule it understands, and no contract can see a fork before it activates. A send in the last hours
 * before a fork that the light client on the other chain cannot follow is stranded. The cure lives in the interface:
 * refuse sends from twelve hours (and at least three epochs) before the next scheduled fork of the source chain, until
 * the light client on the destination chain that follows the source has a finalized head past the fork's first slot.
 * Owner, 2026-11-10 (seal-only gate): the gate no longer checks the fork on a send, so the frontends pause 12 hours
 * before every scheduled fork.
 *
 * Owner, 2026-11-10 (mainnet readiness, A6): the interface stops offering the route before a fork that is scheduled and
 * resumes it once the destination light client is shown to follow the fork.
 *
 * One implementation for the dapp, the terminal and the status service. Pure: no I/O, no clock (the caller passes
 * `nowSeconds`), deterministic. The reads of the beacon node and the light client head are in `fork-cutover-source.ts`
 * and in `@zkb/data`.
 *
 * When the source chain's beacon node cannot be reached, the decision uses the newest saved copy of the schedule: the
 * last one this program fetched ({@link ForkScheduleCopy}, kept by each program where it can) or the one bundled with the
 * release ({@link bundledForkSchedule}), and says which ({@link chooseSourceForks}). Only when no copy is at most seven
 * days old are sends refused (`blocked`); `docs/audit/known-issues.md` 1.5.
 */
import { BUNDLED_FORK_SCHEDULE_ANSWERS } from "./bundled-fork-schedules.js";
import { formatDuration } from "./format.js";

/** The lead before a fork in seconds: twelve hours. */
export const CUTOVER_LEAD_SECONDS = 43_200;

/** How old the newest copy of a fork schedule may be for the decision to use it when no beacon node answers: seven days. */
export const SCHEDULE_COPY_MAX_AGE_SECONDS = 7 * 86_400;

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

/** The lead before a fork on a chain, in seconds: twelve hours or three epochs, whichever is longer. */
export const cutoverLeadSeconds = (clock: ForkCutoverClock): number => Math.max(CUTOVER_LEAD_SECONDS, CUTOVER_LEAD_EPOCHS * clock.slotsPerEpoch * clock.secondsPerSlot);

/** A fork on a chain's clock: its first slot and the second it starts. */
export const forkMomentOf = (entry: ForkScheduleEntry, clock: ForkCutoverClock): ForkMoment => {
  const slot = entry.epoch * clock.slotsPerEpoch;
  return { version: entry.version, name: entry.name, epoch: entry.epoch, slot, time: clock.genesisTime + slot * clock.secondsPerSlot };
};

/** A saved fork schedule of a chain: what a beacon node answered at `fetchedAt` (seconds since 1970). */
export type ForkScheduleCopy = { readonly forks: readonly ForkScheduleEntry[]; readonly clock: ForkCutoverClock; readonly fetchedAt: number };

/** Where a schedule came from when the beacon node did not answer: the copy this program saved, or the copy of the release. */
export type ScheduleCopyOrigin = {
  readonly origin: "cache" | "bundled";
  /** When the copy was fetched from a beacon node, seconds since 1970. */
  readonly fetchedAt: number;
  /** Why the beacon node gave no schedule now. It holds no URL. */
  readonly liveFailure: string;
};

/**
 * The source chain's fork schedule and clock, or that none can be used. `copy` is set when the schedule is a saved copy,
 * because the beacon node did not answer; absent, it came from the beacon node now.
 */
export type SourceForks =
  | { readonly kind: "known"; readonly forks: readonly ForkScheduleEntry[]; readonly clock: ForkCutoverClock; readonly copy?: ScheduleCopyOrigin }
  | {
      readonly kind: "unreachable";
      readonly reason: string;
      /** The fetch time of the newest copy, which is older than {@link SCHEDULE_COPY_MAX_AGE_SECONDS}; null when there is no copy. Absent: no copy was looked for. */
      readonly newestCopyAt?: number | null;
    };

/**
 * The schedule the decision uses: the beacon node's when it answered; otherwise the newer of the saved copy and the bundled
 * copy while it is at most {@link SCHEDULE_COPY_MAX_AGE_SECONDS} old (a tie goes to the saved copy); otherwise none.
 *
 * @param input.live What the beacon node answered now.
 * @param input.cached The copy this program saved last, or null.
 * @param input.bundled The copy of the release, or null.
 * @param input.nowSeconds The time now.
 */
export const chooseSourceForks = (input: { readonly live: SourceForks; readonly cached: ForkScheduleCopy | null; readonly bundled: ForkScheduleCopy | null; readonly nowSeconds: number }): SourceForks => {
  const { live, cached, bundled } = input;
  if (live.kind === "known") return live;
  const pick: { readonly origin: "cache" | "bundled"; readonly copy: ForkScheduleCopy } | null =
    cached !== null && (bundled === null || cached.fetchedAt >= bundled.fetchedAt) ? { origin: "cache", copy: cached } : bundled === null ? null : { origin: "bundled", copy: bundled };
  if (pick === null) return { kind: "unreachable", reason: live.reason, newestCopyAt: null };
  if (input.nowSeconds - pick.copy.fetchedAt > SCHEDULE_COPY_MAX_AGE_SECONDS) return { kind: "unreachable", reason: live.reason, newestCopyAt: pick.copy.fetchedAt };
  return { kind: "known", forks: pick.copy.forks, clock: pick.copy.clock, copy: { origin: pick.origin, fetchedAt: pick.copy.fetchedAt, liveFailure: live.reason } };
};

/**
 * The fork schedule of a chain bundled with this release (`scripts/fetch-fork-schedules.mjs` writes it at release time),
 * or null for a chain it does not hold.
 *
 * @param chainId The chain.
 */
export const bundledForkSchedule = (chainId: number): ForkScheduleCopy | null => {
  const answer = BUNDLED_FORK_SCHEDULE_ANSWERS[chainId];
  if (answer === undefined) return null;
  return {
    forks: parseForkSchedule({ data: answer.forkSchedule }),
    clock: { genesisTime: answer.genesisTime, secondsPerSlot: answer.secondsPerSlot, slotsPerEpoch: answer.slotsPerEpoch },
    fetchedAt: answer.fetchedAt,
  };
};

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

/** The verdict for one direction. `schedule` is set on `open` and `paused` when the schedule was a saved copy. */
export type ForkCutoverVerdict =
  /** Sends are allowed. `next` is the next fork the destination light client has not followed, with the time its pause starts. */
  | { readonly kind: "open"; readonly next: ForkMoment | null; readonly pausesAt: number | null; readonly secondsToPause: number | null; readonly schedule?: ScheduleCopyOrigin }
  /** Sends are refused: the pause started at `pausedSince` and lasts until the light client head is past `fork.slot`. */
  | { readonly kind: "paused"; readonly destinationChainId: number; readonly fork: ForkMoment; readonly pausedSince: number; readonly lightClientHead: bigint | null; readonly leadSeconds: number; readonly schedule?: ScheduleCopyOrigin }
  /** No beacon node answered and no copy of the schedule is at most seven days old. Sends are refused until one answers. */
  | { readonly kind: "blocked"; readonly reason: "no-fork-schedule"; readonly detail: string; readonly newestCopyAt: number | null }
  /** The light client head could not be read after a fork. Sends are allowed, with a warning. */
  | { readonly kind: "unknown"; readonly reason: "light-client-unreadable"; readonly detail: string };

/** Whether the interface offers sends: everything but `paused` and `blocked`. */
export const isSendAllowed = (verdict: ForkCutoverVerdict): boolean => verdict.kind !== "paused" && verdict.kind !== "blocked";

/**
 * Decides whether sends from the source chain are allowed. Takes the earliest scheduled fork whose first slot the
 * destination light client's finalized head has not passed. From the lead before it, sends are paused; the pause ends
 * when the head is past the first slot. A fork at epoch 0 is the genesis fork and is skipped.
 *
 * @param input The schedule, the head of the destination light client and the time.
 */
export const decideForkCutover = (input: ForkCutoverInput): ForkCutoverVerdict => {
  const { source, lightClientHead, nowSeconds } = input;
  if (source.kind === "unreachable") return { kind: "blocked", reason: "no-fork-schedule", detail: source.reason, newestCopyAt: source.newestCopyAt ?? null };
  const lead = cutoverLeadSeconds(source.clock);
  const copy = source.copy === undefined ? {} : { schedule: source.copy };
  for (const entry of source.forks) {
    if (entry.epoch === 0) continue;
    const fork = forkMomentOf(entry, source.clock);
    if (lightClientHead !== null && lightClientHead > BigInt(fork.slot)) continue;
    // With no head to compare, a fork six hours or more in the past counts as followed: only a recent one leaves the question open.
    if (lightClientHead === null && fork.time + UNREADABLE_HEAD_GRACE_SECONDS < nowSeconds) continue;
    const pausesAt = fork.time - lead;
    if (nowSeconds < pausesAt) return { kind: "open", next: fork, pausesAt, secondsToPause: pausesAt - nowSeconds, ...copy };
    if (lightClientHead === null && nowSeconds >= fork.time) return { kind: "unknown", reason: "light-client-unreadable", detail: "the light client's head could not be read" };
    return { kind: "paused", destinationChainId: input.destinationChainId, fork, pausedSince: pausesAt, lightClientHead, leadSeconds: lead, ...copy };
  }
  return { kind: "open", next: null, pausesAt: null, secondsToPause: null, ...copy };
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
  /** Which saved copy of the schedule the verdict used, when the beacon node did not answer; null when it answered. */
  readonly scheduleNote: string | null;
};

const scheduleNoteOf = (verdict: ForkCutoverVerdict, source: string, nowSeconds: number): string | null => {
  if ((verdict.kind !== "open" && verdict.kind !== "paused") || verdict.schedule === undefined) return null;
  const { origin, fetchedAt } = verdict.schedule;
  return `${source}'s beacon node did not answer, so this uses the fork schedule ${origin === "cache" ? "saved by this app" : "bundled with this release"} at ${utcText(fetchedAt, nowSeconds)}.`;
};

/**
 * The copy of a verdict: what happens and when, in hard numbers.
 *
 * @param verdict The verdict.
 * @param names The names of the source and destination chains.
 * @param nowSeconds The time now.
 */
export const forkCutoverText = (verdict: ForkCutoverVerdict, names: { readonly source: string; readonly destination: string }, nowSeconds: number): ForkCutoverText => {
  const scheduleNote = scheduleNoteOf(verdict, names.source, nowSeconds);
  switch (verdict.kind) {
    case "open": {
      if (verdict.next === null || verdict.pausesAt === null || verdict.secondsToPause === null) return { headline: null, countdown: null, sendable: true, scheduleNote };
      const lead = leadText(verdict.next.time - verdict.pausesAt);
      return {
        headline: `Sends from ${names.source} pause at ${utcText(verdict.pausesAt, nowSeconds)}, ${lead} before the ${verdict.next.name} fork (epoch ${verdict.next.epoch}) at ${utcText(verdict.next.time, nowSeconds)}. They resume once ${names.destination}'s light client follows the fork.`,
        countdown: `Sends pause in ${formatDuration(verdict.secondsToPause)}`,
        sendable: true,
        scheduleNote,
      };
    }
    case "paused": {
      const head = verdict.lightClientHead === null ? "is not known" : `is slot ${verdict.lightClientHead}`;
      const when = verdict.fork.time > nowSeconds ? `starts in ${formatDuration(verdict.fork.time - nowSeconds)}` : `started ${formatDuration(nowSeconds - verdict.fork.time)} ago`;
      return {
        headline: `Sends from ${names.source} are paused since ${utcText(verdict.pausedSince, nowSeconds)}: the ${verdict.fork.name} fork (epoch ${verdict.fork.epoch}) ${when}. They resume once ${names.destination}'s light client's finalized head is past slot ${verdict.fork.slot}; it ${head} now.`,
        countdown: null,
        sendable: false,
        scheduleNote,
      };
    }
    case "blocked":
      return {
        headline:
          verdict.newestCopyAt === null
            ? `Sends from ${names.source} wait: ${names.source}'s beacon node did not answer, and no copy of its fork schedule is at hand, so a fork in the next 12 hours cannot be ruled out. Sends resume once a beacon node answers (Settings, Beacon endpoints).`
            : `Sends from ${names.source} wait: ${names.source}'s beacon node did not answer, and the newest copy of its fork schedule is from ${utcText(verdict.newestCopyAt, nowSeconds)}, more than 7 days old. Sends resume once a beacon node answers (Settings, Beacon endpoints).`,
        countdown: null,
        sendable: false,
        scheduleNote: null,
      };
    case "unknown":
      return {
        headline: `${names.destination}'s light client head could not be read, so whether it follows the latest ${names.source} fork is not known. Sends are offered; a send just before a fork would be stranded.`,
        countdown: null,
        sendable: true,
        scheduleNote: null,
      };
  }
};
