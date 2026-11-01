import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { DEFAULT_POLICY, type LightClientFacts, type SourceHistory } from "../src/keepalive/plan.ts";
import type { Job } from "../src/requests/jobs.ts";
import type { ProofRequest, SubmitResult } from "../src/requests/service.ts";
import { DEFAULT_WARMUP, MIN_PARTICIPANTS, expectedFinalityAt } from "../src/watch/decide.ts";
import type { FinalityObservation } from "../src/watch/feed.ts";
import { createDirectionWatcher, pendingProofOf, REFUSED_RETRIES, REFUSED_RETRY_SECONDS, type ListedMessage } from "../src/watch/watcher.ts";
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

function setup(options: { messages?: ListedMessage[]; facts?: LightClientFacts; submit?: (request: ProofRequest) => SubmitResult; ping?: boolean | (() => Promise<number>) } = {}) {
  const log = memoryLogger();
  const state = {
    facts: options.facts ?? facts(),
    messages: options.messages ?? [],
    active: null as Job | null,
    latest: null as Job | null,
    factsFail: false,
    history: { kind: "serves" } as SourceHistory,
  };
  const submitted: ProofRequest[] = [];
  const pings: number[] = [];
  const reads = { facts: 0, messages: 0, history: 0 };
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
    findLatestJob: () => state.latest,
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
    warmup: DEFAULT_WARMUP,
    maxRetrySeconds: 600,
    logger: log.logger,
    now: Date.now,
  });
  const events = () => log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { watcher, state, submitted, pings, reads, named: (name: string) => events().filter((event) => event.event === name) };
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
    expect(run.submitted).toEqual([{ pair: "sepolia-pls943", direction: "first-to-second", reason: "finality", caller: "watch", messageId: id("a"), since: reading.receivedAt }]);
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
    run.state.latest = job({ status: "published", startSlot: String(HEAD), newSlot: String(HEAD + 128) });
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

  it("pings the remote prover once the lead time before the message's expected finality begins", async () => {
    const run = setup({ messages: [listed(SENT)] });
    vi.setSystemTime(expected - DEFAULT_WARMUP.leadSeconds * 1000 - 1000);
    await run.watcher.scan();
    expect(run.pings).toEqual([]);
    vi.setSystemTime(expected - DEFAULT_WARMUP.leadSeconds * 1000);
    await run.watcher.scan();
    expect(run.pings).toEqual([expected - DEFAULT_WARMUP.leadSeconds * 1000]);
    expect(run.named("warmup_ping")).toMatchObject([{ direction: "first-to-second", why: "message", session: "new", secondsToStart: DEFAULT_WARMUP.leadSeconds, status: 204 }]);
    // Inside the session: again after the interval, not before.
    vi.setSystemTime(expected - DEFAULT_WARMUP.leadSeconds * 1000 + 15_000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    vi.setSystemTime(expected - DEFAULT_WARMUP.leadSeconds * 1000 + DEFAULT_WARMUP.intervalSeconds * 1000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(2);
    expect(run.named("warmup_ping")[1]).toMatchObject({ session: "repeat" });
  });

  it("stops pinging once the job runs, and after the session's end", async () => {
    const run = setup({ messages: [listed(SENT)] });
    vi.setSystemTime(expected - 10_000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    run.state.active = job();
    vi.setSystemTime(expected + 30_000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    run.state.active = null;
    vi.setSystemTime(expected + DEFAULT_WARMUP.graceSeconds * 1000 + 1000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
  });

  it("keeps one ping outstanding at most; a 200 ends the session", async () => {
    let answer!: (status: number) => void;
    const run = setup({ messages: [listed(SENT)], ping: () => new Promise<number>((resolve) => (answer = resolve)) });
    vi.setSystemTime(expected - DEFAULT_WARMUP.leadSeconds * 1000);
    const scan = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    // The endpoint holds the first ping while a worker starts: later scans send nothing.
    vi.setSystemTime(expected - DEFAULT_WARMUP.leadSeconds * 1000 + DEFAULT_WARMUP.intervalSeconds * 1000);
    await run.watcher.scan();
    vi.setSystemTime(expected);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    answer(200);
    await scan;
    expect(run.named("warmup_ping")).toMatchObject([{ why: "message", session: "new", status: 200 }]);
    // Warm: the session is over, no repeat.
    vi.setSystemTime(expected + DEFAULT_WARMUP.intervalSeconds * 1000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
  });

  it("logs a timed-out ping at info and sends none for the minimum gap after it", async () => {
    let fail!: (error: Error) => void;
    const run = setup({ messages: [listed(SENT), listed(SENT + 32, "b")], ping: () => new Promise<number>((_, reject) => (fail = reject)) });
    vi.setSystemTime(expected - DEFAULT_WARMUP.leadSeconds * 1000);
    const scan = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(expected + 120_000);
    fail(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await scan;
    expect(run.named("warmup_ping_timeout")).toMatchObject([{ level: "info", direction: "first-to-second", why: "message" }]);
    expect(run.named("warmup_ping_failed")).toEqual([]);
    expect(run.named("warmup_ping")).toEqual([]);
    // The second message's finality is near, but the gap since the timeout has not passed.
    const second = expectedFinalityAt(SENT + 32, facts()) * 1000;
    vi.setSystemTime(second - DEFAULT_WARMUP.leadSeconds * 1000);
    expect(second - DEFAULT_WARMUP.leadSeconds * 1000 - (expected + 120_000)).toBeLessThan(DEFAULT_WARMUP.minGapSeconds * 1000);
    await run.watcher.scan();
    expect(run.pings).toHaveLength(1);
    // An abort counts the same.
    run.state.messages = [listed(SENT + 640, "c")];
    const third = expectedFinalityAt(SENT + 640, facts()) * 1000;
    vi.setSystemTime(third - DEFAULT_WARMUP.leadSeconds * 1000);
    const again = run.watcher.scan();
    await vi.advanceTimersByTimeAsync(0);
    fail(new DOMException("aborted", "AbortError"));
    await again;
    expect(run.pings).toHaveLength(2);
    expect(run.named("warmup_ping_timeout")).toHaveLength(2);
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

  it("logs a failed ping and a failed scan once", async () => {
    const run = setup({ messages: [listed(SENT)] });
    vi.setSystemTime(expected);
    const failing = createDirectionWatcherWithPing(async () => {
      throw new Error("endpoint down");
    });
    await failing.watcher.scan();
    expect(failing.named("warmup_ping_failed")).toMatchObject([{ error: { message: "endpoint down" } }]);
    expect(failing.named("warmup_ping")).toEqual([]);
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

  function createDirectionWatcherWithPing(ping: () => Promise<number>) {
    const log = memoryLogger();
    const watcher = createDirectionWatcher({
      pairName: "sepolia-pls943",
      direction: "first-to-second",
      sourceChainId: 11155111,
      readFacts: async () => facts(),
      readMessages: async () => [listed(SENT)],
      readHistory: async () => ({ kind: "not-needed" }),
      findActiveJob: () => null,
      findLatestJob: () => null,
      submit: async () => ({ refused: "nothing-to-prove" }),
      ping,
      policy: DEFAULT_POLICY,
      minParticipants: MIN_PARTICIPANTS,
      warmup: DEFAULT_WARMUP,
      maxRetrySeconds: 600,
      logger: log.logger,
      now: Date.now,
    });
    return { watcher, named: (name: string) => log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event.event === name) };
  }
});

describe("pendingProofOf", () => {
  it("is the newest job's proof while it waits to land", () => {
    expect(pendingProofOf(null)).toBeNull();
    expect(pendingProofOf(job())).toBeNull();
    expect(pendingProofOf(job({ status: "on-chain", startSlot: "1", newSlot: "2" }))).toBeNull();
    expect(pendingProofOf(job({ status: "published", startSlot: "1", newSlot: "2" }))).toEqual({ startSlot: 1, newSlot: 2 });
    expect(pendingProofOf(job({ status: "proving", startSlot: "1", newSlot: "2" }))).toEqual({ startSlot: 1, newSlot: 2 });
  });
});
