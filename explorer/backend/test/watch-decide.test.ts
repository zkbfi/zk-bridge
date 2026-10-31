import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_POLICY, type LightClientFacts } from "../src/keepalive/plan.ts";
import {
  DEFAULT_WARMUP,
  MIN_PARTICIPANTS,
  SYNC_COMMITTEE_SIZE,
  decideProof,
  expectedFinalityAt,
  slotAtTime,
  warmupStep,
  warmupTargets,
  type WaitingMessage,
} from "../src/watch/decide.ts";

// A PulseChain-like clock: 10 s slots, 32 slots per epoch, 8192 slots per period, genesis at 0 for easy numbers.
const PERIOD = 8192;
const SLOT = 10;
const at = (slot: number) => slot * SLOT;
const facts = (headSlot: number, nextCommitteeKnown = true): LightClientFacts => ({ headSlot, slotsPerPeriod: PERIOD, genesisTime: 0, secondsPerSlot: SLOT, nextCommitteeKnown });
const message = (slot: number, digit = "a"): WaitingMessage => ({ messageId: `0x${digit.repeat(64)}`, slot });

// A head early in period 100, one hour old: fresh for the keep-alive planner.
const HEAD = 100 * PERIOD + 320;
const NOW_SLOT = HEAD + 360;
const FINALIZED = NOW_SLOT - 64;

function decide(overrides: Partial<Parameters<typeof decideProof>[0]> = {}) {
  return decideProof({
    finalizedSlot: FINALIZED,
    participants: 500,
    minParticipants: MIN_PARTICIPANTS,
    facts: facts(HEAD),
    messages: [],
    pendingProof: null,
    history: { kind: "not-needed" },
    policy: DEFAULT_POLICY,
    nowSeconds: at(NOW_SLOT),
    ...overrides,
  });
}

describe("the participation threshold", () => {
  it("is the two-thirds rule of the light-client program (lc-core chain.rs)", () => {
    expect(SYNC_COMMITTEE_SIZE).toBe(512);
    expect(MIN_PARTICIPANTS).toBe(342);
    // The program is the source of truth: the constant must match what lc-core enforces.
    const chain = readFileSync(new URL("../../../light-client/crates/lc-core/src/chain.rs", import.meta.url), "utf8");
    expect(chain).toContain("pub const SYNC_COMMITTEE_SIZE: usize = 512;");
    expect(chain).toContain("pub const MIN_PARTICIPANTS: usize = (SYNC_COMMITTEE_SIZE * 2).div_ceil(3);");
  });
});

describe("decideProof", () => {
  it("a waiting message that the new finalized header covers is due", () => {
    const decision = decide({ messages: [message(FINALIZED - 5, "a"), message(FINALIZED + 5, "b")] });
    expect(decision).toMatchObject({ due: true, why: "message", messageIds: [`0x${"a".repeat(64)}`] });
  });

  it("a message the light client head already covers is not due", () => {
    expect(decide({ messages: [message(HEAD - 1)] })).toMatchObject({ due: false, why: "nothing-due" });
    expect(decide({ messages: [message(HEAD)] })).toMatchObject({ due: false, why: "nothing-due" });
  });

  it("a message that finality has not reached yet is not due", () => {
    expect(decide({ messages: [message(FINALIZED + 1)] })).toMatchObject({ due: false, why: "nothing-due" });
  });

  it("too few signatures: nothing is due, whatever waits", () => {
    const decision = decide({ participants: MIN_PARTICIPANTS - 1, messages: [message(FINALIZED - 5)] });
    expect(decision).toMatchObject({ due: false, why: "insufficient-signatures" });
    expect(decision.detail).toBe("341 of 512 sync committee members signed; the program needs 342");
    expect(decide({ participants: MIN_PARTICIPANTS, messages: [message(FINALIZED - 5)] })).toMatchObject({ due: true });
  });

  it("an unknown participation counts as too few", () => {
    expect(decide({ participants: null, messages: [message(FINALIZED - 5)] })).toMatchObject({ due: false, why: "insufficient-signatures", detail: "the participation is unknown" });
  });

  it("a finalized header that is not newer than the head is not due", () => {
    expect(decide({ finalizedSlot: HEAD })).toMatchObject({ due: false, why: "not-newer" });
  });

  it("a posted proof that still starts at the head covers its messages", () => {
    const pendingProof = { startSlot: HEAD, newSlot: FINALIZED - 3 };
    expect(decide({ pendingProof, messages: [message(FINALIZED - 5)] })).toMatchObject({ due: false, why: "proof-pending" });
    // A message after the pending proof's head still needs a new proof.
    expect(decide({ pendingProof, messages: [message(FINALIZED - 1)] })).toMatchObject({ due: true, why: "message" });
    // The pending proof reaches the newest finalized header: nothing newer to prove.
    expect(decide({ pendingProof: { startSlot: HEAD, newSlot: FINALIZED } })).toMatchObject({ due: false, why: "not-newer" });
  });

  it("a posted proof whose start is no longer the head is stale and is ignored", () => {
    const pendingProof = { startSlot: HEAD - 32, newSlot: FINALIZED };
    expect(decide({ pendingProof, messages: [message(FINALIZED - 5)] })).toMatchObject({ due: true, why: "message" });
  });

  it("a keep-alive is due when the planner calls for one", () => {
    // A head 13 hours old: past the keep-alive age of 12 hours.
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 13 * 360;
    const decision = decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot: nowSlot - 64 });
    expect(decision).toMatchObject({ due: true, why: "keep-alive" });
    expect(decision.detail).toMatch(/past the keep-alive age/);
  });

  it("a keep-alive waits while a posted proof can still move the head", () => {
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 13 * 360;
    const decision = decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot: nowSlot - 64, pendingProof: { startSlot: head, newSlot: head + 100 } });
    expect(decision).toMatchObject({ due: false, why: "proof-pending" });
  });

  it("a period handoff is due once finality crosses into the new period near the deadline", () => {
    // The head is late in period 100 with period 101 known; the clock is late in period 101: the deadline (start of
    // period 102) is inside the six hour margin.
    const head = 100 * PERIOD + 8000;
    const nowSlot = 102 * PERIOD - 1000;
    const decision = decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot: nowSlot - 64 });
    expect(decision).toMatchObject({ due: true, why: "keep-alive" });
  });

  it("waits while the source signs in a new period that finality has not reached", () => {
    const head = 100 * PERIOD + 8000;
    const nowSlot = 101 * PERIOD + 20;
    const decision = decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot: 101 * PERIOD - 50, messages: [message(101 * PERIOD - 60)] });
    expect(decision).toMatchObject({ due: false, why: "wait-for-finality" });
  });

  it("a light client that needs handoff steps the source serves is due; a stranded one is not", () => {
    const head = 100 * PERIOD + 8000;
    const nowSlot = 103 * PERIOD + 500;
    const finalizedSlot = nowSlot - 64;
    expect(decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot, history: { kind: "serves" } })).toMatchObject({ due: true, why: "keep-alive" });
    expect(decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot, history: { kind: "missing", period: 101 } })).toMatchObject({ due: false, why: "stranded" });
  });
});

describe("expectedFinalityAt", () => {
  it("a block is final when the checkpoint after its epoch finalizes: the start of epoch e + 3, plus one slot for the signatures", () => {
    // Slot 100 is in epoch 3; epoch 6 starts at slot 192.
    expect(expectedFinalityAt(100, facts(0))).toBe(at(193));
    expect(expectedFinalityAt(96, facts(0))).toBe(at(193));
    expect(expectedFinalityAt(127, facts(0))).toBe(at(193));
  });

  it("slotAtTime maps an execution timestamp to its beacon slot", () => {
    expect(slotAtTime(at(1234) + 3, facts(0))).toBe(1234);
    expect(slotAtTime(-5, facts(0))).toBe(0);
  });
});

describe("warmupTargets", () => {
  it("each message that is not final yet asks for a warm worker at its expected finality", () => {
    const targets = warmupTargets({
      facts: facts(HEAD),
      finalizedSlot: FINALIZED,
      messages: [message(FINALIZED - 5), message(NOW_SLOT + 40), message(NOW_SLOT - 2), message(NOW_SLOT - 3), message(HEAD - 1)],
      pendingProof: null,
      history: { kind: "not-needed" },
      policy: DEFAULT_POLICY,
      nowSeconds: at(NOW_SLOT),
    });
    // Sorted by time, one target per time.
    expect(targets).toEqual([
      { at: expectedFinalityAt(NOW_SLOT - 2, facts(HEAD)), why: "message" },
      { at: expectedFinalityAt(NOW_SLOT + 40, facts(HEAD)), why: "message" },
    ]);
  });

  it("a keep-alive that the next finality makes due asks for a warm worker then", () => {
    // The head turns 12 hours old during the current epoch.
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 12 * 360 - 5;
    const targets = warmupTargets({
      facts: facts(head),
      finalizedSlot: nowSlot - 70,
      messages: [],
      pendingProof: null,
      history: { kind: "not-needed" },
      policy: DEFAULT_POLICY,
      nowSeconds: at(nowSlot),
    });
    const nextEpochStart = (Math.floor(nowSlot / 32) + 1) * 32;
    expect(targets).toEqual([{ at: at(nextEpochStart + 1), why: "keep-alive" }]);
  });

  it("a keep-alive that is due already, or a pending proof, asks for nothing", () => {
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 13 * 360;
    const input = { facts: facts(head), finalizedSlot: nowSlot - 70, messages: [], history: { kind: "not-needed" } as const, policy: DEFAULT_POLICY, nowSeconds: at(nowSlot) };
    expect(warmupTargets({ ...input, pendingProof: null })).toEqual([]);
    const soon = head + 12 * 360 - 5;
    expect(warmupTargets({ ...input, nowSeconds: at(soon), finalizedSlot: soon - 70, pendingProof: { startSlot: head, newSlot: head + 10 } })).toEqual([]);
  });

  it("messages covered by a pending proof ask for nothing", () => {
    const targets = warmupTargets({
      facts: facts(HEAD),
      finalizedSlot: FINALIZED,
      messages: [message(NOW_SLOT - 2)],
      pendingProof: { startSlot: HEAD, newSlot: NOW_SLOT },
      history: { kind: "not-needed" },
      policy: DEFAULT_POLICY,
      nowSeconds: at(NOW_SLOT),
    });
    expect(targets).toEqual([]);
  });
});

describe("warmupStep", () => {
  const config = DEFAULT_WARMUP;
  const target = { at: 10_000, why: "message" as const };
  const empty = { sessionStartedAt: null, sessionEndsAt: null, lastPingAt: null };

  it("pings when the lead time before a target begins, and not before", () => {
    expect(warmupStep({ nowSeconds: target.at - config.leadSeconds - 1, targets: [target], state: empty, config, jobActive: false })).toEqual({ ping: false });
    const step = warmupStep({ nowSeconds: target.at - config.leadSeconds, targets: [target], state: empty, config, jobActive: false });
    expect(step).toEqual({
      ping: true,
      newSession: true,
      target,
      state: { sessionStartedAt: target.at - config.leadSeconds, sessionEndsAt: target.at + config.graceSeconds, lastPingAt: target.at - config.leadSeconds },
    });
  });

  it("repeats the ping every interval inside the session, then stops at its end", () => {
    const start = target.at - config.leadSeconds;
    const state = { sessionStartedAt: start, sessionEndsAt: target.at + config.graceSeconds, lastPingAt: start };
    expect(warmupStep({ nowSeconds: start + config.intervalSeconds - 1, targets: [target], state, config, jobActive: false })).toEqual({ ping: false });
    const again = warmupStep({ nowSeconds: start + config.intervalSeconds, targets: [target], state, config, jobActive: false });
    expect(again).toMatchObject({ ping: true, newSession: false, state: { sessionStartedAt: start, lastPingAt: start + config.intervalSeconds } });
    expect(warmupStep({ nowSeconds: target.at + config.graceSeconds + 1, targets: [target], state, config, jobActive: false })).toEqual({ ping: false });
  });

  it("opens no new session within the minimum gap of the last one", () => {
    const start = target.at - config.leadSeconds;
    const state = { sessionStartedAt: start, sessionEndsAt: start + 10, lastPingAt: start };
    const later = { at: start + 60, why: "message" as const };
    expect(warmupStep({ nowSeconds: start + 30, targets: [later], state, config, jobActive: false })).toEqual({ ping: false });
    const farLater = { at: start + config.minGapSeconds + config.leadSeconds, why: "keep-alive" as const };
    expect(warmupStep({ nowSeconds: start + config.minGapSeconds, targets: [farLater], state, config, jobActive: false })).toMatchObject({ ping: true, newSession: true, target: farLater });
  });

  it("does not ping while a job of the direction runs: the prover holds the worker", () => {
    expect(warmupStep({ nowSeconds: target.at, targets: [target], state: empty, config, jobActive: true })).toEqual({ ping: false });
  });
});
