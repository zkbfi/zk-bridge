import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_POLICY, type LightClientFacts, type SourceHistory } from "../src/keepalive/plan.ts";
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
