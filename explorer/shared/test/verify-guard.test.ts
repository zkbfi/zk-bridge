import { describe, expect, it } from "vitest";
import { assessProofPayload } from "../src/prover/proof-intake.js";
import { DEFAULT_VERIFY_LIMITS, VERIFY_WINDOW_MILLISECONDS, createVerifyGuard, type VerifyGuard } from "../src/prover/verify-guard.js";
import { fakeLightClient, fakeProver, proofPayload, word } from "./support/prover-builders.js";

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (milliseconds: number) => void (time += milliseconds) };
}

function recordingLogger() {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return { lines, logger: { warn: (event: string, fields: Record<string, unknown>) => void lines.push({ event, fields }) } };
}

/** A forged proof: it names the head, so every cheap check passes, and the verifier refuses it. */
const forgery = (index: number) => proofPayload({ proofByte: (index % 256).toString(16).padStart(2, "0"), ...(index >= 256 ? { newSlot: 300n + BigInt(index) } : {}) });

const refusingProver = () =>
  fakeProver({
    verify: () => {
      throw new Error("invalid proof");
    },
  });

const assess = (input: { payload: ReturnType<typeof proofPayload>; prover: ReturnType<typeof fakeProver>; guard?: VerifyGuard; source?: string; lightClient?: ReturnType<typeof fakeLightClient> }) =>
  assessProofPayload({
    payload: input.payload,
    pairName: "eth-pls",
    direction: "first-to-second",
    lightClient: input.lightClient ?? fakeLightClient(),
    prover: input.prover,
    verifyGuard: input.guard,
    verifySource: input.source,
  });

describe("the verify guard of the proof intake (B-4, K-5)", () => {
  it("has limits well above an honest load of a few proofs a minute", () => {
    expect(DEFAULT_VERIFY_LIMITS).toEqual({ perMinute: 30, perSourcePerMinute: 20, refusalsRemembered: 4096 });
  });

  it("caps the local checks of one source per minute, drops the rest without running the verifier, and lets them pass in the next minute", async () => {
    const time = clock();
    const guard = createVerifyGuard({ now: time.now, limits: { perMinute: 10, perSourcePerMinute: 3, refusalsRemembered: 100 } });
    const prover = refusingProver();
    const reasons: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const verdict = await assess({ payload: forgery(index), prover, guard, source: "a" });
      reasons.push(verdict.accept ? "accept" : verdict.reason);
    }
    expect(reasons).toEqual(["proof-does-not-verify", "proof-does-not-verify", "proof-does-not-verify", "verify-budget-exhausted", "verify-budget-exhausted"]);
    expect(prover.verifications).toBe(3);
    expect(guard.dropped()).toEqual({ total: 2, bySource: { a: 2 } });
    time.advance(VERIFY_WINDOW_MILLISECONDS);
    expect(await assess({ payload: forgery(3), prover, guard, source: "a" })).toMatchObject({ accept: false, reason: "proof-does-not-verify" });
    expect(prover.verifications).toBe(4);
  });

  it("caps all sources together, so many sources cannot add up to an unbounded load", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: { perMinute: 4, perSourcePerMinute: 3, refusalsRemembered: 100 } });
    const prover = refusingProver();
    for (let index = 0; index < 3; index += 1) await assess({ payload: forgery(index), prover, guard, source: "a" });
    expect(await assess({ payload: forgery(10), prover, guard, source: "b" })).toMatchObject({ reason: "proof-does-not-verify" });
    expect(await assess({ payload: forgery(11), prover, guard, source: "b" })).toEqual({ accept: false, reason: "verify-budget-exhausted", detail: "the local proof checks of this minute are used up (all sources)" });
    expect(prover.verifications).toBe(4);
    expect(guard.dropped()).toEqual({ total: 1, bySource: { b: 1 } });
  });

  it("logs a drop with its counters once per source and minute, not once per message", async () => {
    const time = clock();
    const { lines, logger } = recordingLogger();
    const guard = createVerifyGuard({ now: time.now, logger, limits: { perMinute: 10, perSourcePerMinute: 1, refusalsRemembered: 100 } });
    const prover = refusingProver();
    for (let index = 0; index < 4; index += 1) await assess({ payload: forgery(index), prover, guard, source: "a" });
    expect(lines).toEqual([{ event: "proof_verify_dropped", fields: { source: "a", scope: "source", droppedFromSource: 1, droppedTotal: 1 } }]);
    time.advance(VERIFY_WINDOW_MILLISECONDS);
    for (let index = 4; index < 6; index += 1) await assess({ payload: forgery(index), prover, guard, source: "a" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ event: "proof_verify_dropped", fields: { source: "a", scope: "source", droppedFromSource: 4, droppedTotal: 4 } });
  });

  it("checks a refused payload once while the head stays: a repeat is refused before the verifier and costs no budget", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: { perMinute: 10, perSourcePerMinute: 2, refusalsRemembered: 100 } });
    const prover = refusingProver();
    for (let round = 0; round < 5; round += 1) {
      expect(await assess({ payload: forgery(1), prover, guard, source: "a" })).toMatchObject({ accept: false, reason: "proof-does-not-verify" });
    }
    expect(prover.verifications).toBe(1);
    expect(guard.dropped().total).toBe(0);
    // The budget is still there for another payload.
    await assess({ payload: forgery(2), prover, guard, source: "a" });
    expect(prover.verifications).toBe(2);
  });

  it("keeps the refusals of the current head only, because a proof is only ever checked against the head it starts at", () => {
    const guard = createVerifyGuard({ now: clock().now });
    const first = { headSlot: 100n, headRoot: word(101) };
    const moved = { headSlot: 164n, headRoot: word(165) };
    guard.refused({ key: word(1), head: first });
    expect(guard.admit({ key: word(1), head: first, source: "a" })).toEqual({ kind: "refused-before" });
    expect(guard.admit({ key: word(1), head: moved, source: "a" })).toEqual({ kind: "check" });
    // A refusal at the new head forgets those of the old one.
    guard.refused({ key: word(2), head: moved });
    expect(guard.admit({ key: word(2), head: { ...moved, headRoot: word(165).toUpperCase().replace("0X", "0x") as typeof moved.headRoot }, source: "a" })).toEqual({ kind: "refused-before" });
    expect(guard.admit({ key: word(1), head: first, source: "a" })).toEqual({ kind: "check" });
  });

  it("remembers at most the configured number of refusals, the oldest going first", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: { perMinute: 100, perSourcePerMinute: 100, refusalsRemembered: 2 } });
    const prover = refusingProver();
    for (const index of [1, 2, 3, 3, 2, 1]) await assess({ payload: forgery(index), prover, guard });
    // 1, 2, 3 are checked; 3 and 2 are remembered; 1 was forgotten and is checked again.
    expect(prover.verifications).toBe(4);
  });

  it("never remembers a proof that verifies: a second look at it checks it again, within the budget", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: { perMinute: 1, perSourcePerMinute: 1, refusalsRemembered: 10 } });
    const prover = fakeProver();
    expect(await assess({ payload: forgery(1), prover, guard })).toMatchObject({ accept: true });
    expect(await assess({ payload: forgery(1), prover, guard })).toMatchObject({ accept: false, reason: "verify-budget-exhausted" });
    expect(prover.verifications).toBe(1);
  });

  it("uses one source for a caller that names none", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: { perMinute: 10, perSourcePerMinute: 1, refusalsRemembered: 10 } });
    const prover = refusingProver();
    await assess({ payload: forgery(1), prover, guard });
    await assess({ payload: forgery(2), prover, guard });
    expect(guard.dropped()).toEqual({ total: 1, bySource: { unnamed: 1 } });
  });
});
