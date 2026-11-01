import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { DEFAULT_POLICY, type LightClientFacts, type SourceHistory } from "../src/keepalive/plan.ts";
import type { Job } from "../src/requests/jobs.ts";
import type { ProofRequest, SubmitResult } from "../src/requests/service.ts";
import { openStorage } from "../src/storage.ts";
import { MIN_PARTICIPANTS, expectedFinalityAt } from "../src/watch/decide.ts";
import { DEFAULT_WARMUP, type WarmupConfig } from "../src/watch/warmup.ts";
import { createWarmupStore } from "../src/watch/warmup-store.ts";
import type { FinalityObservation } from "../src/watch/feed.ts";
import type { HeldProof } from "../src/requests/held-proofs.ts";
import type { BatchRule, Economics } from "../src/watch/batch.ts";
import type { WatchDecision } from "../src/watch/decisions.ts";
import { createDirectionWatcher, REFUSED_RETRIES, REFUSED_RETRY_SECONDS, type ListedMessage } from "../src/watch/watcher.ts";
import { memoryLogger } from "./support.ts";

// A Sepolia-like clock: 12 s slots, genesis at a round time, 8192 slots per period.
const GENESIS = 1_600_000_000;
const SLOT = 12;
const PERIOD = 8192;
const HEAD = 1000 * PERIOD + 320;
const slotStart = (slot: number) => (GENESIS + slot * SLOT) * 1000;
const facts = (headSlot = HEAD, nextCommitteeKnown = true): LightClientFacts => ({ headSlot, slotsPerPeriod: PERIOD, genesisTime: GENESIS, secondsPerSlot: SLOT, nextCommitteeKnown });
const id = (digit: string): Hex => `0x${digit.repeat(64)}`;
const listed = (slot: number, digit = "a"): ListedMessage => ({ messageId: id(digit), timestamp: GENESIS + slot * SLOT });

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  direction: "first-to-second",
  status: "proving",
  createdAt: 0,
  updatedAt: 0,
  startSlot: null,
  newSlot: null,
  error: null,
  ...overrides,
});

/** No batch wait: a message proves at the first finality that covers it. */
const NO_WAIT: BatchRule = { maxWaitSeconds: 0, lookaheadSeconds: 384, marginWad: 10n ** 18n };

function setup(
  options: {
    messages?: ListedMessage[];
    facts?: LightClientFacts;
    submit?: (request: ProofRequest) => SubmitResult;
    ping?: boolean | (() => Promise<number>);
    warmup?: Partial<WarmupConfig>;
    batchRule?: BatchRule;
    economics?: Economics | (() => Promise<Economics>);
    /** Keep each decision the watcher reports. */
    recordDecisions?: boolean;
  } = {},
) {
  const decisions: WatchDecision[] = [];
  const log = memoryLogger();
  const storage = openStorage(":memory:");
  const store = createWarmupStore(storage);
  const state = {
    facts: options.facts ?? facts(),
    messages: options.messages ?? [],
    active: null as Job | null,
    held: [] as HeldProof[],
    factsFail: false,
    history: { kind: "serves" } as SourceHistory,
  };
  const submitted: ProofRequest[] = [];
  const pings: number[] = [];
  const reads = { facts: 0, messages: 0, history: 0, economics: 0 };
  let jobs = 0;
  const watcher = createDirectionWatcher({
    pairName: "sepolia-pls943",
    direction: "first-to-second",
    sourceChainId: 11155111,
    readFacts: async () => {
      reads.facts += 1;
      if (state.factsFail) throw new Error("rpc down");
      return state.facts;
    },
    readMessages: async () => {
      reads.messages += 1;
      return state.messages;
    },
    readHistory: async () => {
      reads.history += 1;
      return state.history;
    },
    findActiveJob: () => state.active,
    readHeldProofs: () => state.held,
    pendingStaleSeconds: 600,
    batchRule: options.batchRule ?? NO_WAIT,
    readEconomics: async () => {
      reads.economics += 1;
      const economics = options.economics ?? { kind: "unknown", why: "no prices in this test" };
      return typeof economics === "function" ? economics() : economics;
    },
    submit: async (request) => {
      submitted.push(request);
      const result = options.submit?.(request) ?? { requestId: "r", jobId: `job-${(jobs += 1)}` };
      if (!("refused" in result)) state.active = job({ id: result.jobId });
      return result;
    },
    ping:
      options.ping === false
        ? null
        : async () => {
            pings.push(Date.now());
            return typeof options.ping === "function" ? options.ping() : 204;
          },
    policy: DEFAULT_POLICY,
    minParticipants: MIN_PARTICIPANTS,
    warmup: { ...DEFAULT_WARMUP, ...options.warmup },
    warmupStore: store,
    maxRetrySeconds: 600,
    logger: log.logger,
    now: Date.now,
    ...(options.recordDecisions === true ? { onDecision: (decision: WatchDecision) => void decisions.push(decision) } : {}),
  });
  const events = () => log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const sessions = () => storage.database.prepare("SELECT why, lead_seconds AS lead, started_at AS startedAt, ready_at AS readyAt, ended_at AS endedAt, outcome FROM warmup_sessions ORDER BY started_at").all();
  return { watcher, state, submitted, pings, reads, store, sessions, decisions, named: (name: string) => events().filter((event) => event.event === name) };
}

/** A reading that arrived `delay` ms after its signature slot began. */
const observation = (finalizedSlot: number, participants: number | null = 500, delay = 2_000): FinalityObservation => ({
  finalizedSlot,
  signatureSlot: finalizedSlot + 65,
  participants,
  source: "sse",
  receivedAt: slotStart(finalizedSlot + 65) + delay,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // Forty minutes after the head: a fresh light client unless a test says otherwise.
  vi.setSystemTime(slotStart(HEAD + 200));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Sets the clock to the arrival of a reading. */
const arrive = (reading: FinalityObservation) => vi.setSystemTime(reading.receivedAt);

describe("the direction watcher, on finality", () => {
  it("starts the job through the request service as soon as the finality covering a waiting message arrives", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a"), listed(HEAD + 900, "b")] });
    const reading = observation(HEAD + 128);
    arrive(reading);
    run.watcher.observe(reading);
    // No timer runs: the job starts on the same turn of reads.
    await run.watcher.settled();
    expect(run.submitted).toEqual([{ pair: "sepolia-pls943", direction: "first-to-second", reason: "finality", caller: "watch", messageId: id("a"), since: reading.receivedAt, target: { startSlot: HEAD, newSlot: HEAD + 128 } }]);
    expect(run.named("finality_seen")).toMatchObject([{ direction: "first-to-second", chainId: 11155111, finalizedSlot: HEAD + 128, signatureSlot: HEAD + 193, participants: 500, source: "sse", latencyMs: 2_000 }]);
    expect(run.named("proof_due")).toMatchObject([{ why: "message", detail: "1 waiting message is final at slot " + (HEAD + 128), attempt: 0 }]);
  });

  it("starts nothing when too few of the committee signed", async () => {
    const run = setup({ messages: [listed(HEAD + 100)] });
    run.watcher.observe(observation(HEAD + 128, MIN_PARTICIPANTS - 1));
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    expect(run.named("proof_not_due")).toMatchObject([{ why: "insufficient-signatures" }]);
    // The same header with enough signatures starts the job.
    run.watcher.observe(observation(HEAD + 128, MIN_PARTICIPANTS));
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(1);
  });

  it("starts nothing for a message the light client already covers", async () => {
    const run = setup({ messages: [listed(HEAD - 5)] });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    expect(run.named("proof_not_due")).toMatchObject([{ why: "nothing-due" }]);
  });

  it("never starts a second job for the same finality, nor while a job runs", async () => {
    const run = setup({ messages: [listed(HEAD + 100)] });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    run.watcher.observe(observation(HEAD + 128));
    run.watcher.observe(observation(HEAD + 96));
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(1);
    // A newer finality while the job runs: joins nothing, starts nothing.
    run.state.messages = [listed(HEAD + 100), listed(HEAD + 150, "b")];
    run.watcher.observe(observation(HEAD + 160));
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(1);
    expect(run.named("proof_due_job_active")).toMatchObject([{ jobId: "job-1" }]);
    run.watcher.observe(observation(HEAD + 160));
    await run.watcher.settled();
    expect(run.named("proof_due_job_active")).toHaveLength(1);
  });

  it("does not prove again what a posted proof already covers", async () => {
    const run = setup({ messages: [listed(HEAD + 100)] });
    run.state.held = [{ startSlot: HEAD, newSlot: HEAD + 128, where: "job", since: Date.now() }];
    run.watcher.observe(observation(HEAD + 160));
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    expect(run.named("proof_not_due")).toMatchObject([{ why: "proof-pending" }]);
  });

  it("starts a keep-alive the planner calls for, asking the source for handoffs only when it needs them", async () => {
    // Two periods behind: handoff steps the source serves.
    const head = 1000 * PERIOD + 8000;
    const run = setup({ facts: facts(head) });
    const reading = observation(1002 * PERIOD + 400);
    arrive(reading);
    run.watcher.observe(reading);
    await run.watcher.settled();
    expect(run.reads.history).toBe(1);
    expect(run.submitted).toMatchObject([{ reason: "finality", plannedHandoff: true }]);
    expect(run.submitted[0]).not.toHaveProperty("messageId");
    expect(run.named("proof_due")).toMatchObject([{ why: "keep-alive" }]);
  });

  it("sends a keep-alive of the age rule through the indexer's gate, without a planned handoff", async () => {
    const run = setup();
    const reading = observation(HEAD + 13 * 300);
    arrive(reading);
    run.watcher.observe(reading);
    await run.watcher.settled();
    expect(run.named("proof_due")).toMatchObject([{ why: "keep-alive" }]);
    expect(run.submitted).toHaveLength(1);
    expect(run.submitted[0]).not.toHaveProperty("plannedHandoff");
    expect(run.submitted[0]).not.toHaveProperty("messageId");
  });

  it("starts no keep-alive for a young head in the period of finality, however close the deadline (2026-10-31)", async () => {
    // The head 500 slots before its period ends, only its own committee stored: the deadline is 1.7 h away.
    const head = 1001 * PERIOD - 500;
    const run = setup({ facts: facts(head, false) });
    for (const finalized of [head + 32, head + 64, head + 96]) {
      const reading = observation(finalized);
      arrive(reading);
      run.watcher.observe(reading);
      await run.watcher.settled();
    }
    expect(run.submitted).toEqual([]);
    expect(run.named("proof_not_due")).toMatchObject([{ why: "nothing-due" }, { why: "nothing-due" }, { why: "nothing-due" }]);
    expect(run.named("proof_not_due")[0]?.detail).toContain("period 1001 begins at");
  });

  it("starts at most one keep-alive per period of finality unless the head ages past the keep-alive age", async () => {
    // Finality has crossed into period 1001, the head in 1000 holds only its own committee: a handoff is due. The
    // light-client reading lags after the job, so the planner would ask again at the next finality in 1001.
    const head = 1000 * PERIOD + 8000;
    const run = setup({ facts: facts(head, false) });
    const first = observation(1001 * PERIOD + 4);
    arrive(first);
    run.watcher.observe(first);
    await run.watcher.settled();
    expect(run.submitted).toMatchObject([{ plannedHandoff: true }]);
    run.state.active = null;
    const second = observation(1001 * PERIOD + 36);
    arrive(second);
    run.watcher.observe(second);
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(1);
    expect(run.named("proof_not_due").at(-1)).toMatchObject({ level: "info", why: "keep-alive-this-period" });
    // In the same period again, but the head has aged past the keep-alive age: allowed.
    run.state.active = null;
    run.state.facts = facts(1001 * PERIOD + 4, false);
    const aged = observation(1001 * PERIOD + 4 + 13 * 300);
    arrive(aged);
    run.watcher.observe(aged);
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(2);
  });

  it("warns about a stranded light client and starts nothing", async () => {
    const head = 1000 * PERIOD + 8000;
    const run = setup({ facts: facts(head) });
    run.state.history = { kind: "missing", period: 1001 };
    const reading = observation(1002 * PERIOD + 400);
    arrive(reading);
    run.watcher.observe(reading);
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    expect(run.named("proof_not_due")).toMatchObject([{ level: "warn", why: "stranded" }]);
  });

  it("logs an unknown signature slot without a latency", async () => {
    const run = setup();
    run.watcher.observe({ ...observation(HEAD + 128), signatureSlot: null });
    await run.watcher.settled();
    expect(run.named("finality_seen")).toMatchObject([{ signatureSlot: null, latencyMs: null }]);
  });
});

describe("the direction watcher, when a read or the service refuses", () => {
  it("tries a failed read again after a short wait", async () => {
    const run = setup({ messages: [listed(HEAD + 100)] });
    run.state.factsFail = true;
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.named("watch_read_failed")).toMatchObject([{ retryInSeconds: REFUSED_RETRY_SECONDS, error: { message: "rpc down" } }]);
    run.state.factsFail = false;
    await vi.advanceTimersByTimeAsync(REFUSED_RETRY_SECONDS * 1000);
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(1);
  });

  it("waits out a rate limit, and leaves a long one to the next finality", async () => {
    let answer: SubmitResult = { refused: "rate-limited", retryAfterSeconds: 40 };
    const run = setup({ messages: [listed(HEAD + 100)], submit: () => answer });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.named("proof_due_refused")).toMatchObject([{ refused: "rate-limited", retryInSeconds: 40 }]);
    answer = { refused: "cannot-check", retryAfterSeconds: 3600 };
    await vi.advanceTimersByTimeAsync(40_000);
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(2);
    expect(run.named("proof_due_refused")[1]).toMatchObject({ refused: "cannot-check", retryInSeconds: null });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(run.submitted).toHaveLength(2);
  });

  it("asks again a few times when the indexer does not show the need yet", async () => {
    const run = setup({ messages: [listed(HEAD + 100)], submit: () => ({ refused: "nothing-to-prove" }) });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    await vi.advanceTimersByTimeAsync(REFUSED_RETRY_SECONDS * 1000 * (REFUSED_RETRIES + 2));
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(REFUSED_RETRIES + 1);
    expect(run.named("proof_due_refused").at(-1)).toMatchObject({ level: "warn", retryInSeconds: null });
  });

  it("a newer finality replaces a waiting retry, and an older retry never replaces a newer reading", async () => {
    let refuse = true;
    const run = setup({ messages: [listed(HEAD + 100)], submit: () => (refuse ? { refused: "rate-limited", retryAfterSeconds: 30 } : { requestId: "r", jobId: "job-9" }) });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    refuse = false;
    run.watcher.observe(observation(HEAD + 160));
    await run.watcher.settled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.submitted.map((request) => request.since)).toEqual([observation(HEAD + 128).receivedAt, observation(HEAD + 160).receivedAt]);
  });

  it("logs an unexpected failure and goes on", async () => {
    const run = setup({ messages: [listed(HEAD + 100)], submit: () => {
      throw new Error("database locked");
    } });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.named("watch_failed")).toMatchObject([{ level: "error", error: { message: "database locked" } }]);
  });

  it("does nothing after stop", async () => {
    const run = setup({ messages: [listed(HEAD + 100)], submit: () => ({ refused: "rate-limited", retryAfterSeconds: 30 }) });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    await run.watcher.stop();
    run.watcher.observe(observation(HEAD + 160));
    await vi.advanceTimersByTimeAsync(60_000);
    await run.watcher.scan();
    expect(run.submitted).toHaveLength(1);
    expect(run.pings).toEqual([]);
  });
});

describe("the direction watcher, warm-ups", () => {
  // A message sent in the epoch of slot HEAD + 100: final at the start of epoch + 3, plus a slot.
  const SENT = HEAD + 100;
  const expected = expectedFinalityAt(SENT, facts()) * 1000;
  const LEAD = DEFAULT_WARMUP.defaultLeadSeconds * 1000;
  /** A ping the test answers: `answer` settles the oldest outstanding one. */
  function heldPing() {
    const waiting: Array<{ resolve: (status: number) => void; reject: (error: Error) => void }> = [];
    return {
      ping: () => new Promise<number>((resolve, reject) => waiting.push({ resolve, reject })),
      answer: (status: number) => waiting.shift()?.resolve(status),
      fail: (error: Error) => waiting.shift()?.reject(error),
      outstanding: () => waiting.length,
    };
  }

  it("starts a warm-up the default lead time (90 s) before the message's expected finality while nothing is learned", async () => {
    const run = setup({ messages: [listed(SENT)] });
    vi.setSystemTime(expected - LEAD - 1000);
    await run.watcher.scan();
    expect(run.pings).toEqual([]);
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    expect(run.pings).toEqual([expected - LEAD]);
    expect(run.named("warmup_scheduled")).toMatchObject([
      { direction: "first-to-second", why: "message", dueAt: new Date(expected).toISOString(), dueInSeconds: 90, leadSeconds: 90, leadBasis: "default", observations: 0 },
    ]);
    // 204: a worker is starting. Ask again after the interval, not before.
    expect(run.named("warmup_ping")).toMatchObject([{ kind: "start", status: 204, secondsToDue: 90 }]);
    vi.setSystemTime(expected - LEAD + 15_000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    vi.setSystemTime(expected - LEAD + DEFAULT_WARMUP.intervalSeconds * 1000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(2);
    expect(run.named("warmup_ping")[1]).toMatchObject({ kind: "repeat" });
    expect(run.named("warmup_scheduled")).toHaveLength(1);
    expect(run.sessions()).toMatchObject([{ why: "message", lead: 90, startedAt: expected - LEAD, readyAt: null, endedAt: null }]);
  });

  it("starts as early as the learned cold start (p90) asks", async () => {
    const run = setup({ messages: [listed(SENT)] });
    for (const seconds of [200, 210, 24]) run.store.recordObservation({ direction: "second-to-first", source: "job", seconds, at: 0 });
    vi.setSystemTime(expected - 211_000);
    await run.watcher.scan();
    expect(run.pings).toEqual([]);
    vi.setSystemTime(expected - 210_000);
    await run.watcher.scan();
    expect(run.named("warmup_scheduled")).toMatchObject([{ leadSeconds: 210, leadBasis: "observed", observations: 3, dueInSeconds: 210 }]);
  });

  it("learns how long the worker took, holds it with a ping before its idle timeout, and stops once the job starts", async () => {
    const held = heldPing();
    const run = setup({ messages: [listed(SENT)], ping: held.ping });
    vi.setSystemTime(expected - LEAD);
    const scan = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    // A cold worker: the endpoint holds the ping 40 s. Scans meanwhile send nothing.
    await vi.advanceTimersByTimeAsync(35_000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    held.answer(200);
    await scan;
    expect(run.named("warmup_ready")).toMatchObject([{ why: "message", readySeconds: 40, cold: true, secondsToDue: 50, sessionEnded: false }]);
    expect(run.store.lead(DEFAULT_WARMUP)).toEqual({ seconds: 40, basis: "observed", observations: 1 });
    // The hold timer pings just before the idle timeout, without waiting for a scan.
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.holdIntervalSeconds * 1000 - 1);
    expect(run.pings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.pings).toHaveLength(2);
    held.answer(200);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.named("warmup_held")).toMatchObject([{ holds: 1, secondsToDue: 10 }]);
    // The job starts: the session is used, and no more pings go out.
    run.state.active = job();
    await run.watcher.scan();
    expect(run.named("warmup_used")).toMatchObject([{ why: "message", ready: true, warmSeconds: 80, readyBeforeDueSeconds: 50 }]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run.pings).toHaveLength(2);
    expect(run.sessions()).toMatchObject([{ readyAt: expected - LEAD + 40_000, endedAt: expected - 10_000, outcome: "used" }]);
  });

  it("a ready answer within seconds found a warm worker: nothing is learned", async () => {
    const run = setup({ messages: [listed(SENT)], ping: async () => 200 });
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    expect(run.named("warmup_ready")).toMatchObject([{ readySeconds: 0, cold: false }]);
    expect(run.store.lead(DEFAULT_WARMUP)).toMatchObject({ basis: "default" });
  });

  it("stops when the message no longer waits (delivered or covered), and logs the warm-up as wasted", async () => {
    const run = setup({ messages: [listed(SENT)], ping: async () => 200 });
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    run.state.messages = [];
    vi.setSystemTime(expected - LEAD + 20_000);
    await run.watcher.scan();
    expect(run.named("warmup_wasted")).toMatchObject([{ reason: "covered", ready: true, holds: 0, warmSeconds: 20 }]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run.pings).toHaveLength(1);
    expect(run.sessions()).toMatchObject([{ outcome: "covered" }]);
  });

  it("keeps holding past the due time while the finality is late, and stops after the grace", async () => {
    const run = setup({ messages: [listed(SENT)], ping: async () => 200 });
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    // Each hold re-arms the timer: pings every 40 s until the grace ends at expected + 90 s.
    await vi.advanceTimersByTimeAsync(LEAD + DEFAULT_WARMUP.graceSeconds * 1000);
    const holds = run.named("warmup_held").length;
    expect(holds).toBe(4);
    expect(run.pings.every((at, index) => index === 0 || at - (run.pings[index - 1] as number) === DEFAULT_WARMUP.holdIntervalSeconds * 1000)).toBe(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.holdIntervalSeconds * 1000);
    expect(run.named("warmup_wasted")).toMatchObject([{ reason: "grace", ready: true, holds: 4 }]);
    expect(run.pings).toHaveLength(5);
  });

  it("never sends a second ping while one is outstanding, and a job that starts while the worker boots ends the session", async () => {
    const held = heldPing();
    const run = setup({ messages: [listed(SENT)], ping: held.ping });
    vi.setSystemTime(expected - LEAD);
    const scan = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    for (let step = 1; step <= 4; step += 1) {
      vi.setSystemTime(expected - LEAD + step * DEFAULT_WARMUP.intervalSeconds * 1000);
      await run.watcher.scan();
    }
    expect(held.outstanding()).toBe(1);
    expect(run.pings).toHaveLength(1);
    run.state.active = job();
    await run.watcher.scan();
    expect(run.named("warmup_used")).toMatchObject([{ ready: false, readyBeforeDueSeconds: null }]);
    // The ping answers after the session ended: the time is still learned, from the session's start.
    held.answer(200);
    await scan;
    expect(run.named("warmup_ready")).toMatchObject([{ readySeconds: 120, cold: true, sessionEnded: true }]);
    expect(run.store.lead(DEFAULT_WARMUP)).toMatchObject({ seconds: 120 });
    run.state.active = null;
    run.state.messages = [];
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run.pings).toHaveLength(1);
  });

  it("logs a timed-out ping, learns that the start took at least that long, and sends none for the minimum gap after it", async () => {
    const held = heldPing();
    const run = setup({ messages: [listed(SENT), listed(SENT + 32, "b")], ping: held.ping });
    vi.setSystemTime(expected - LEAD);
    const scan = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(expected - LEAD + 300_000);
    held.fail(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await scan;
    expect(run.named("warmup_ping_timeout")).toMatchObject([{ level: "info", direction: "first-to-second", why: "message", waitedSeconds: 300 }]);
    expect(run.named("warmup_ping_failed")).toEqual([]);
    expect(run.named("warmup_wasted")).toEqual([]);
    expect(run.sessions()).toMatchObject([{ outcome: "timeout" }]);
    expect(run.store.lead(DEFAULT_WARMUP)).toMatchObject({ seconds: 300, basis: "observed" });
    // The second message's finality is near, but the gap since the timeout has not passed.
    const second = expectedFinalityAt(SENT + 32, facts()) * 1000;
    vi.setSystemTime(second);
    expect(second - (expected - LEAD + 300_000)).toBeLessThan(DEFAULT_WARMUP.minGapSeconds * 1000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    // An abort counts the same.
    run.state.messages = [listed(SENT + 640, "c")];
    const third = expectedFinalityAt(SENT + 640, facts()) * 1000;
    vi.setSystemTime(third - 300_000);
    const again = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    held.fail(new DOMException("aborted", "AbortError"));
    await again;
    expect(run.pings).toHaveLength(2);
    expect(run.named("warmup_ping_timeout")).toHaveLength(2);
  });

  it("a timeout after the session ended is learned and ends nothing", async () => {
    const held = heldPing();
    const run = setup({ messages: [listed(SENT)], ping: held.ping });
    vi.setSystemTime(expected - LEAD);
    const scan = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    run.state.messages = [];
    await run.watcher.scan();
    vi.setSystemTime(expected - LEAD + 300_000);
    held.fail(new DOMException("aborted", "AbortError"));
    await scan;
    expect(run.sessions()).toMatchObject([{ outcome: "covered" }]);
    expect(run.named("warmup_ping_timeout")).toMatchObject([{ waitedSeconds: 300 }]);
    // No gap: a new message can start a session at once.
    run.state.messages = [listed(SENT + 32, "b")];
    vi.setSystemTime(expectedFinalityAt(SENT + 32, facts()) * 1000 - 60_000);
    const next = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.pings).toHaveLength(2);
    held.answer(204);
    await next;
  });

  it("a hold not answered ready, or failed, waits the interval before the next: no ping storm", async () => {
    const answers: Array<number | Error> = [200, 204, new Error("endpoint down"), 200];
    const run = setup({
      messages: [listed(SENT)],
      ping: async () => {
        const next = answers.shift() as number | Error;
        if (next instanceof Error) throw next;
        return next;
      },
    });
    const start = expected - LEAD;
    vi.setSystemTime(start);
    await run.watcher.scan();
    // The hold at +40 s is answered 204: the worker may have left. The next hold waits the 30 s interval.
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.holdIntervalSeconds * 1000);
    expect(run.named("warmup_ping")).toMatchObject([{ kind: "hold", status: 204 }]);
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.intervalSeconds * 1000 - 1);
    expect(run.pings).toHaveLength(2);
    // At +70 s the hold fails: a warning, and again the interval.
    await vi.advanceTimersByTimeAsync(1);
    expect(run.named("warmup_ping_failed")).toMatchObject([{ level: "warn", kind: "hold", error: { message: "endpoint down" } }]);
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.intervalSeconds * 1000);
    expect(run.named("warmup_held")).toMatchObject([{ holds: 1 }]);
    expect(run.pings.map((at) => (at - start) / 1000)).toEqual([0, 40, 70, 100]);
  });

  it("answers that come after the session ended change nothing, and teach nothing from a hold", async () => {
    const held = heldPing();
    let first = true;
    const run = setup({
      messages: [listed(SENT)],
      ping: () => {
        if (first) {
          first = false;
          return Promise.resolve(200);
        }
        return held.ping();
      },
    });
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    // The hold at +40 s is still out when the message is covered; its late 200 is not a cold start.
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.holdIntervalSeconds * 1000);
    expect(held.outstanding()).toBe(1);
    run.state.messages = [];
    await run.watcher.scan();
    await vi.advanceTimersByTimeAsync(30_000);
    held.answer(200);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.named("warmup_held")).toEqual([]);
    expect(run.store.lead(DEFAULT_WARMUP)).toMatchObject({ basis: "default" });
    // A new message's first ping, out when that message is covered too, answered 204: only logged.
    run.state.messages = [listed(SENT + 32, "b")];
    vi.setSystemTime(expectedFinalityAt(SENT + 32, facts()) * 1000 - 60_000);
    const scan = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    run.state.messages = [];
    await run.watcher.scan();
    held.answer(204);
    await scan;
    expect(run.named("warmup_ping").at(-1)).toMatchObject({ kind: "start", status: 204 });
    // And one that fails after its session ended: only the warning.
    run.state.messages = [listed(SENT + 64, "c")];
    vi.setSystemTime(expectedFinalityAt(SENT + 64, facts()) * 1000 - 60_000);
    const last = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    run.state.messages = [];
    await run.watcher.scan();
    held.fail(new Error("endpoint down"));
    await last;
    expect(run.named("warmup_ping_failed")).toMatchObject([{ kind: "start" }]);
    expect(run.sessions()).toMatchObject([{ outcome: "covered" }, { outcome: "covered" }, { outcome: "covered" }]);
  });

  it("a failed first ping is logged and tried again after the interval", async () => {
    let fail = true;
    const run = setup({
      messages: [listed(SENT)],
      ping: async () => {
        if (fail) throw new Error("endpoint down");
        return 204;
      },
    });
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    expect(run.named("warmup_ping_failed")).toMatchObject([{ kind: "start", error: { message: "endpoint down" } }]);
    fail = false;
    vi.setSystemTime(expected - LEAD + DEFAULT_WARMUP.intervalSeconds * 1000 - 1);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    vi.setSystemTime(expected - LEAD + DEFAULT_WARMUP.intervalSeconds * 1000);
    await run.watcher.scan();
    expect(run.named("warmup_ping")).toMatchObject([{ kind: "repeat", status: 204 }]);
  });

  it("stops holding once the daily cap is spent, and starts no session while it is", async () => {
    const run = setup({ messages: [listed(SENT)], ping: async () => 200, warmup: { dailyCapSeconds: 60 } });
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.holdIntervalSeconds * 1000);
    expect(run.named("warmup_held")).toHaveLength(1);
    // 80 s warm by the next hold: over the cap.
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.holdIntervalSeconds * 1000);
    expect(run.named("warmup_wasted")).toMatchObject([{ reason: "cap", holds: 1, warmSeconds: 80 }]);
    // Another message within its lead time: refused, logged once.
    run.state.messages = [listed(SENT + 32, "b")];
    const second = expectedFinalityAt(SENT + 32, facts()) * 1000;
    vi.setSystemTime(second - 30_000);
    await run.watcher.scan();
    await run.watcher.scan();
    expect(run.named("warmup_capped")).toMatchObject([{ level: "warn", why: "message", dueInSeconds: 30, dailyCapSeconds: 60 }]);
    expect(run.pings).toHaveLength(2);
  });

  it("sends no warm-up for a keep-alive inside the period of finality (2026-10-31)", async () => {
    const head = 1001 * PERIOD - 500;
    const run = setup({ facts: facts(head, false) });
    const reading = observation(head + 32);
    arrive(reading);
    run.watcher.observe(reading);
    await run.watcher.settled();
    for (let step = 0; step < 40; step += 1) {
      vi.setSystemTime(reading.receivedAt + step * 15_000);
      await run.watcher.scan();
    }
    expect(run.pings).toEqual([]);
  });

  it("logs a failed scan once", async () => {
    const run = setup({ messages: [listed(SENT)] });
    vi.setSystemTime(expected);
    run.state.factsFail = true;
    await run.watcher.scan();
    await run.watcher.scan();
    expect(run.named("watch_scan_failed")).toHaveLength(1);
    run.state.factsFail = false;
    await run.watcher.scan();
    run.state.factsFail = true;
    // Facts read a moment ago serve the next scan.
    await run.watcher.scan();
    expect(run.named("watch_scan_failed")).toHaveLength(1);
  });

  it("sends nothing when warm-ups are off", async () => {
    const run = setup({ messages: [listed(SENT)], ping: false });
    vi.setSystemTime(expected);
    await run.watcher.scan();
    expect(run.reads.messages).toBe(0);
  });

  it("uses the finality and the facts of the last reading", async () => {
    const run = setup({ messages: [listed(SENT)] });
    // The message is final already: no warm-up for it.
    const reading = observation(SENT + 40, 100);
    arrive(reading);
    run.watcher.observe(reading);
    await run.watcher.settled();
    const factsReads = run.reads.facts;
    vi.setSystemTime(expected);
    await run.watcher.scan();
    expect(run.pings).toEqual([]);
    expect(run.reads.facts).toBe(factsReads);
  });

  it("stop cancels the hold timer", async () => {
    const run = setup({ messages: [listed(SENT)], ping: async () => 200 });
    vi.setSystemTime(expected - LEAD);
    await run.watcher.scan();
    await run.watcher.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_WARMUP.holdIntervalSeconds * 1000);
    expect(run.pings).toHaveLength(1);
  });
});

describe("the direction watcher, with a batch wait (2026-11-01)", () => {
  const WAIT: BatchRule = { maxWaitSeconds: 3600, lookaheadSeconds: 1200, marginWad: 10n ** 18n };
  const USD = 10n ** 18n;
  const priced = (fees: Record<string, bigint>): Economics => ({ kind: "known", feesUsd: new Map(Object.entries(fees)), deliveryUsd: 0n, unpriced: 0, block: "7" });
  const finalAt = (slot: number) => expectedFinalityAt(slot, facts()) * 1000;

  it("waits while the batch does not pay, then proves every waiting message at its fallback, also one sent meanwhile", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a")], batchRule: WAIT });
    const reading = observation(HEAD + 128);
    arrive(reading);
    run.watcher.observe(reading);
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    const [waiting] = run.named("proof_not_due");
    expect(waiting).toMatchObject({ why: "waiting-for-profit", messages: 1, feesUsd: null, costUsd: null, startWhy: "max-wait", maxWaitAt: new Date(finalAt(HEAD + 100) + 3_600_000).toISOString() });
    expect(waiting!.detail).toContain("the fees cannot be valued (no prices in this test)");
    // A message sent during the wait, final before the fallback, rides along with the next finality.
    run.state.messages = [listed(HEAD + 100, "a"), listed(HEAD + 140, "b")];
    const later = observation(HEAD + 160);
    arrive(later);
    run.watcher.observe(later);
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    // No new finality is needed: the watcher wakes at the fallback by itself.
    await vi.advanceTimersByTimeAsync(finalAt(HEAD + 100) + 3_600_000 - Date.now());
    await run.watcher.settled();
    expect(run.submitted).toMatchObject([{ messageId: id("a"), target: { startSlot: HEAD, newSlot: HEAD + 160 } }]);
    expect(run.named("proof_due")).toMatchObject([{ why: "message", trigger: "max-wait", batch: 2, waitedSeconds: 3600, feesUsd: null, costUsd: null }]);
    // The fallback timer of the first reading finds the job made: nothing more.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(run.submitted).toHaveLength(1);
  });

  it("proves at once when the batch pays", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a"), listed(HEAD + 110, "b")], batchRule: WAIT, economics: priced({ [id("a")]: USD }) });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.named("proof_due")).toMatchObject([{ why: "message", trigger: "profit", batch: 2, feesUsd: "1.000000", costUsd: "0.025000" }]);
  });

  it("waits for the finality of an upcoming message that makes the batch pay, and proves both together", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a"), listed(HEAD + 140, "b")], batchRule: WAIT, economics: priced({ [id("b")]: USD }) });
    const first = observation(HEAD + 128);
    arrive(first);
    run.watcher.observe(first);
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    expect(run.named("proof_not_due")).toMatchObject([{ why: "waiting-for-profit", startWhy: "profit", startAt: new Date(finalAt(HEAD + 140)).toISOString() }]);
    const second = observation(HEAD + 160);
    arrive(second);
    run.watcher.observe(second);
    await run.watcher.settled();
    expect(run.named("proof_due")).toMatchObject([{ trigger: "profit", batch: 2 }]);
    // Two readings 384 s apart: two valuations.
    expect(run.reads.economics).toBe(2);
  });

  it("a valuation that fails counts as unknown: the batch waits for its fallback", async () => {
    const run = setup({
      messages: [listed(HEAD + 100, "a")],
      batchRule: WAIT,
      economics: async () => {
        throw new Error("no route");
      },
    });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.named("watch_economics_failed")).toMatchObject([{ error: { message: "no route" } }]);
    expect(run.named("proof_not_due")[0]!.detail).toContain("the prices could not be read");
    expect(run.submitted).toEqual([]);
    // The same messages within a minute: the valuation is not read again.
    run.watcher.observe(observation(HEAD + 128, 501));
    await run.watcher.settled();
    expect(run.reads.economics).toBe(1);
  });

  it("does not value anything when no message waits or the head covers them", async () => {
    const run = setup({ messages: [listed(HEAD - 5)], batchRule: WAIT });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.reads.economics).toBe(0);
  });

  it("times the warm-up to the batch: its fallback, not each message's finality", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a"), listed(HEAD + 150, "b")], batchRule: WAIT });
    const due = finalAt(HEAD + 100) + 3_600_000;
    vi.setSystemTime(finalAt(HEAD + 150) - 90_000);
    await run.watcher.scan();
    expect(run.pings).toEqual([]);
    vi.setSystemTime(due - DEFAULT_WARMUP.defaultLeadSeconds * 1000);
    await run.watcher.scan();
    expect(run.named("warmup_scheduled")).toMatchObject([{ why: "message", dueAt: new Date(due).toISOString(), dueInSeconds: 90 }]);
  });

  it("stop cancels the fallback timer", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a")], batchRule: WAIT });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    await run.watcher.stop();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(run.submitted).toEqual([]);
  });
});

describe("the direction watcher, with a proof we have (2026-11-01)", () => {
  it("waits for a pending proof to land rather than proving the messages after it from the same head", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a"), listed(HEAD + 140, "b")] });
    run.state.held = [{ startSlot: HEAD, newSlot: HEAD + 128, where: "board", since: Date.now() }];
    run.watcher.observe(observation(HEAD + 160));
    await run.watcher.settled();
    expect(run.submitted).toEqual([]);
    expect(run.named("proof_not_due")).toMatchObject([{ why: "proof-pending", detail: `the proof from slot ${HEAD} to slot ${HEAD + 128} (board) waits to land; 1 message after it waits for it to land` }]);
    // It landed: the head moved, and the next finality proves from the new head.
    run.state.facts = facts(HEAD + 128);
    run.watcher.observe(observation(HEAD + 192));
    await run.watcher.settled();
    expect(run.submitted).toMatchObject([{ messageId: id("b"), target: { startSlot: HEAD + 128, newSlot: HEAD + 192 } }]);
  });

  it("proves past a pending proof that waited too long, and says so", async () => {
    const run = setup({ messages: [listed(HEAD + 140, "b")] });
    const reading = observation(HEAD + 160);
    arrive(reading);
    run.state.held = [{ startSlot: HEAD, newSlot: HEAD + 128, where: "stored", since: Date.now() - 601_000 }];
    run.watcher.observe(reading);
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(1);
    expect(run.named("proof_pending_stale")).toMatchObject([{ startSlot: HEAD, newSlot: HEAD + 128, where: "stored", waitedSeconds: 601 }]);
  });

  it("a duplicate target is not tried again", async () => {
    const run = setup({ messages: [listed(HEAD + 100)], submit: () => ({ refused: "duplicate" }) });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.named("proof_due_refused")).toMatchObject([{ refused: "duplicate", retryInSeconds: null }]);
    run.watcher.observe(observation(HEAD + 128));
    await vi.advanceTimersByTimeAsync(60_000);
    await run.watcher.settled();
    expect(run.submitted).toHaveLength(1);
  });
});

describe("the direction watcher reports its decisions (2026-11-01)", () => {
  const WAIT: BatchRule = { maxWaitSeconds: 3600, lookaheadSeconds: 1200, marginWad: 10n ** 18n };
  const USD = 10n ** 18n;
  const priced = (fees: Record<string, bigint>): Economics => ({ kind: "known", feesUsd: new Map(Object.entries(fees)), deliveryUsd: 0n, unpriced: 0, block: "7" });
  const finalAt = (slot: number) => expectedFinalityAt(slot, facts()) * 1000;

  it("a batch that waits: its size, worth and times in milliseconds, with the slot clock of the light client", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a")], batchRule: WAIT, recordDecisions: true });
    const reading = observation(HEAD + 128);
    arrive(reading);
    run.watcher.observe(reading);
    await run.watcher.settled();
    expect(run.decisions).toEqual([
      {
        at: reading.receivedAt,
        finalizedSlot: HEAD + 128,
        headSlot: HEAD,
        genesisTime: GENESIS,
        secondsPerSlot: SLOT,
        due: false,
        why: "waiting-for-profit",
        detail: expect.stringContaining("1 message waits"),
        batch: { messages: 1, feesUsd: null, costUsd: null, unknownWhy: "no prices in this test", oldestFinalAt: finalAt(HEAD + 100), startAt: finalAt(HEAD + 100) + 3_600_000, startWhy: "max-wait", maxWaitAt: finalAt(HEAD + 100) + 3_600_000 },
      },
    ]);
  });

  it("a priced batch that waits for profit carries its fees and cost", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a"), listed(HEAD + 140, "b")], batchRule: WAIT, economics: priced({ [id("b")]: USD }), recordDecisions: true });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.decisions[0]?.batch).toMatchObject({ feesUsd: "0.000000", costUsd: "0.025000", startWhy: "profit", startAt: finalAt(HEAD + 140) });
  });

  it("a due batch says what triggered it and that the job started; a later one meets the running job", async () => {
    const run = setup({ messages: [listed(HEAD + 100, "a"), listed(HEAD + 110, "b")], batchRule: WAIT, economics: priced({ [id("a")]: USD }), recordDecisions: true });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.decisions).toMatchObject([{ due: true, why: "message", trigger: "profit", batchSize: 2, feesUsd: "1.000000", costUsd: "0.025000", outcome: "job-started" }]);
    run.watcher.observe(observation(HEAD + 160));
    await run.watcher.settled();
    expect(run.decisions.at(-1)).toMatchObject({ due: true, outcome: "job-active", finalizedSlot: HEAD + 160 });
  });

  it("a proof due without a batch wait carries no batch facts; a refusal is its outcome", async () => {
    const run = setup({ messages: [listed(HEAD + 100)], submit: () => ({ refused: "duplicate" }), recordDecisions: true });
    run.watcher.observe(observation(HEAD + 128));
    await run.watcher.settled();
    expect(run.decisions).toHaveLength(1);
    expect(run.decisions[0]).toMatchObject({ due: true, why: "message", outcome: "duplicate" });
    expect(run.decisions[0]).not.toHaveProperty("trigger");
  });

  it("a second keep-alive in one period is reported as held back", async () => {
    const head = 1000 * PERIOD + 8000;
    const run = setup({ facts: facts(head, false), recordDecisions: true });
    const first = observation(1001 * PERIOD + 4);
    arrive(first);
    run.watcher.observe(first);
    await run.watcher.settled();
    run.state.active = null;
    const second = observation(1001 * PERIOD + 36);
    arrive(second);
    run.watcher.observe(second);
    await run.watcher.settled();
    expect(run.decisions.map((decision) => decision.outcome)).toEqual(["job-started", "keep-alive-this-period"]);
  });

  it("a decision that is not due and has no batch carries none", async () => {
    const run = setup({ messages: [listed(HEAD + 100)], recordDecisions: true });
    run.watcher.observe(observation(HEAD + 128, MIN_PARTICIPANTS - 1));
    await run.watcher.settled();
    expect(run.decisions).toMatchObject([{ due: false, why: "insufficient-signatures" }]);
    expect(run.decisions[0]).not.toHaveProperty("batch");
  });
});
