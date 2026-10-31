import { describe, expect, it } from "vitest";
import { CommandStartError, CommandTimeoutError } from "../src/prover/execute-command.js";
import { assessProofPayload } from "../src/prover/proof-intake.js";
import { ProverCommandError, ProverOutputError } from "../src/prover/prover-binary.js";
import { DEFAULT_VERIFY_LIMITS, VERIFY_WINDOW_MILLISECONDS, createVerifyGuard, type VerifyGuard, type VerifyLimits } from "../src/prover/verify-guard.js";
import { fakeLightClient, fakeProver, proofPayload, word } from "./support/prover-builders.js";

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (milliseconds: number) => void (time += milliseconds) };
}

function recordingLogger() {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return { lines, logger: { warn: (event: string, fields: Record<string, unknown>) => void lines.push({ event, fields }) } };
}

/** Limits with no reserve, for the tests of the general budget. */
const limits = (overrides: Partial<VerifyLimits>): VerifyLimits => ({ perMinute: 100, perSourcePerMinute: 100, reservePerSourcePerMinute: 0, refusalsRemembered: 100, ...overrides });

/** A forged proof: it names the head and the slot 164, so every cheap check passes, and the verifier refuses it. */
const forgery = (index: number, newSlot = 164n) => proofPayload({ proofByte: (index % 256).toString(16).padStart(2, "0"), newSlot });

/** The definite refusal of `zk-bridge-prover verify`: exit code 1. */
const invalid = () => new ProverCommandError("verify", 1, "invalid proof");

const refusingProver = () =>
  fakeProver({
    verify: () => {
      throw invalid();
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
    expect(DEFAULT_VERIFY_LIMITS).toEqual({ perMinute: 30, perSourcePerMinute: 16, reservePerSourcePerMinute: 4, refusalsRemembered: 4096 });
  });

  it("caps the local checks of one source per minute, drops the rest without running the verifier, and lets them pass in the next minute", async () => {
    const time = clock();
    const guard = createVerifyGuard({ now: time.now, limits: limits({ perMinute: 10, perSourcePerMinute: 3 }) });
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
    const guard = createVerifyGuard({ now: clock().now, limits: limits({ perMinute: 4, perSourcePerMinute: 3 }) });
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
    const guard = createVerifyGuard({ now: time.now, logger, limits: limits({ perSourcePerMinute: 1 }) });
    const prover = refusingProver();
    for (let index = 0; index < 4; index += 1) await assess({ payload: forgery(index), prover, guard, source: "a" });
    expect(lines).toEqual([{ event: "proof_verify_dropped", fields: { source: "a", scope: "source", droppedFromSource: 1, droppedTotal: 1 } }]);
    time.advance(VERIFY_WINDOW_MILLISECONDS);
    for (let index = 4; index < 6; index += 1) await assess({ payload: forgery(index), prover, guard, source: "a" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ event: "proof_verify_dropped", fields: { source: "a", scope: "source", droppedFromSource: 4, droppedTotal: 4 } });
  });

  it("checks a refused payload once while the head stays: a repeat is refused before the verifier and costs no budget", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: limits({ perSourcePerMinute: 2 }) });
    const prover = refusingProver();
    for (let round = 0; round < 5; round += 1) {
      expect(await assess({ payload: forgery(1), prover, guard, source: "a" })).toMatchObject({ accept: false, reason: "proof-does-not-verify" });
    }
    expect(prover.verifications).toBe(1);
    expect(guard.dropped().total).toBe(0);
    await assess({ payload: forgery(2), prover, guard, source: "a" });
    expect(prover.verifications).toBe(2);
  });

  it("keeps the refusals of the current head only, because a proof is only ever checked against the head it starts at", () => {
    const guard = createVerifyGuard({ now: clock().now });
    const first = { headSlot: 100n, headRoot: word(101) };
    const moved = { headSlot: 164n, headRoot: word(165) };
    guard.refused({ key: word(1), head: first, source: "a" });
    expect(guard.admit({ key: word(1), head: first, newSlot: 200n, source: "a" })).toEqual({ kind: "refused-before" });
    expect(guard.admit({ key: word(1), head: moved, newSlot: 200n, source: "a" })).toEqual({ kind: "check", from: "general" });
    guard.refused({ key: word(2), head: moved, source: "a" });
    expect(guard.admit({ key: word(2), head: { ...moved, headRoot: word(165).toUpperCase().replace("0X", "0x") as typeof moved.headRoot }, newSlot: 200n, source: "a" })).toEqual({ kind: "refused-before" });
    expect(guard.admit({ key: word(1), head: first, newSlot: 200n, source: "a" })).toMatchObject({ kind: "check" });
  });

  it("keeps the refusals of each source apart: two directions that alternate do not clear each other's memory", () => {
    const guard = createVerifyGuard({ now: clock().now });
    const headA = { headSlot: 100n, headRoot: word(101) };
    const headB = { headSlot: 500n, headRoot: word(77) };
    for (let round = 0; round < 3; round += 1) {
      guard.refused({ key: word(10 + round), head: headA, source: "first-to-second" });
      guard.refused({ key: word(20 + round), head: headB, source: "second-to-first" });
    }
    for (let round = 0; round < 3; round += 1) {
      expect(guard.admit({ key: word(10 + round), head: headA, newSlot: 164n, source: "first-to-second" })).toEqual({ kind: "refused-before" });
      expect(guard.admit({ key: word(20 + round), head: headB, newSlot: 600n, source: "second-to-first" })).toEqual({ kind: "refused-before" });
    }
  });

  it("remembers at most the configured number of refusals, the oldest going first", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: limits({ refusalsRemembered: 2 }) });
    const prover = refusingProver();
    for (const index of [1, 2, 3, 3, 2, 1]) await assess({ payload: forgery(index), prover, guard });
    // 1, 2, 3 are checked; 3 and 2 are remembered; 1 was forgotten and is checked again.
    expect(prover.verifications).toBe(4);
  });

  it("never remembers a proof that verifies: a second look at it checks it again, within the budget", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: limits({ perMinute: 1, perSourcePerMinute: 1 }) });
    const prover = fakeProver();
    expect(await assess({ payload: forgery(1), prover, guard })).toMatchObject({ accept: true });
    expect(await assess({ payload: forgery(1), prover, guard })).toMatchObject({ accept: false, reason: "verify-budget-exhausted" });
    expect(prover.verifications).toBe(1);
  });

  it("uses one source for a caller that names none", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: limits({ perSourcePerMinute: 1 }) });
    const prover = refusingProver();
    await assess({ payload: forgery(1), prover, guard });
    await assess({ payload: forgery(2), prover, guard });
    expect(guard.dropped()).toEqual({ total: 1, bySource: { unnamed: 1 } });
  });
});

describe("a flood that arrives before an honest proof (review of B-4)", () => {
  it("still checks, in the same minute, an honest proof that moves the head further than the flood claims", async () => {
    const guard = createVerifyGuard({ now: clock().now });
    // The honest proof has the proof bytes ab..ab; the verifier refuses every other proof.
    const honest = proofPayload({ newSlot: 200n });
    const prover = fakeProver();
    let checked = 0;
    prover.verify = async (request) => {
      checked += 1;
      if (request.proof !== `0x${"ab".repeat(356)}`) throw invalid();
    };
    // 100 distinct forgeries that name the head and the slot 164 arrive first and use up the general budget.
    for (let index = 0; index < 100; index += 1) await assess({ payload: forgery(index === 0xab ? 0xac : index), prover, guard, source: "a" });
    expect(checked).toBe(DEFAULT_VERIFY_LIMITS.perSourcePerMinute);
    // The honest proof reaches slot 200: the reserve checks it at once.
    expect(await assess({ payload: honest, prover, guard, source: "a" })).toMatchObject({ accept: true });
    expect(checked).toBe(DEFAULT_VERIFY_LIMITS.perSourcePerMinute + 1);
  });

  it("does not spend the reserve on a flood that claims no further slot", async () => {
    const guard = createVerifyGuard({ now: clock().now, limits: limits({ perSourcePerMinute: 2, reservePerSourcePerMinute: 1 }) });
    const prover = refusingProver();
    for (let index = 0; index < 20; index += 1) await assess({ payload: forgery(index), prover, guard, source: "a" });
    expect(prover.verifications).toBe(2);
    // A proof that reaches further takes the reserve; a second one that reaches no further than it does not.
    await assess({ payload: forgery(50, 180n), prover, guard, source: "a" });
    await assess({ payload: forgery(51, 180n), prover, guard, source: "a" });
    expect(prover.verifications).toBe(3);
    // Once the reserve of the minute is used, a further claim waits too.
    expect(await assess({ payload: forgery(52, 190n), prover, guard, source: "a" })).toMatchObject({ reason: "verify-budget-exhausted", detail: "the local proof checks of this minute are used up (this source)" });
  });
});

describe("a verifier that gives no answer (review of B-4)", () => {
  it.each([
    ["a timeout", new CommandTimeoutError("zk-bridge-prover ran longer than 60000 milliseconds")],
    ["a start failure", new CommandStartError("cannot start zk-bridge-prover")],
    ["a junk answer", new ProverOutputError("verify printed an unexpected answer")],
    ["a crash", new ProverCommandError("verify", 134, "aborted")],
  ])("refuses for now after %s, remembers nothing, and verifies the same proof on the next look", async (_name, failure) => {
    const guard = createVerifyGuard({ now: clock().now });
    let failures = 1;
    const prover = fakeProver({
      verify: () => {
        if (failures > 0) {
          failures -= 1;
          throw failure;
        }
      },
    });
    const payload = proofPayload();
    expect(await assess({ payload, prover, guard, source: "a" })).toEqual({ accept: false, reason: "verify-unavailable", detail: failure.message });
    expect(await assess({ payload, prover, guard, source: "a" })).toMatchObject({ accept: true });
    expect(prover.verifications).toBe(2);
  });

  it("does not remember an error that is not the verifier's definite refusal", async () => {
    const guard = createVerifyGuard({ now: clock().now });
    let failures = 1;
    const prover = fakeProver({
      verify: () => {
        if (failures-- > 0) throw new Error("something else");
      },
    });
    expect(await assess({ payload: proofPayload(), prover, guard })).toMatchObject({ accept: false, reason: "proof-does-not-verify" });
    expect(await assess({ payload: proofPayload(), prover, guard })).toMatchObject({ accept: true });
  });

  it("remembers a definite refusal (exit code 1)", async () => {
    const guard = createVerifyGuard({ now: clock().now });
    const prover = refusingProver();
    await assess({ payload: proofPayload(), prover, guard });
    expect(await assess({ payload: proofPayload(), prover, guard })).toEqual({ accept: false, reason: "proof-does-not-verify", detail: "refused before at this head" });
    expect(prover.verifications).toBe(1);
  });
});
