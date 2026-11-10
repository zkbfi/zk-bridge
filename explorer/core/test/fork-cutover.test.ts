import { describe, expect, it } from "vitest";
import {
  CUTOVER_LEAD_EPOCHS,
  CUTOVER_LEAD_SECONDS,
  FORK_NAMES,
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
} from "../src/index.js";

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
  it("is one hour while three epochs are shorter, and three epochs when they are longer", () => {
    expect(CUTOVER_LEAD_SECONDS).toBe(3600);
    expect(CUTOVER_LEAD_EPOCHS).toBe(3);
    expect(cutoverLeadSeconds(clock)).toBe(3600);
    expect(cutoverLeadSeconds({ genesisTime: 0, secondsPerSlot: 12, slotsPerEpoch: 32 * 4 })).toBe(3 * 12 * 128);
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
    const now = fuluTime - 3600 - 100;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: BigInt(499 * 32) }));
    expect(verdict).toMatchObject({ kind: "open", pausesAt: fuluTime - 3600, secondsToPause: 100 });
    expect(verdict.kind === "open" && verdict.next?.name).toBe("Fulu");
  });
  it("pauses from one hour before the fork", () => {
    const now = fuluTime - 3600;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: BigInt(499 * 32) }));
    expect(verdict).toMatchObject({ kind: "paused", pausedSince: fuluTime - 3600, lightClientHead: 15968n });
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
  it("is unknown, and allowed, when the beacon node is unreachable", () => {
    const verdict = decideForkCutover(input({ source: { kind: "unreachable", reason: "no answer" } }));
    expect(verdict).toEqual({ kind: "unknown", reason: "beacon-unreachable", detail: "no answer" });
    expect(isSendAllowed(verdict)).toBe(true);
  });
  it("is open before the window when the light client head is unreadable, unknown after the fork", () => {
    expect(decideForkCutover(input({ lightClientHead: null, nowSeconds: fuluTime - 7200 })).kind).toBe("open");
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
    const now = fuluTime - 7200;
    const verdict = decideForkCutover(input({ nowSeconds: now, lightClientHead: 15000n }));
    const text = forkCutoverText(verdict, names, now);
    expect(text.headline).toContain("Sends from Sepolia pause at");
    expect(text.headline).toContain("1 h before the Fulu fork (epoch 500)");
    expect(text.headline).toContain("They resume once PulseChain testnet v4's light client follows the fork.");
    expect(text.countdown).toBe("Sends pause in 1h 00m");
    expect(text.sendable).toBe(true);
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
    const long: ForkCutoverClock = { genesisTime: 0, secondsPerSlot: 12, slotsPerEpoch: 512 };
    const verdict = decideForkCutover({ ...input({ lightClientHead: 0n, nowSeconds: 1000 }), source: { kind: "known", forks: [{ version: "0x01000000", epoch: 10, name: "Altair" }], clock: long } });
    expect(forkCutoverText(verdict, names, 1000).headline).toContain("5h 07m before"); // 3 epochs of 6144 s = 18432 s
  });
  it("says nothing when no fork is ahead, and warns when unknown", () => {
    expect(forkCutoverText(decideForkCutover(input({})), names, fuluTime)).toEqual({ headline: null, countdown: null, sendable: true });
    const unreachable = forkCutoverText(decideForkCutover(input({ source: { kind: "unreachable", reason: "x" } })), names, 0);
    expect(unreachable.sendable).toBe(true);
    expect(unreachable.headline).toContain("Sepolia's beacon node did not answer");
    const noHead = forkCutoverText(decideForkCutover(input({ lightClientHead: null, nowSeconds: fuluTime + 10 })), names, fuluTime + 10);
    expect(noHead.headline).toContain("PulseChain testnet v4's light client head could not be read");
  });
});
