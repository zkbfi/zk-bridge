import { describe, expect, it, vi } from "vitest";
import { CommandTimeoutError, ProverCommandError } from "@zk-bridge/shared/prover";
import { DEFAULT_RATE_LIMITS } from "../src/requests/rate-limit.ts";
import { createRequestService } from "../src/requests/service.ts";
import { getTiming } from "../src/requests/timings.ts";
import { openStorage } from "../src/storage.ts";
import { DEFAULT_WARMUP } from "../src/watch/warmup.ts";
import { createWarmupStore } from "../src/watch/warmup-store.ts";
import { makeBackend, makeClock, memoryLogger, makeConfig, makeProofPackage, postFrom, controllableProver, fakeProofNeed } from "./support.ts";

/** The settings before 2026-11-06 (p90, no margin, 90 s grace): the scenarios of these tests rest on them. */
const LEGACY_WARMUP = { ...DEFAULT_WARMUP, leadP: 0.9, leadMarginSeconds: 0, minLeadSeconds: 30, graceSeconds: 90 };

const countJobs = (storage: ReturnType<typeof makeBackend>["storage"]) =>
  (storage.database.prepare("SELECT count(*) AS total FROM jobs").get() as { total: number }).total;

async function post(backend: ReturnType<typeof makeBackend>, caller: string, overrides: Record<string, unknown> = {}) {
  const { init, env } = postFrom(caller, overrides);
  return backend.app.request("/requests", init, env);
}

describe("request coalescing", () => {
  it("two requests for the same direction coalesce into one job", async () => {
    const backend = makeBackend();
    const first = (await (await post(backend, "10.0.0.1")).json()) as { requestId: string; jobId: string };
    const second = (await (await post(backend, "10.0.0.2")).json()) as { requestId: string; jobId: string };
    expect(second.jobId).toBe(first.jobId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(countJobs(backend.storage)).toBe(1);
  });

  it("requests for the two directions make two jobs", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1");
    await post(backend, "10.0.0.1", { direction: "second-to-first" });
    expect(countJobs(backend.storage)).toBe(2);
  });

  it("twenty concurrent POST /requests for one direction create exactly one job", async () => {
    const backend = makeBackend();
    const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => post(backend, `10.0.1.${index}`)));
    const bodies = (await Promise.all(answers.map((answer) => answer.json()))) as Array<{ jobId: string }>;
    expect(answers.every((answer) => answer.status === 202)).toBe(true);
    expect(countJobs(backend.storage)).toBe(1);
    const jobId = (backend.storage.database.prepare("SELECT id FROM jobs").get() as { id: string }).id;
    expect(new Set(bodies.map((body) => body.jobId))).toEqual(new Set([jobId]));
    const named = backend.storage.database.prepare("SELECT count(*) AS total FROM requests WHERE job_id = ?").get(jobId) as { total: number };
    expect(named.total).toBe(20);
    expect(backend.prover.calls).toHaveLength(1);
  });

  it("a finished job lets the next request start a new job", async () => {
    const backend = makeBackend();
    const first = (await (await post(backend, "10.0.0.1")).json()) as { jobId: string };
    backend.prover.settleAll({ kind: "up-to-date" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    backend.clock.advance(121_000);
    const second = (await (await post(backend, "10.0.0.1")).json()) as { jobId: string };
    expect(second.jobId).not.toBe(first.jobId);
    expect(countJobs(backend.storage)).toBe(2);
  });

  it("a job proves from the on-chain head: the prover runs with no explicit head", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1", { direction: "second-to-first" });
    expect(backend.prover.calls).toEqual([{ direction: "second-to-first" }]);
  });
});

describe("whether the chains need a proof", () => {
  const countRequests = (storage: ReturnType<typeof makeBackend>["storage"]) =>
    (storage.database.prepare("SELECT count(*) AS total FROM requests").get() as { total: number }).total;

  it("starts no job and answers 409 when no message waits and the head is fresh, whatever the reason of the request", async () => {
    const backend = makeBackend({ proofNeed: fakeProofNeed({ needed: false }) });
    for (const reason of ["user", "keep-alive"]) {
      const answer = await post(backend, "10.0.0.1", { reason });
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: "nothing-to-prove" });
    }
    expect(countJobs(backend.storage)).toBe(0);
    expect(countRequests(backend.storage)).toBe(0);
    expect(backend.prover.calls).toEqual([]);
  });

  it("asks the indexer about the direction of the request", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1", { direction: "second-to-first" });
    expect(backend.proofNeed.reads).toEqual([{ direction: "second-to-first", now: backend.clock.now() }]);
  });

  it("answers 503 with Retry-After when the indexer cannot answer, and logs why", async () => {
    const backend = makeBackend({ proofNeed: fakeProofNeed(new Error("the chain indexer answered 500 for the feed")) });
    const answer = await post(backend, "10.0.0.1");
    expect(answer.status).toBe(503);
    expect(answer.headers.get("Retry-After")).toBe("30");
    expect(await answer.json()).toEqual({ error: "cannot-check", retryAfterSeconds: 30 });
    expect(countJobs(backend.storage)).toBe(0);
    expect(backend.log.lines.join("\n")).toContain("proof_need_unknown");
  });

  it("does not ask the indexer for a request that joins an active job, or that a rate limit refuses", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { requestsPerCallerPerMinute: 1 } }) });
    expect((await post(backend, "10.0.0.1")).status).toBe(202);
    expect((await post(backend, "10.0.0.2")).status).toBe(202);
    expect((await post(backend, "10.0.0.1")).status).toBe(429);
    backend.prover.settleAll({ kind: "up-to-date" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await post(backend, "10.0.0.3")).status).toBe(429);
    expect(backend.proofNeed.reads).toHaveLength(1);
  });

  it("reuses an answer of the indexer for 15 seconds, so a burst of requests reads it once", async () => {
    const backend = makeBackend({ proofNeed: fakeProofNeed({ needed: false }) });
    for (let index = 0; index < 5; index += 1) expect((await post(backend, `10.0.2.${index}`)).status).toBe(409);
    expect(backend.proofNeed.reads).toHaveLength(1);
    backend.proofNeed.answer({ needed: true, why: "keep-alive" });
    backend.clock.advance(15_000);
    expect((await post(backend, "10.0.2.9")).status).toBe(202);
    expect(backend.proofNeed.reads).toHaveLength(2);
  });

  it("does not keep a failed read: the next request asks again", async () => {
    const backend = makeBackend({ proofNeed: fakeProofNeed(new Error("down")) });
    expect((await post(backend, "10.0.0.1")).status).toBe(503);
    backend.proofNeed.answer({ needed: true, why: "waiting-message" });
    expect((await post(backend, "10.0.0.2")).status).toBe(202);
  });

  it("concurrent requests share one read and still make one job", async () => {
    const backend = makeBackend();
    const answers = await Promise.all(Array.from({ length: 10 }, (_, index) => post(backend, `10.0.3.${index}`)));
    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(202));
    expect(backend.proofNeed.reads).toHaveLength(1);
    expect(countJobs(backend.storage)).toBe(1);
  });
});

describe("job life", () => {
  it("a proof keeps the job proving and records the slots; the webhook moves it on", async () => {
    const backend = makeBackend();
    const { jobId } = (await (await post(backend, "10.0.0.1")).json()) as { jobId: string };
    expect(((await (await backend.app.request(`/directions/first-to-second`)).json()) as { job: { status: string } }).job.status).toBe("proving");
    backend.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const job = ((await (await backend.app.request("/directions/first-to-second")).json()) as { job: { jobId: string; status: string; startSlot: string; newSlot: string } }).job;
    expect(job).toMatchObject({ jobId, status: "proving", startSlot: "10", newSlot: "42" });
  });

  it("a proof that met a cold worker teaches the warm-up how long a cold start takes", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1");
    backend.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42), timing: { wait_worker_ms: 61_500, not_ready_count: 2, worker_gpu: "RTX 5090" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = backend.log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.event === "warmup_observed")).toMatchObject([{ direction: "first-to-second", source: "job", seconds: 61.5 }]);
    expect(createWarmupStore(backend.storage).lead(LEGACY_WARMUP)).toMatchObject({ seconds: 62, basis: "observed" });
  });

  it("keeps the prover's timings of every proof (2026-11-01)", async () => {
    const backend = makeBackend();
    const { jobId } = (await (await post(backend, "10.0.0.1")).json()) as { jobId: string };
    const startedAt = backend.clock.now();
    backend.clock.advance(90_000);
    backend.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42), timing: { wait_worker_ms: 61_500, not_ready_count: 2, remote_ms: 25_000, total_ms: 88_000, worker_prove_ms: 20_000, endpoint: "serverless", worker_gpu: "RTX 5090" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTiming(backend.storage, jobId)).toMatchObject({ direction: "first-to-second", startedAt, provedAt: startedAt + 90_000, waitWorkerMs: 61_500, notReadyCount: 2, remoteMs: 25_000, totalMs: 88_000, workerProveMs: 20_000, endpoint: "serverless", workerGpu: "RTX 5090" });
  });

  it("a cold worker despite a warm-up is a miss, not a cold start; a warm worker or an older prover teaches nothing", async () => {
    const backend = makeBackend();
    const store = createWarmupStore(backend.storage);
    store.openSession({ direction: "first-to-second", why: "message", dueAt: backend.clock.now(), leadSeconds: 90, at: backend.clock.now() - 60_000 });
    await post(backend, "10.0.0.1");
    backend.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42), timing: { wait_worker_ms: 20_000, not_ready_count: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await post(backend, "10.0.0.2", { direction: "second-to-first" });
    backend.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42), timing: { wait_worker_ms: 0, not_ready_count: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = backend.log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.event === "warmup_missed")).toMatchObject([{ level: "warn", direction: "first-to-second", waitWorkerSeconds: 20 }]);
    expect(events.filter((event) => event.event === "warmup_observed")).toEqual([]);
    expect(store.lead(LEGACY_WARMUP)).toMatchObject({ basis: "default" });
  });

  it("a failure to note the proof never fails the job", async () => {
    const storage = openStorage(":memory:");
    const log = memoryLogger();
    const prover = controllableProver();
    const service = createRequestService({
      storage,
      proverForJob: () => prover.binary,
      readProofNeed: fakeProofNeed().read,
      now: makeClock().now,
      limits: DEFAULT_RATE_LIMITS,
      proverTimeoutMilliseconds: 1_800_000,
      logger: log.logger,
      onProved: (event) => {
        expect(event).toMatchObject({ direction: "first-to-second", timing: null });
        throw new Error("database locked");
      },
    });
    await service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "a" });
    prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42) });
    await service.settled();
    expect(storage.database.prepare("SELECT status, new_slot FROM jobs").get()).toEqual({ status: "proving", new_slot: "42" });
    expect(log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event.event === "job_proved_note_failed")).toMatchObject([{ error: { message: "database locked" } }]);
  });

  it("an up-to-date answer ends the job as on-chain", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1");
    backend.prover.settleAll({ kind: "up-to-date" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const job = ((await (await backend.app.request("/directions/first-to-second")).json()) as { job: { status: string } }).job;
    expect(job.status).toBe("on-chain");
  });

  it.each([
    [new ProverCommandError("prove", 2, "secret /home/someone/path"), "the prover stopped with exit code 2"],
    [new CommandTimeoutError("/home/someone/zk-bridge-prover ran longer"), "the prover ran longer than its limit"],
    [new Error("boom /home/someone"), "the prover could not make a proof"],
  ])("a failed prover shows a reason with no path or output: %s", async (error, reason) => {
    const backend = makeBackend();
    const { requestId } = (await (await post(backend, "10.0.0.1")).json()) as { requestId: string };
    backend.prover.failAll(error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = (await (await backend.app.request(`/requests/${requestId}`)).json()) as { status: string; error: string };
    expect(status).toMatchObject({ status: "failed", error: reason });
    expect(JSON.stringify(status)).not.toContain("/home");
  });

  it("a failed job is not retried by itself; the next request after 60 seconds starts a new job", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1");
    backend.prover.failAll(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.prover.calls).toHaveLength(1);
    backend.clock.advance(30_000);
    const early = await post(backend, "10.0.0.1");
    expect(early.status).toBe(429);
    expect(early.headers.get("Retry-After")).toBe("30");
    backend.clock.advance(30_000);
    expect((await post(backend, "10.0.0.1")).status).toBe(202);
    expect(countJobs(backend.storage)).toBe(2);
  });
});

describe("rate limits", () => {
  it("rate limits per caller and per direction answer 429 with Retry-After", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { requestsPerCallerPerMinute: 2 } }) });
    expect((await post(backend, "10.0.0.1")).status).toBe(202);
    expect((await post(backend, "10.0.0.1")).status).toBe(202);
    backend.clock.advance(20_000);
    const callerLimited = await post(backend, "10.0.0.1");
    expect(callerLimited.status).toBe(429);
    expect(callerLimited.headers.get("Retry-After")).toBe("40");
    expect(await callerLimited.json()).toEqual({ error: "rate-limited", retryAfterSeconds: 40 });
    // Another caller is not affected by the first caller.
    expect((await post(backend, "10.0.0.2")).status).toBe(202);

    // Per direction: finish the job, then ask for a new one before the two minutes pass.
    backend.prover.settleAll({ kind: "up-to-date" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    backend.clock.advance(60_000);
    const directionLimited = await post(backend, "10.0.0.3");
    expect(directionLimited.status).toBe(429);
    expect(directionLimited.headers.get("Retry-After")).toBe("40");
    backend.clock.advance(40_000);
    expect((await post(backend, "10.0.0.3")).status).toBe(202);
  });

  it("a request that joins an active job never asks the direction limit", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1");
    expect((await post(backend, "10.0.0.2")).status).toBe(202);
  });

  const forwardedPost = (backend: ReturnType<typeof makeBackend>, forwarded: string, socket: string, overrides: Record<string, unknown> = {}) => {
    const { init } = postFrom(socket, overrides);
    return backend.app.request("/requests", { ...init, headers: { ...init.headers, "x-forwarded-for": forwarded } }, { incoming: { socket: { remoteAddress: socket } } });
  };

  it("a forged prefix in X-Forwarded-For does not change the key: the entry one hop from the right counts", async () => {
    const backend = makeBackend({ config: makeConfig({ trustForwardedHeader: true, limits: { requestsPerCallerPerMinute: 1 } }) });
    expect((await forwardedPost(backend, "6.6.6.1, 203.0.113.9", "10.0.0.1")).status).toBe(202);
    // The client writes a fresh forged first entry each time; the proxy still appends the true address last.
    expect((await forwardedPost(backend, "6.6.6.2, 203.0.113.9", "10.0.0.1")).status).toBe(429);
    expect((await forwardedPost(backend, "6.6.6.3, 6.6.6.4, 203.0.113.9", "10.0.0.1")).status).toBe(429);
    expect((await forwardedPost(backend, "6.6.6.3, 203.0.113.10", "10.0.0.1")).status).toBe(202);
  });

  it("counts the number of proxy hops from the right", async () => {
    const backend = makeBackend({ config: makeConfig({ trustForwardedHeader: true, trustedProxyHops: 2, limits: { requestsPerCallerPerMinute: 1 } }) });
    expect((await forwardedPost(backend, "9.9.9.1, 203.0.113.9, 172.16.0.1", "10.0.0.1")).status).toBe(202);
    expect((await forwardedPost(backend, "9.9.9.2, 203.0.113.9, 172.16.0.2", "10.0.0.1")).status).toBe(429);
  });

  it("falls back to the socket address when the header has fewer entries than the hops, or is empty, or the header is not trusted", async () => {
    const hops = makeBackend({ config: makeConfig({ trustForwardedHeader: true, trustedProxyHops: 2, limits: { requestsPerCallerPerMinute: 1 } }) });
    expect((await forwardedPost(hops, "1.1.1.1", "10.0.0.1")).status).toBe(202);
    expect((await forwardedPost(hops, "2.2.2.2", "10.0.0.1")).status).toBe(429);
    expect((await forwardedPost(hops, " , ", "10.0.0.1")).status).toBe(429);
    const ignoring = makeBackend({ config: makeConfig({ limits: { requestsPerCallerPerMinute: 1 } }) });
    expect((await forwardedPost(ignoring, "1.1.1.1", "10.0.0.1")).status).toBe(202);
    expect((await forwardedPost(ignoring, "2.2.2.2", "10.0.0.1")).status).toBe(429);
  });

  it("keys an IPv6 caller by its /64 prefix", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { requestsPerCallerPerMinute: 1 } }) });
    expect((await post(backend, "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(202);
    expect((await post(backend, "2001:db8:1:2:1111:2222:3333:4444")).status).toBe(429);
    expect((await post(backend, "2001:db8:1:3::1")).status).toBe(202);
  });

  it("all callers without a socket address share one bucket with a low limit", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { requestsPerUnknownCallerPerMinute: 2 } }) });
    const { init } = postFrom("x");
    expect((await backend.app.request("/requests", init)).status).toBe(202);
    expect((await backend.app.request("/requests", init)).status).toBe(202);
    expect((await backend.app.request("/requests", init)).status).toBe(429);
    // A caller with an address is not in that bucket.
    expect((await post(backend, "10.0.0.1")).status).toBe(202);
  });

  it("a global cap limits new requests per minute across all callers", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { globalRequestsPerMinute: 3 } }) });
    for (const caller of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) expect((await post(backend, caller)).status).toBe(202);
    const refused = await post(backend, "10.0.0.4");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    backend.clock.advance(61_000);
    expect((await post(backend, "10.0.0.4")).status).toBe(202);
  });

  it("the global cap counts callers, not requests: a few busy callers do not lock a new caller out (K-2)", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { globalRequestsPerMinute: 3 } }) });
    for (const caller of ["10.0.0.1", "10.0.0.2"]) {
      for (let index = 0; index < 10; index += 1) expect((await post(backend, caller)).status).toBe(202);
    }
    expect((await post(backend, "10.0.0.3")).status).toBe(202);
    expect((await post(backend, "2001:db8:1:2::1")).status).toBe(429);
  });

  it("a caller already counted in the minute is not refused by a full global cap; a new one waits for the oldest caller to leave (K-2)", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { globalRequestsPerMinute: 2 } }) });
    expect((await post(backend, "10.0.0.1")).status).toBe(202);
    backend.clock.advance(10_000);
    expect((await post(backend, "10.0.0.2")).status).toBe(202);
    backend.clock.advance(10_000);
    // 10.0.0.1 asks again: it is one of the two callers of the minute, so the global cap does not refuse it.
    expect((await post(backend, "10.0.0.1")).status).toBe(202);
    const refused = await post(backend, "10.0.0.3");
    expect(refused.status).toBe(429);
    // 10.0.0.2 made its last request 10 seconds ago, 10.0.0.1 just now: 10.0.0.2 leaves the window first, in 50 seconds.
    expect(refused.headers.get("Retry-After")).toBe("50");
  });
});

describe("routes", () => {
  it("refuses a body that is not valid, or a pair this backend does not serve", async () => {
    const backend = makeBackend();
    const { env } = postFrom("a");
    expect((await backend.app.request("/requests", { method: "POST", body: "not json" }, env)).status).toBe(400);
    expect((await backend.app.request("/requests", { method: "POST", body: requestBodyWith({ direction: "sideways" }) }, env)).status).toBe(400);
    expect((await backend.app.request("/requests", { method: "POST", body: requestBodyWith({ messageId: "0x12" }) }, env)).status).toBe(400);
    const other = await backend.app.request("/requests", { method: "POST", body: requestBodyWith({ pair: "sepolia-pls943" }) }, env);
    expect(other.status).toBe(400);
    expect(countJobs(backend.storage)).toBe(0);
  });

  it("answers 413 for a body over 4 KiB, with and without a declared length", async () => {
    const backend = makeBackend();
    const { env } = postFrom("a");
    const big = JSON.stringify({ pair: "eth-pls", direction: "first-to-second", reason: "user", padding: "x".repeat(5000) });
    const declared = await backend.app.request("/requests", { method: "POST", headers: { "content-length": String(big.length) }, body: big }, env);
    expect(declared.status).toBe(413);
    const streamed = await backend.app.request(
      "/requests",
      { method: "POST", body: new ReadableStream({ start: (controller) => { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } }), duplex: "half" } as RequestInit,
      env,
    );
    expect(streamed.status).toBe(413);
    expect(countJobs(backend.storage)).toBe(0);
  });

  it("a request with the reason message needs a messageId", async () => {
    const backend = makeBackend();
    expect((await post(backend, "10.0.0.1", { reason: "message" })).status).toBe(400);
    expect((await post(backend, "10.0.0.1", { reason: "message", messageId: `0x${"ab".repeat(32)}` })).status).toBe(202);
  });

  it("stores the message identifier and the reason of a request", async () => {
    const backend = makeBackend();
    const messageId = `0x${"ab".repeat(32)}`;
    const { requestId } = (await (await post(backend, "10.0.0.1", { reason: "message", messageId })).json()) as { requestId: string };
    expect(await (await backend.app.request(`/requests/${requestId}`)).json()).toMatchObject({ requestId, reason: "message", messageId, status: "proving" });
  });

  it("answers 404 for an unknown request or direction, and null for a direction with no job", async () => {
    const backend = makeBackend();
    expect((await backend.app.request("/requests/nope")).status).toBe(404);
    expect((await backend.app.request("/directions/sideways")).status).toBe(404);
    expect(await (await backend.app.request("/directions/second-to-first")).json()).toEqual({ direction: "second-to-first", job: null });
  });

  it("shows the newest job of a direction when none is active", async () => {
    const backend = makeBackend();
    await post(backend, "10.0.0.1");
    backend.prover.failAll(new Error("x"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = (await (await backend.app.request("/directions/first-to-second")).json()) as { job: { status: string } };
    expect(answer.job.status).toBe("failed");
  });
});

describe("restart", () => {
  it("a restart keeps queued and proving jobs; a proving job older than the prover timeout becomes failed", async () => {
    const first = makeBackend();
    // Plant one proving job (old) and one queued job (new) in two directions, as a stopped process left them.
    const insert = first.storage.database.prepare("INSERT INTO jobs (id, direction, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    const now = first.clock.now();
    insert.run("old-proving", "first-to-second", "proving", now - 2_000_000, now - 2_000_000);
    insert.run("fresh-queued", "second-to-first", "queued", now - 1000, now - 1000);

    const second = makeBackend({ storage: first.storage, prover: controllableProver() });
    const stop = await (await import("../src/requests/module.ts")).start(second.context);
    const rows = first.storage.database.prepare("SELECT id, status FROM jobs ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: "fresh-queued", status: "proving" },
      { id: "old-proving", status: "failed" },
    ]);
    expect(second.prover.calls).toEqual([{ direction: "second-to-first" }]);
    second.prover.settleAll({ kind: "up-to-date" });
    await stop();
    const settled = first.storage.database.prepare("SELECT status FROM jobs WHERE id = 'fresh-queued'").get() as { status: string };
    expect(settled.status).toBe("on-chain");
  });

  it("a proving job past the prover limit is failed when a request arrives, and the retry wait counts from its deadline", async () => {
    const backend = makeBackend();
    const { jobId } = (await (await post(backend, "10.0.0.1")).json()) as { jobId: string };
    backend.clock.advance(1_801_000);
    expect((await post(backend, "10.0.0.2")).status).toBe(429);
    backend.clock.advance(60_000);
    const next = (await (await post(backend, "10.0.0.2")).json()) as { jobId: string };
    expect(next.jobId).not.toBe(jobId);
    const old = backend.storage.database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string };
    expect(old.status).toBe("failed");
  });
});

function requestBodyWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({ pair: "eth-pls", direction: "first-to-second", reason: "user", ...overrides });
}

describe("late finish, recovery and pruning", () => {
  it("a prove that finishes after the timeout cannot bring the failed job back or throw on the unique index", async () => {
    const backend = makeBackend();
    const { jobId } = (await (await post(backend, "10.0.0.1")).json()) as { jobId: string };
    backend.clock.advance(1_801_000);
    expect((await post(backend, "10.0.0.2")).status).toBe(429); // this request fails the lost job
    backend.clock.advance(60_000);
    const next = (await (await post(backend, "10.0.0.2")).json()) as { jobId: string };
    expect(next.jobId).not.toBe(jobId);
    // Both provers finish now: the old one late, the new one in time.
    backend.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(1, 2) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = backend.storage.database.prepare("SELECT id, status, new_slot FROM jobs ORDER BY created_at").all() as Array<{ id: string; status: string; new_slot: string | null }>;
    expect(rows[0]).toMatchObject({ id: jobId, status: "failed", new_slot: null });
    expect(rows[1]).toMatchObject({ id: next.jobId, status: "proving", new_slot: "2" });
  });

  it("a late failure or up-to-date answer does not overwrite a failed job", async () => {
    const backend = makeBackend();
    const { jobId } = (await (await post(backend, "10.0.0.1")).json()) as { jobId: string };
    backend.clock.advance(1_801_000);
    await post(backend, "10.0.0.2");
    backend.prover.settleAll({ kind: "up-to-date" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const row = backend.storage.database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string };
    expect(row.status).toBe("failed");
  });

  it("a restart does not run the prover again for a proving job whose proof already arrived", async () => {
    const first = makeBackend();
    const now = first.clock.now();
    const insert = first.storage.database.prepare("INSERT INTO jobs (id, direction, status, created_at, updated_at, start_slot, new_slot) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("with-proof", "first-to-second", "proving", now - 1000, now - 1000, "5", "9");
    insert.run("no-proof", "second-to-first", "proving", now - 1000, now - 1000, null, null);
    const second = makeBackend({ storage: first.storage, prover: controllableProver() });
    const stop = await (await import("../src/requests/module.ts")).start(second.context);
    expect(second.prover.calls).toEqual([{ direction: "second-to-first" }]);
    const row = first.storage.database.prepare("SELECT status, new_slot FROM jobs WHERE id = 'with-proof'").get() as { status: string; new_slot: string };
    expect(row).toEqual({ status: "proving", new_slot: "9" });
    second.prover.settleAll({ kind: "up-to-date" });
    await stop();
  });

  it("prunes request rows older than the retention window at start and on a timer, and keeps jobs", async () => {
    vi.useFakeTimers();
    try {
      const backend = makeBackend({ config: makeConfig({ limits: { requestRetentionHours: 1 } }) });
      const { requestId, jobId } = (await (await post(backend, "10.0.0.1")).json()) as { requestId: string; jobId: string };
      backend.prover.settleAll({ kind: "up-to-date" });
      await vi.advanceTimersByTimeAsync(0);
      backend.clock.advance(2 * 3_600_000);
      const stop = await (await import("../src/requests/module.ts")).start(backend.context);
      expect((await backend.app.request(`/requests/${requestId}`)).status).toBe(404);
      expect(backend.storage.database.prepare("SELECT count(*) AS total FROM jobs WHERE id = ?").get(jobId)).toEqual({ total: 1 });

      // A row that ages past the window later goes at the next tick.
      backend.clock.advance(121_000);
      const later = (await (await post(backend, "10.0.0.1")).json()) as { requestId: string };
      backend.clock.advance(2 * 3_600_000);
      await vi.advanceTimersByTimeAsync(3_600_000);
      // Its job is still proving, so the row stays.
      expect((await backend.app.request(`/requests/${later.requestId}`)).status).toBe(200);
      backend.prover.settleAll({ kind: "up-to-date" });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect((await backend.app.request(`/requests/${later.requestId}`)).status).toBe(404);
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claiming a job", () => {
  it("does not call the prover when the job is no longer queued", async () => {
    const storage = openStorage(":memory:");
    const clock = makeClock();
    const log = memoryLogger();
    const prover = controllableProver();
    let calls = 0;
    const service = createRequestService({
      storage,
      proverForJob: () => prover.binary,
      readProofNeed: fakeProofNeed().read,
      // The fourth reading of the clock is the claim. A competing writer fails the job just before it.
      now: () => {
        calls += 1;
        if (calls === 4) storage.database.exec("UPDATE jobs SET status = 'failed'");
        return clock.now();
      },
      limits: DEFAULT_RATE_LIMITS,
      proverTimeoutMilliseconds: 1_800_000,
      logger: log.logger,
    });
    const answer = await service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "a" });
    expect("jobId" in answer).toBe(true);
    await service.settled();
    expect(prover.calls).toEqual([]);
    expect(storage.database.prepare("SELECT status FROM jobs").get()).toEqual({ status: "failed" });
  });
});

describe("admitAfterSeconds", () => {
  const build = () => {
    const storage = openStorage(":memory:");
    const clock = makeClock();
    const prover = controllableProver();
    const limits = { ...DEFAULT_RATE_LIMITS, jobsPerDirectionPerDay: 2 };
    const service = createRequestService({ storage, proverForJob: () => prover.binary, readProofNeed: fakeProofNeed().read, now: clock.now, limits, proverTimeoutMilliseconds: 1_800_000, logger: memoryLogger().logger });
    const submit = () => service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "a" });
    return { service, clock, prover, submit };
  };

  it("is 0 with no job, the retry wait after a failed job, the spacing after another, and the budget wait once the day is spent", async () => {
    const { service, clock, prover, submit } = build();
    expect(service.admitAfterSeconds("first-to-second")).toBe(0);
    await submit();
    prover.failAll(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.admitAfterSeconds("first-to-second")).toBe(DEFAULT_RATE_LIMITS.secondsBeforeRetryAfterFailure);
    clock.advance(30_000);
    expect(service.admitAfterSeconds("first-to-second")).toBe(DEFAULT_RATE_LIMITS.secondsBeforeRetryAfterFailure - 30);
    clock.advance(30_000);
    expect(service.admitAfterSeconds("first-to-second")).toBe(0);
    await submit();
    prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Two costly jobs in the day: the third waits until the first is a day old.
    expect(service.admitAfterSeconds("first-to-second")).toBeGreaterThan(DEFAULT_RATE_LIMITS.secondsBetweenJobsPerDirection);
    expect(service.admitAfterSeconds("second-to-first")).toBe(0);
  });
});
