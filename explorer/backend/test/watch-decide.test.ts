import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_POLICY, type LightClientFacts, type SourceHistory } from "../src/keepalive/plan.ts";
import { USD, WAD } from "@zk-bridge/shared";
import type { BatchRule, Economics } from "../src/watch/batch.ts";
import { MIN_PARTICIPANTS, SYNC_COMMITTEE_SIZE, decideProof, expectedFinalityAt, handoffKey, slotAtTime, warmupPlan, type WaitingMessage } from "../src/watch/decide.ts";

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
    // A message after the pending proof's head waits for it to land: a second proof from the same head is never made.
    expect(decide({ pendingProof: { ...pendingProof, where: "board" }, messages: [message(FINALIZED - 1)] })).toMatchObject({
      due: false,
      why: "proof-pending",
      detail: `the proof from slot ${HEAD} to slot ${FINALIZED - 3} (board) waits to land; 1 message after it waits for it to land`,
    });
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

  it("a keep-alive the age rule calls for goes through the indexer's own gate, not as a planned handoff", () => {
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 13 * 360;
    expect(decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot: nowSlot - 64 })).toMatchObject({ due: true, why: "keep-alive", handoff: false });
  });

  it("a period handoff is a planned handoff", () => {
    const head = 100 * PERIOD + 8000;
    const nowSlot = 102 * PERIOD - 1000;
    expect(decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot: nowSlot - 64 })).toMatchObject({ due: true, why: "keep-alive", handoff: true });
  });

  it("a light client without a head is due, through the indexer's gate", () => {
    const nowSlot = 100 * PERIOD + 400;
    expect(decide({ facts: facts(0, false), nowSeconds: at(nowSlot), finalizedSlot: nowSlot - 64, history: { kind: "serves" } })).toMatchObject({ due: true, why: "keep-alive", handoff: false });
  });

  describe("the keep-alive loop of 2026-10-31 (PulseChain v4 to Sepolia, period 1368)", () => {
    // The head in period 1368, only its own committee stored, 544 slots (1.5 h) before period 1369 begins: the
    // deadline is inside the six hour margin, and a proof every finality moved the head inside the same period.
    const P = 1368;
    const head = 11_214_304;
    const nextPeriod = (P + 1) * PERIOD;

    it("a young head in the period of the source's finality is not due, however close the deadline", () => {
      const nowSlot = head + 40;
      const decision = decide({ facts: facts(head, false), nowSeconds: at(nowSlot), finalizedSlot: head + 32 });
      expect(decision).toMatchObject({ due: false, why: "nothing-due" });
      expect(decision.detail).toContain(`both in period ${P}`);
      expect(decision.detail).toContain(`period ${P + 1} begins at ${new Date(at(nextPeriod) * 1000).toISOString()}`);
      expect(decision.detail).toContain("in 1.4 h");
      // With the next committee stored it is the same: nothing to hand off before the source finalizes in P + 1.
      expect(decide({ facts: facts(head, true), nowSeconds: at(nowSlot), finalizedSlot: head + 32 })).toMatchObject({ due: false, why: "nothing-due" });
    });

    it("waits while the source signs in 1369 and finality is still in 1368, which the prover refuses (2026-11-01 03:47)", () => {
      // The planner calls this needs-stepping, but the prover and the contract need a finalized header inside the new
      // period: "the signature period is after the stored head period but the finalized header does not cross into it".
      const nowSlot = nextPeriod + 20;
      const decision = decide({ facts: facts(head, false), nowSeconds: at(nowSlot), finalizedSlot: nextPeriod - 40, history: { kind: "serves" } });
      expect(decision).toMatchObject({ due: false, why: "wait-for-finality" });
    });

    it("is due once when the source crosses into period 1369, then not again in it", () => {
      const nowSlot = nextPeriod + 200;
      const crossed = decide({ facts: facts(head, false), nowSeconds: at(nowSlot), finalizedSlot: nextPeriod + 100, history: { kind: "serves" } });
      expect(crossed).toMatchObject({ due: true, why: "keep-alive", handoff: true });
      // The job moved the head into period 1369 with its committee: the next finality in 1369 is not due.
      const moved = nextPeriod + 100;
      expect(decide({ facts: facts(moved, false), nowSeconds: at(nowSlot + 32), finalizedSlot: moved + 32 })).toMatchObject({ due: false, why: "nothing-due" });
      // Even late in 1369, inside the margin of its own deadline, a young head in the period of finality is not due.
      const late = (P + 2) * PERIOD - 600;
      expect(decide({ facts: facts(late, false), nowSeconds: at(late + 40), finalizedSlot: late + 32 })).toMatchObject({ due: false, why: "nothing-due" });
    });
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

describe("warmupPlan", () => {
  const id = (digit: string) => `0x${digit.repeat(64)}`;

  it("each message that is not final yet asks for a warm worker at its expected finality; every uncovered one is live", () => {
    const plan = warmupPlan({
      facts: facts(HEAD),
      finalizedSlot: FINALIZED,
      messages: [message(FINALIZED - 5, "f"), message(NOW_SLOT + 40, "b"), message(NOW_SLOT - 2, "c"), message(NOW_SLOT - 3, "d"), message(HEAD - 1, "e")],
      pendingProof: null,
      history: { kind: "not-needed" },
      policy: DEFAULT_POLICY,
      nowSeconds: at(NOW_SLOT),
      horizonSeconds: 90,
    });
    // Sorted by time, one target per time with the keys of all its messages.
    expect(plan.targets).toEqual([
      { at: expectedFinalityAt(NOW_SLOT - 2, facts(HEAD)), why: "message", keys: [id("c"), id("d")] },
      { at: expectedFinalityAt(NOW_SLOT + 40, facts(HEAD)), why: "message", keys: [id("b")] },
    ]);
    // The final message still waits for its proof; the covered one does not.
    expect([...plan.live].sort()).toEqual([id("b"), id("c"), id("d"), id("f")]);
  });

  describe("a period handoff", () => {
    // The head in period 100 with only its own committee; the clock nears period 101. The source's finality crosses
    // the border two epochs after it: the first slot of epoch border + 2, plus one for the signatures.
    const head = 100 * PERIOD + 8000;
    const border = 101 * PERIOD;
    const crossing = at(border + 65);
    const plan = (nowSlot: number, horizonSeconds: number, history: SourceHistory = { kind: "not-needed" }) =>
      warmupPlan({ facts: facts(head, false), finalizedSlot: Math.min(nowSlot - 70, border - 70), messages: [], pendingProof: null, history, policy: DEFAULT_POLICY, nowSeconds: at(nowSlot), horizonSeconds });

    it("asks for a warm worker when finality crosses the border, not when the clock does, looking as far ahead as the lead time", () => {
      const nowSlot = border - 5;
      expect(plan(nowSlot, crossing - at(nowSlot))).toEqual({ targets: [{ at: crossing, why: "keep-alive", keys: [handoffKey(head)] }], live: new Set([handoffKey(head)]) });
      // A shorter lead time does not reach it yet.
      expect(plan(nowSlot, crossing - at(nowSlot) - 1)).toEqual({ targets: [], live: new Set() });
      // While the source signs in the new period and finality has not crossed, the handoff is ahead, not due.
      expect(plan(border + 10, 600).targets).toEqual([{ at: crossing, why: "keep-alive", keys: [handoffKey(head)] }]);
    });

    it("shares a time with a message: one target with both keys", () => {
      const sent = message(border - 32 + 3, "a");
      const both = warmupPlan({ facts: facts(head, false), finalizedSlot: border - 75, messages: [sent], pendingProof: null, history: { kind: "not-needed" }, policy: DEFAULT_POLICY, nowSeconds: at(border - 5), horizonSeconds: 900 });
      expect(expectedFinalityAt(sent.slot, facts(head))).toBe(crossing);
      expect(both.targets).toEqual([{ at: crossing, why: "message", keys: [id("a"), handoffKey(head)] }]);
    });

    it("is live while it is due, and asks for no new start", () => {
      const due = warmupPlan({ facts: facts(head, false), finalizedSlot: border + 1, messages: [], pendingProof: null, history: { kind: "serves" }, policy: DEFAULT_POLICY, nowSeconds: crossing, horizonSeconds: 90 });
      expect(due).toEqual({ targets: [], live: new Set([handoffKey(head)]) });
    });

    it("a source known to lack the handoff leaves the light client stranded: nothing to warm up for", () => {
      expect(plan(border - 5, 10_000, { kind: "missing", period: 100 })).toEqual({ targets: [], live: new Set() });
    });
  });

  it("a keep-alive the age rule makes due, or one inside the period of finality, asks for no warm worker", () => {
    // The head turns 12 hours old during the current epoch: the indexer's gate takes it, no warm-up.
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 12 * 360 - 5;
    const input = { facts: facts(head), finalizedSlot: nowSlot - 70, messages: [], pendingProof: null, history: { kind: "not-needed" } as const, policy: DEFAULT_POLICY, horizonSeconds: 600 };
    expect(warmupPlan({ ...input, nowSeconds: at(nowSlot) }).targets).toEqual([]);
    // Today's loop: a young head in period 1368, 1.5 h before its deadline.
    const young = 11_214_304;
    expect(warmupPlan({ ...input, facts: facts(young, false), finalizedSlot: young + 32, nowSeconds: at(young + 40) }).targets).toEqual([]);
  });

  it("a keep-alive that is due already, or a pending proof, asks for nothing", () => {
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 13 * 360;
    const input = { facts: facts(head), finalizedSlot: nowSlot - 70, messages: [], history: { kind: "not-needed" } as const, policy: DEFAULT_POLICY, nowSeconds: at(nowSlot), horizonSeconds: 600 };
    expect(warmupPlan({ ...input, pendingProof: null })).toEqual({ targets: [], live: new Set() });
    const soon = head + 12 * 360 - 5;
    expect(warmupPlan({ ...input, nowSeconds: at(soon), finalizedSlot: soon - 70, pendingProof: { startSlot: head, newSlot: head + 10 } }).targets).toEqual([]);
  });

  it("messages covered by a pending proof ask for nothing and are not live", () => {
    const plan = warmupPlan({
      facts: facts(HEAD),
      finalizedSlot: FINALIZED,
      messages: [message(NOW_SLOT - 2)],
      pendingProof: { startSlot: HEAD, newSlot: NOW_SLOT },
      history: { kind: "not-needed" },
      policy: DEFAULT_POLICY,
      nowSeconds: at(NOW_SLOT),
      horizonSeconds: 600,
    });
    expect(plan).toEqual({ targets: [], live: new Set() });
  });
});

describe("decideProof with a batch wait (2026-11-01)", () => {
  const WAIT: BatchRule = { maxWaitSeconds: 3600, lookaheadSeconds: 1200, marginWad: WAD };
  const unknown: Economics = { kind: "unknown", why: "testnet tokens have no price" };
  const priced = (fees: Record<string, bigint>): Economics => ({ kind: "known", feesUsd: new Map(Object.entries(fees)), deliveryUsd: 0n, unpriced: 0, block: "9" });
  const hex = (digit: string) => `0x${digit.repeat(64)}`;
  const ready = message(FINALIZED - 5, "a");
  const finalAt = expectedFinalityAt(ready.slot, facts(HEAD));

  it("with no wait, or no batch, a message proves at once as before", () => {
    expect(decide({ messages: [ready], batch: { rule: { ...WAIT, maxWaitSeconds: 0 }, economics: unknown } })).toMatchObject({ due: true, why: "message", messageIds: [hex("a")] });
    expect(decide({ messages: [ready] })).not.toHaveProperty("trigger");
  });

  it("a batch that does not pay waits, saying until when and why", () => {
    const decision = decide({ messages: [ready], batch: { rule: WAIT, economics: priced({}) } });
    expect(decision).toMatchObject({ due: false, why: "waiting-for-profit", plan: { maxWaitAt: finalAt + 3600, startWhy: "max-wait", ready: 1 } });
    expect(decision.detail).toBe(
      `1 message waits, the oldest final since ${new Date(finalAt * 1000).toISOString()}: fees $0.000000 against a cost of $0.025000; no batch pays within the lookahead; proving at ${new Date((finalAt + 3600) * 1000).toISOString()} at the latest (max wait 3600 s)`,
    );
    expect(decide({ messages: [ready, message(FINALIZED - 4, "b")], batch: { rule: WAIT, economics: unknown } }).detail).toMatch(/^2 messages wait, .*: the fees cannot be valued \(testnet tokens have no price\);/);
  });

  it("says when an upcoming message is expected to make the batch pay", () => {
    const upcoming = message(NOW_SLOT + 5, "b");
    const decision = decide({ messages: [ready, upcoming], batch: { rule: WAIT, economics: priced({ [hex("b")]: USD }) } });
    expect(decision).toMatchObject({ due: false, why: "waiting-for-profit", plan: { startWhy: "profit", startAt: expectedFinalityAt(upcoming.slot, facts(HEAD)) } });
    expect(decision.detail).toContain(`the batch is expected to pay at ${new Date(expectedFinalityAt(upcoming.slot, facts(HEAD)) * 1000).toISOString()}`);
  });

  it("a batch that pays proves at once, with its facts; one past its fallback proves too", () => {
    expect(decide({ messages: [ready, message(FINALIZED - 4, "b")], batch: { rule: WAIT, economics: priced({ [hex("a")]: USD }) } })).toMatchObject({
      due: true,
      why: "message",
      trigger: "profit",
      batch: 2,
      feesUsd: "1.000000",
      costUsd: "0.025000",
      detail: `2 waiting messages are final at slot ${FINALIZED}: their fees cover the cost`,
    });
    const late = decide({ messages: [ready], nowSeconds: finalAt + 3600, batch: { rule: WAIT, economics: unknown } });
    expect(late).toMatchObject({ due: true, why: "message", trigger: "max-wait", batch: 1, waitedSeconds: 3600, feesUsd: null, costUsd: null, detail: `1 waiting message is final at slot ${FINALIZED}: the oldest has been final 3600 s` });
  });

  it("never delays a handoff or an old head: the waiting messages ride along", () => {
    const head = 100 * PERIOD + 8000;
    const nowSlot = 102 * PERIOD - 1000;
    const finalizedSlot = nowSlot - 64;
    const handoff = decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot, messages: [message(finalizedSlot - 5)], batch: { rule: WAIT, economics: unknown } });
    expect(handoff).toMatchObject({ due: true, why: "keep-alive", handoff: true, riders: 1 });
    expect(handoff.detail).toMatch(/1 waiting message rides along$/);
    const old = 100 * PERIOD + 10;
    const oldNow = old + 13 * 360;
    expect(decide({ facts: facts(old), nowSeconds: at(oldNow), finalizedSlot: oldNow - 64, messages: [message(oldNow - 70), message(oldNow - 71, "b")], batch: { rule: WAIT, economics: unknown } })).toMatchObject({
      due: true,
      why: "keep-alive",
      handoff: false,
      riders: 2,
    });
  });
});

describe("decideProof with a proof we have (2026-11-01)", () => {
  const since = at(NOW_SLOT) * 1000;
  const pendingProof = { startSlot: HEAD, newSlot: FINALIZED - 10, where: "stored" as const, since };

  it("a proof that can still land holds back a new one, also for messages after it, until it is stale", () => {
    expect(decide({ pendingProof, messages: [message(FINALIZED - 5)], pendingStaleSeconds: 600 })).toMatchObject({ due: false, why: "proof-pending" });
    expect(decide({ pendingProof, messages: [message(FINALIZED - 5), message(FINALIZED - 4, "b")], pendingStaleSeconds: 600 }).detail).toMatch(/2 messages after it wait for it to land$/);
    const stale = decide({ pendingProof, messages: [message(FINALIZED - 5)], pendingStaleSeconds: 600, nowSeconds: at(NOW_SLOT) + 601 });
    expect(stale).toMatchObject({ due: true, why: "message", stalePending: pendingProof });
    // Stale, with nothing after it: nothing is due.
    expect(decide({ pendingProof, messages: [message(FINALIZED - 20)], pendingStaleSeconds: 600, nowSeconds: at(NOW_SLOT) + 601 })).toMatchObject({ due: false, why: "nothing-due" });
    // Without a time, a pending proof never goes stale.
    expect(decide({ pendingProof: { startSlot: HEAD, newSlot: FINALIZED - 10 }, messages: [message(FINALIZED - 5)], pendingStaleSeconds: 600, nowSeconds: at(NOW_SLOT) + 6000 })).toMatchObject({ due: false, why: "proof-pending" });
  });

  it("a pending handoff holds back a second one; a stale one lets the keep-alive through", () => {
    const head = 100 * PERIOD + 10;
    const nowSlot = head + 13 * 360;
    const held = { startSlot: head, newSlot: head + 100, where: "board" as const, since: at(nowSlot) * 1000 };
    expect(decide({ facts: facts(head), nowSeconds: at(nowSlot), finalizedSlot: nowSlot - 64, pendingProof: held, pendingStaleSeconds: 600 })).toMatchObject({ due: false, why: "proof-pending", detail: `the proof from slot ${head} to slot ${head + 100} (board) waits to land` });
    expect(decide({ facts: facts(head), nowSeconds: at(nowSlot) + 700, finalizedSlot: nowSlot - 64, pendingProof: held, pendingStaleSeconds: 600 })).toMatchObject({ due: true, why: "keep-alive", stalePending: held });
  });
});

describe("warmupPlan with a batch wait", () => {
  const WAIT: BatchRule = { maxWaitSeconds: 3600, lookaheadSeconds: 1200, marginWad: WAD };
  const hex = (digit: string) => `0x${digit.repeat(64)}`;
  const base = { facts: facts(HEAD), finalizedSlot: FINALIZED, pendingProof: null, history: { kind: "not-needed" } as const, policy: DEFAULT_POLICY, nowSeconds: at(NOW_SLOT), horizonSeconds: 90 };

  it("asks for one warm worker per batch, when the batch is expected to pay, else at its fallback", () => {
    const upcoming = message(NOW_SLOT + 5, "b");
    const messages = [message(FINALIZED - 5, "a"), upcoming];
    const paying = warmupPlan({ ...base, messages, batch: { rule: WAIT, economics: { kind: "known", feesUsd: new Map([[hex("b"), USD]]), deliveryUsd: 0n, unpriced: 0, block: "1" } } });
    expect(paying.targets).toEqual([{ at: expectedFinalityAt(upcoming.slot, facts(HEAD)), why: "message", keys: [hex("a"), hex("b")] }]);
    const unpaid = warmupPlan({ ...base, messages, batch: { rule: WAIT, economics: { kind: "unknown", why: "testnet" } } });
    expect(unpaid.targets).toEqual([{ at: expectedFinalityAt(FINALIZED - 5, facts(HEAD)) + 3600, why: "message", keys: [hex("a"), hex("b")] }]);
  });

  it("a batch due now asks for a worker now; no waiting message asks for nothing", () => {
    const due = warmupPlan({ ...base, messages: [message(FINALIZED - 5, "a")], batch: { rule: WAIT, economics: { kind: "known", feesUsd: new Map([[hex("a"), USD]]), deliveryUsd: 0n, unpriced: 0, block: "1" } } });
    expect(due.targets).toEqual([{ at: at(NOW_SLOT), why: "message", keys: [hex("a")] }]);
    expect(warmupPlan({ ...base, messages: [], batch: { rule: WAIT, economics: { kind: "unknown", why: "x" } } }).targets).toEqual([]);
  });
});
