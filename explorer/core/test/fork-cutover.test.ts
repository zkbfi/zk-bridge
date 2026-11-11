import { describe, expect, it } from "vitest";
import {
  CUTOVER_LEAD_EPOCHS,
  CUTOVER_LEAD_SECONDS,
  FORK_NAMES,
  SCHEDULE_COPY_MAX_AGE_SECONDS,
  bundledForkSchedule,
  chooseSourceForks,
  cutoverLeadSeconds,
  decideForkCutover,
  forkCutoverText,
  forkMomentOf,
  isSendAllowed,
  parseBeaconGenesisTime,
  parseBeaconSpec,
  parseForkSchedule,
  utcText,
  type ForkCutoverClock,
  type ForkCutoverInput,
  type ForkScheduleCopy,
} from "../src/index.js";
import { BUNDLED_FORK_SCHEDULE_ANSWERS } from "../src/bundled-fork-schedules.js";

const clock: ForkCutoverClock = { genesisTime: 1_000_000, secondsPerSlot: 12, slotsPerEpoch: 32 };
const EPOCH_SECONDS = 384;
const FAR = "18446744073709551615";

const scheduleBody = {
  data: [
    { previous_version: "0x90000069", current_version: "0x90000069", epoch: "0" },
    { previous_version: "0x90000069", current_version: "0x90000070", epoch: "50" },
    { previous_version: "0x90000070", current_version: "0x90000071", epoch: "100" },
    { previous_version: "0x90000071", current_version: "0x90000072", epoch: "200" },
    { previous_version: "0x90000072", current_version: "0x90000073", epoch: "300" },
    { previous_version: "0x90000073", current_version: "0x90000074", epoch: "400" },
    { previous_version: "0x90000074", current_version: "0x90000075", epoch: "500" },
    { previous_version: "0x90000075", current_version: "0x90000076", epoch: FAR },
  ],
};
const forks = parseForkSchedule(scheduleBody);
const fulu = forks[6]!;
const fuluTime = clock.genesisTime + 500 * EPOCH_SECONDS;

const known = (list = forks) => ({ kind: "known" as const, forks: list, clock });
const input = (over: Partial<ForkCutoverInput>): ForkCutoverInput => ({
  sourceChainId: 11155111,
  destinationChainId: 943,
  source: known(),
  lightClientHead: BigInt(500 * 32 + 5),
  nowSeconds: fuluTime + 10_000,
  ...over,
});

describe("parsing", () => {
  it("reads the schedule, drops far-future entries, sorts by epoch and names forks by order", () => {
    expect(forks.map((f) => f.epoch)).toEqual([0, 50, 100, 200, 300, 400, 500]);
    expect(forks[6]).toEqual({ version: "0x90000075", epoch: 500, name: "Fulu" });
    expect(FORK_NAMES[0]).toBe("Phase 0");
  });
  it("names a fork beyond the known list by its version", () => {
    const body = { data: Array.from({ length: 12 }, (_, i) => ({ previous_version: "0x00000000", current_version: `0x0${i.toString(16)}000000`, epoch: String(i) })) };
    const parsed = parseForkSchedule(body);
    expect(parsed[11]!.name).toBe("fork 0x0b000000");
  });
  it("sorts an unsorted schedule", () => {
    const parsed = parseForkSchedule({ data: [{ current_version: "0x02000000", epoch: "9" }, { current_version: "0x01000000", epoch: "3" }] });
    expect(parsed.map((f) => f.epoch)).toEqual([3, 9]);
  });
  it("keeps equal epochs in order", () => {
    const parsed = parseForkSchedule({ data: [{ current_version: "0x01000000", epoch: "3" }, { current_version: "0x02000000", epoch: "3" }] });
    expect(parsed.map((f) => f.version)).toEqual(["0x01000000", "0x02000000"]);
  });
  it("rejects bodies of another form", () => {
    expect(() => parseForkSchedule(null)).toThrow("fork schedule");
    expect(() => parseForkSchedule({ data: "x" })).toThrow("fork schedule");
    expect(() => parseForkSchedule({ data: [null] })).toThrow("fork schedule");
    expect(() => parseForkSchedule({ data: [{ current_version: 1, epoch: "1" }] })).toThrow("fork schedule");
    expect(() => parseForkSchedule({ data: [{ current_version: "0x01000000", epoch: "x" }] })).toThrow("fork schedule");
    expect(() => parseForkSchedule({ data: [{ current_version: "0x01", epoch: "1" }] })).toThrow("fork schedule");
  });
  it("reads genesis time and the spec", () => {
    expect(parseBeaconGenesisTime({ data: { genesis_time: "1655733600" } })).toBe(1655733600);
    expect(() => parseBeaconGenesisTime({ data: {} })).toThrow("genesis");
    expect(() => parseBeaconGenesisTime(7)).toThrow("genesis");
    expect(parseBeaconSpec({ data: { SECONDS_PER_SLOT: "10", SLOTS_PER_EPOCH: "32" } })).toEqual({ secondsPerSlot: 10, slotsPerEpoch: 32 });
    expect(() => parseBeaconSpec({ data: { SECONDS_PER_SLOT: "0", SLOTS_PER_EPOCH: "32" } })).toThrow("spec");
    expect(() => parseBeaconSpec({ data: { SECONDS_PER_SLOT: "x", SLOTS_PER_EPOCH: "32" } })).toThrow("spec");
    expect(() => parseBeaconSpec(null)).toThrow("spec");
    expect(() => parseBeaconSpec({ data: { SECONDS_PER_SLOT: "12" } })).toThrow("spec");
  });
});

describe("the lead", () => {
  it("is twelve hours while three epochs are shorter, and three epochs when they are longer", () => {
    expect(CUTOVER_LEAD_SECONDS).toBe(43_200);
    expect(CUTOVER_LEAD_EPOCHS).toBe(3);
    expect(cutoverLeadSeconds(clock)).toBe(43_200);
    expect(cutoverLeadSeconds({ genesisTime: 0, secondsPerSlot: 10, slotsPerEpoch: 32 })).toBe(43_200);
    expect(cutoverLeadSeconds({ genesisTime: 0, secondsPerSlot: 12, slotsPerEpoch: 32 * 64 })).toBe(3 * 12 * 2048);
  });
  it("places a fork in time", () => {
    expect(forkMomentOf(fulu, clock)).toEqual({ version: "0x90000075", name: "Fulu", epoch: 500, slot: 16000, time: fuluTime });
  });
});

describe("decideForkCutover", () => {
  it("is open with no fork ahead", () => {
    const verdict = decideForkCutover(input({}));
    expect(verdict).toEqual({ kind: "open", next: null, pausesAt: null, secondsToPause: null });
    expect(isSendAllowed(verdict)).toBe(true);
  });
  it("is open before the window and counts down to its start", () => {
    const now = fuluTime - 43_200 - 100;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: BigInt(499 * 32) }));
    expect(verdict).toMatchObject({ kind: "open", pausesAt: fuluTime - 43_200, secondsToPause: 100 });
    expect(verdict.kind === "open" && verdict.next?.name).toBe("Fulu");
    expect(verdict).not.toHaveProperty("schedule");
  });
  it("pauses from twelve hours before the fork", () => {
    const now = fuluTime - 43_200;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: BigInt(499 * 32) }));
    expect(verdict).toMatchObject({ kind: "paused", pausedSince: fuluTime - 43_200, lightClientHead: 15968n, leadSeconds: 43_200 });
    expect(isSendAllowed(verdict)).toBe(false);
  });
  it("stays paused after the fork until the light client head is past the fork's first slot", () => {
    const after = input({ nowSeconds: fuluTime + 5000, lightClientHead: 16000n });
    expect(decideForkCutover(after).kind).toBe("paused");
    expect(decideForkCutover({ ...after, lightClientHead: 16001n }).kind).toBe("open");
  });
  it("skips forks the light client already follows, and the genesis fork", () => {
    const verdict = decideForkCutover(input({ nowSeconds: fuluTime - 10, lightClientHead: 99_999n }));
    expect(verdict.kind).toBe("open");
  });
  it("pauses for an earlier fork the light client has not reached", () => {
    const verdict = decideForkCutover(input({ nowSeconds: fuluTime + 100_000, lightClientHead: BigInt(399 * 32) }));
    expect(verdict.kind === "paused" && verdict.fork.name).toBe("Electra");
  });
  it("is blocked, and refused, when no schedule can be used", () => {
    const verdict = decideForkCutover(input({ source: { kind: "unreachable", reason: "no answer" } }));
    expect(verdict).toEqual({ kind: "blocked", reason: "no-fork-schedule", detail: "no answer", newestCopyAt: null });
    expect(isSendAllowed(verdict)).toBe(false);
    expect(decideForkCutover(input({ source: { kind: "unreachable", reason: "no answer", newestCopyAt: 5 } }))).toMatchObject({ kind: "blocked", newestCopyAt: 5 });
  });
  it("decides from a saved copy and says so on every verdict", () => {
    const copy = { origin: "cache" as const, fetchedAt: fuluTime - 86_400, liveFailure: "no answer" };
    const source = { ...known(), copy };
    expect(decideForkCutover(input({ source }))).toEqual({ kind: "open", next: null, pausesAt: null, secondsToPause: null, schedule: copy });
    expect(decideForkCutover(input({ source, nowSeconds: fuluTime - 50_000, lightClientHead: 15000n }))).toMatchObject({ kind: "open", schedule: copy });
    expect(decideForkCutover(input({ source, nowSeconds: fuluTime - 600, lightClientHead: 15000n }))).toMatchObject({ kind: "paused", schedule: copy });
  });
  it("is open before the window when the light client head is unreadable, unknown after the fork", () => {
    expect(decideForkCutover(input({ source: known([fulu]), lightClientHead: null, nowSeconds: fuluTime - 50_000 })).kind).toBe("open");
    expect(decideForkCutover(input({ lightClientHead: null, nowSeconds: fuluTime + 10 }))).toMatchObject({ kind: "unknown", reason: "light-client-unreadable" });
  });
  it("pauses inside the window before the fork even when the head is unreadable (the fork cannot have been followed)", () => {
    expect(decideForkCutover(input({ lightClientHead: null, nowSeconds: fuluTime - 60 })).kind).toBe("paused");
  });
  it("with no forks at all, is open", () => {
    expect(decideForkCutover(input({ source: known([]) })).kind).toBe("open");
  });
});

describe("text", () => {
  const names = { source: "Sepolia", destination: "PulseChain testnet v4" };
  it("formats UTC times", () => {
    expect(utcText(Date.UTC(2026, 10, 12, 14, 2) / 1000, Date.UTC(2026, 10, 12, 9, 0) / 1000)).toBe("14:02 UTC");
    expect(utcText(Date.UTC(2026, 10, 14, 14, 2) / 1000, Date.UTC(2026, 10, 12, 9, 0) / 1000)).toBe("2026-11-14 14:02 UTC");
  });
  it("says what happens before the window with hard numbers", () => {
    const now = fuluTime - 46_800;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: 15000n }));
    const text = forkCutoverText(verdict, names, now);
    expect(text.headline).toContain("Sends from Sepolia pause at");
    expect(text.headline).toContain("12 h before the Fulu fork (epoch 500)");
    expect(text.headline).toContain("They resume once PulseChain testnet v4's light client follows the fork.");
    expect(text.countdown).toBe("Sends pause in 1h 00m");
    expect(text.sendable).toBe(true);
    expect(text.scheduleNote).toBeNull();
  });
  it("says what happens while paused", () => {
    const now = fuluTime - 600;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: 15000n }));
    const text = forkCutoverText(verdict, names, now);
    expect(text.sendable).toBe(false);
    expect(text.headline).toContain("Sends from Sepolia are paused");
    expect(text.headline).toContain("the Fulu fork (epoch 500) starts in 10m 00s");
    expect(text.headline).toContain("light client's finalized head is past slot 16000; it is slot 15000 now.");
  });
  it("says what happens after the fork while the light client catches up", () => {
    const now = fuluTime + 100;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: 15990n }));
    const text = forkCutoverText(verdict, names, now);
    expect(text.headline).toContain("started 1m 40s ago");
  });
  it("says it when the head is not known, and states a lead of three long epochs in minutes", () => {
    const now = fuluTime - 60;
    const paused = forkCutoverText(decideForkCutover(input({ lightClientHead: null, nowSeconds: now })), names, now);
    expect(paused.headline).toContain("it is not known now.");
    const long: ForkCutoverClock = { genesisTime: 0, secondsPerSlot: 12, slotsPerEpoch: 1250 };
    const verdict = decideForkCutover({ ...input({ lightClientHead: 0n, nowSeconds: 1000 }), source: { kind: "known", forks: [{ version: "0x01000000", epoch: 100, name: "Altair" }], clock: long } });
    expect(forkCutoverText(verdict, names, 1000).headline).toContain("12h 30m before"); // 3 epochs of 15000 s = 45000 s
  });
  it("says nothing when no fork is ahead, refuses with the reason when blocked, and warns when unknown", () => {
    expect(forkCutoverText(decideForkCutover(input({})), names, fuluTime)).toEqual({ headline: null, countdown: null, sendable: true, scheduleNote: null });
    const unreachable = forkCutoverText(decideForkCutover(input({ source: { kind: "unreachable", reason: "x", newestCopyAt: null } })), names, 0);
    expect(unreachable.sendable).toBe(false);
    expect(unreachable.headline).toBe("Sends from Sepolia wait: Sepolia's beacon node did not answer, and no copy of its fork schedule is at hand, so a fork in the next 12 hours cannot be ruled out. Sends resume once a beacon node answers (Settings, Beacon endpoints).");
    const stale = Date.UTC(2026, 10, 1, 9, 30) / 1000;
    const old = forkCutoverText(decideForkCutover(input({ source: { kind: "unreachable", reason: "x", newestCopyAt: stale } })), names, stale + 8 * 86_400);
    expect(old.headline).toContain("the newest copy of its fork schedule is from 2026-11-01 09:30 UTC, more than 7 days old");
    expect(old.scheduleNote).toBeNull();
    const noHead = forkCutoverText(decideForkCutover(input({ lightClientHead: null, nowSeconds: fuluTime + 10 })), names, fuluTime + 10);
    expect(noHead.headline).toContain("PulseChain testnet v4's light client head could not be read");
  });
});

describe("schedule copies", () => {
  const copyAt = (fetchedAt: number): ForkScheduleCopy => ({ forks, clock, fetchedAt });
  const live = { kind: "unreachable" as const, reason: "the beacon node did not answer (no answer for /eth/v1/config/fork_schedule (TimeoutError))" };
  const now = fuluTime;

  it("uses the beacon node's answer when there is one", () => {
    expect(chooseSourceForks({ live: known(), cached: copyAt(now), bundled: copyAt(now), nowSeconds: now })).toEqual(known());
  });
  it("uses the newer copy, the saved one on a tie, and names it", () => {
    expect(chooseSourceForks({ live, cached: copyAt(now - 100), bundled: copyAt(now - 200), nowSeconds: now })).toEqual({ ...known(), copy: { origin: "cache", fetchedAt: now - 100, liveFailure: live.reason } });
    expect(chooseSourceForks({ live, cached: copyAt(now - 300), bundled: copyAt(now - 200), nowSeconds: now })).toMatchObject({ copy: { origin: "bundled", fetchedAt: now - 200 } });
    expect(chooseSourceForks({ live, cached: copyAt(now - 200), bundled: copyAt(now - 200), nowSeconds: now })).toMatchObject({ copy: { origin: "cache" } });
    expect(chooseSourceForks({ live, cached: null, bundled: copyAt(now - 200), nowSeconds: now })).toMatchObject({ copy: { origin: "bundled" } });
    expect(chooseSourceForks({ live, cached: copyAt(now - 200), bundled: null, nowSeconds: now })).toMatchObject({ copy: { origin: "cache" } });
  });
  it("uses a copy up to seven days old, and none older", () => {
    expect(SCHEDULE_COPY_MAX_AGE_SECONDS).toBe(604_800);
    expect(chooseSourceForks({ live, cached: copyAt(now - 604_800), bundled: null, nowSeconds: now }).kind).toBe("known");
    expect(chooseSourceForks({ live, cached: copyAt(now - 604_801), bundled: copyAt(now - 700_000), nowSeconds: now })).toEqual({ kind: "unreachable", reason: live.reason, newestCopyAt: now - 604_801 });
    expect(chooseSourceForks({ live, cached: null, bundled: null, nowSeconds: now })).toEqual({ kind: "unreachable", reason: live.reason, newestCopyAt: null });
  });
  it("says which copy a verdict used", () => {
    const names = { source: "Sepolia", destination: "PulseChain testnet v4" };
    const fetchedAt = Date.UTC(2026, 10, 9, 8, 15) / 1000;
    const at = fetchedAt + 3600;
    const source = (origin: "cache" | "bundled") => ({ kind: "known" as const, forks: [], clock, copy: { origin, fetchedAt, liveFailure: "x" } });
    const cached = forkCutoverText(decideForkCutover(input({ source: source("cache"), nowSeconds: at })), names, at);
    expect(cached).toEqual({ headline: null, countdown: null, sendable: true, scheduleNote: "Sepolia's beacon node did not answer, so this uses the fork schedule saved by this app at 08:15 UTC." });
    const bundled = forkCutoverText(decideForkCutover(input({ source: source("bundled"), nowSeconds: at })), names, at);
    expect(bundled.scheduleNote).toBe("Sepolia's beacon node did not answer, so this uses the fork schedule bundled with this release at 08:15 UTC.");
    const pausedFromCopy = decideForkCutover(input({ source: { ...known(), copy: { origin: "cache", fetchedAt, liveFailure: "x" } }, nowSeconds: fuluTime - 600, lightClientHead: 15000n }));
    expect(forkCutoverText(pausedFromCopy, names, fuluTime - 600).scheduleNote).toContain("saved by this app");
  });
  it("bundles the schedule of each chain of the routes, fetched at release time", () => {
    for (const chainId of [1, 369, 11155111, 943]) {
      const bundled = bundledForkSchedule(chainId);
      expect(bundled).not.toBeNull();
      expect(bundled!.fetchedAt).toBe(BUNDLED_FORK_SCHEDULE_ANSWERS[chainId]!.fetchedAt);
      expect(bundled!.forks[0]!.epoch).toBe(0);
    }
    expect(bundledForkSchedule(1)!.clock).toEqual({ genesisTime: 1_606_824_023, secondsPerSlot: 12, slotsPerEpoch: 32 });
    expect(bundledForkSchedule(369)!.clock.secondsPerSlot).toBe(10);
    expect(bundledForkSchedule(1)!.forks.find((fork) => fork.name === "Fulu")).toEqual({ version: "0x06000000", epoch: 411_392, name: "Fulu" });
    expect(bundledForkSchedule(5)).toBeNull();
  });
});
