import { describe, expect, it } from "vitest";
import { USD, WAD, expectedFinalityAt, finalizedSlotAt } from "@zk-bridge/shared";
import { DEFAULT_POLICY, type LightClientFacts } from "../src/keepalive/plan.ts";
import type { BatchRule, Economics } from "../src/watch/batch.ts";
import { MIN_PARTICIPANTS, decideProof, handoffKey, warmupPlan, type WaitingMessage } from "../src/watch/decide.ts";

// The warm-up's due time is the first moment at which decideProof says due: these tests state each rule of the decision
// as the forecast sees it (2026-11-06: warm-ups for proofs that decideProof then refused cost about $28 a month).
const PERIOD = 8192;
const SLOT = 10;
const at = (slot: number) => slot * SLOT;
const facts = (headSlot: number, nextCommitteeKnown = true): LightClientFacts => ({ headSlot, slotsPerPeriod: PERIOD, genesisTime: 0, secondsPerSlot: SLOT, nextCommitteeKnown });
const hex = (digit: string): `0x${string}` => `0x${digit.repeat(64)}`;
const message = (slot: number, digit = "a"): WaitingMessage => ({ messageId: hex(digit), slot });
const HEAD = 100 * PERIOD + 320;
const NOW_SLOT = HEAD + 360;
const NOW = at(NOW_SLOT);
const FINALIZED = NOW_SLOT - 72;
const WAIT: BatchRule = { minIntervalSeconds: 3600, lookaheadSeconds: 1200, marginWad: WAD };
const unknown: Economics = { kind: "unknown", why: "testnet tokens have no price" };
const priced = (fees: bigint, id = "a"): Economics => ({ kind: "known", feesUsd: new Map([[hex(id), fees]]), deliveryUsd: 0n, unpriced: 0, atMaximum: new Set(), why: null, block: "1" });
const base = { facts: facts(HEAD), finalizedSlot: FINALIZED, pendingProof: null, history: { kind: "not-needed" } as const, policy: DEFAULT_POLICY, nowSeconds: NOW, horizonSeconds: 90 };

describe("finalizedSlotAt", () => {
  it("is the checkpoint that has finalized at a time, consistent with expectedFinalityAt", () => {
    const slot = NOW_SLOT + 7;
    const when = expectedFinalityAt(slot, facts(HEAD));
    expect(finalizedSlotAt(when, facts(HEAD))).toBeGreaterThanOrEqual(slot);
    expect(finalizedSlotAt(when - SLOT, facts(HEAD))).toBeLessThan(slot);
  });
});

describe("the warm-up target is the next moment decideProof says due", () => {
  it("min interval: a message waits for the interval, and decideProof agrees at that moment", () => {
    const recent = NOW - 600;
    const messages = [message(FINALIZED - 5, "a")];
    const plan = warmupPlan({ ...base, messages, batch: { rule: WAIT, economics: unknown, lastProofAt: recent } });
    expect(plan.targets).toEqual([{ at: recent + 3600, why: "message", keys: [hex("a")] }]);
    const decide = (nowSeconds: number) => decideProof({ ...base, participants: 500, minParticipants: MIN_PARTICIPANTS, messages, nowSeconds, batch: { rule: WAIT, economics: unknown, lastProofAt: recent } });
    expect(decide(recent + 3600 - 1).due).toBe(false);
    expect(decide(recent + 3600).due).toBe(true);
  });

  it("profitability: fees that cover the cost pull the due time to the finality of the paying message; fees that do not, leave the interval", () => {
    const upcoming = message(NOW_SLOT + 5, "b");
    const messages = [message(FINALIZED - 5, "a"), upcoming];
    const paying = warmupPlan({ ...base, messages, batch: { rule: WAIT, economics: priced(USD, "b"), lastProofAt: NOW - 600 } });
    expect(paying.targets[0]?.at).toBe(expectedFinalityAt(upcoming.slot, facts(HEAD)));
    const poor = warmupPlan({ ...base, messages, batch: { rule: WAIT, economics: priced(1n, "b"), lastProofAt: NOW - 600 } });
    expect(poor.targets[0]?.at).toBe(NOW - 600 + 3600);
  });

  it("dedup: a finality a proof was started for already asks for nothing", () => {
    const input = { ...base, messages: [message(FINALIZED - 5, "a")] };
    expect(warmupPlan(input).targets).toEqual([{ at: NOW, why: "message", keys: [hex("a")] }]);
    expect(warmupPlan({ ...input, doneSlot: FINALIZED }).targets).toEqual([]);
  });

  it("retry after a failed job: nothing is due before the service admits a new job", () => {
    const input = { ...base, messages: [message(FINALIZED - 5, "a")] };
    expect(warmupPlan({ ...input, admitAtSeconds: NOW + 300 }).targets).toEqual([{ at: NOW + 300, why: "message", keys: [hex("a")] }]);
    // The example of 2026-11-06: the finality that failed is not warmed for again, only the next one after the wait.
    const next = warmupPlan({ ...input, admitAtSeconds: NOW + 300, doneSlot: FINALIZED }).targets[0];
    expect(next?.at).toBe(NOW + 300);
    expect(finalizedSlotAt(NOW + 300, facts(HEAD))).toBeGreaterThan(FINALIZED);
  });

  it("a finality too thinly signed makes nothing due now", () => {
    const input = { ...base, messages: [message(FINALIZED - 5, "a")] };
    expect(warmupPlan({ ...input, participants: MIN_PARTICIPANTS - 1 }).targets).toEqual([]);
    expect(warmupPlan({ ...input, participants: MIN_PARTICIPANTS }).targets).toHaveLength(1);
  });

  it("a pending proof that still applies holds the target back until it is stale", () => {
    const input = { ...base, messages: [message(NOW_SLOT + 5, "b")], pendingProof: { startSlot: HEAD, newSlot: HEAD + 10, since: (NOW - 100) * 1000 } };
    // Covered messages are not waiting at all; one beyond the pending proof waits for it to land.
    expect(warmupPlan(input).targets).toEqual([]);
    const stale = warmupPlan({ ...input, pendingStaleSeconds: 50 });
    expect(stale.targets[0]?.at).toBe(expectedFinalityAt(NOW_SLOT + 5, facts(HEAD)));
  });

  describe("handoff and keep-alive", () => {
    const head = 100 * PERIOD + 8000;
    const border = 101 * PERIOD;
    const crossing = at(border + 65);
    const handoff = { ...base, facts: facts(head, false), finalizedSlot: border - 75, messages: [] as WaitingMessage[], nowSeconds: at(border - 5), horizonSeconds: 900 };

    it("a handoff is due at the finality that crosses the border", () => {
      expect(warmupPlan(handoff).targets).toEqual([{ at: crossing, why: "keep-alive", keys: [handoffKey(head)] }]);
    });

    it("a handoff the retry policy holds back moves with it", () => {
      expect(warmupPlan({ ...handoff, admitAtSeconds: crossing + 120 }).targets).toEqual([{ at: crossing + 120, why: "keep-alive", keys: [handoffKey(head)] }]);
    });

    it("a keep-alive already started in the period of the finality asks for nothing while the head is young", () => {
      const period = Math.floor((border + 64) / PERIOD);
      expect(warmupPlan({ ...handoff, keepAlivePeriod: period }).targets).toEqual([]);
      expect(warmupPlan({ ...handoff, keepAlivePeriod: period - 1 }).targets).toHaveLength(1);
    });
  });

  it("a keep-alive of the age rule asks for no warm worker: the message that rides along is warmed for at its own due time", () => {
    // The head turns 13 hours old; a message is final but the interval since the last proof has not passed.
    const old = 100 * PERIOD + 10;
    const nowSlot = old + 13 * 360;
    const now = at(nowSlot);
    const recent = now - 600;
    const input = { ...base, facts: facts(old), finalizedSlot: nowSlot - 72, messages: [message(nowSlot - 100, "a")], nowSeconds: now, batch: { rule: WAIT, economics: unknown, lastProofAt: recent } };
    expect(decideProof({ ...input, participants: 500, minParticipants: MIN_PARTICIPANTS })).toMatchObject({ due: true, why: "keep-alive", handoff: false });
    expect(warmupPlan(input).targets).toEqual([{ at: recent + 3600, why: "message", keys: [hex("a")] }]);
  });

  it("a message ahead of finality is due at its finality when nothing holds it back", () => {
    const upcoming = message(NOW_SLOT + 5, "b");
    const plan = warmupPlan({ ...base, messages: [upcoming] });
    expect(plan.targets).toEqual([{ at: expectedFinalityAt(upcoming.slot, facts(HEAD)), why: "message", keys: [hex("b")] }]);
    expect(plan.live).toEqual(new Set([hex("b")]));
  });
});
