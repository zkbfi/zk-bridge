import { describe, expect, it } from "vitest";
import { CommandTimeoutError, ProverCommandError } from "@zk-bridge/shared/prover";
import { makeBackend, makeConfig, makeProofPackage, postFrom, controllableProver } from "./support.ts";

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

  it("takes the caller from the first X-Forwarded-For entry only when trusted", async () => {
    const trusting = makeBackend({ config: makeConfig({ trustForwardedHeader: true, limits: { requestsPerCallerPerMinute: 1 } }) });
    const send = (backend: typeof trusting, forwarded: string, socket: string) => {
      const { init } = postFrom(socket);
      return backend.app.request("/requests", { ...init, headers: { ...init.headers, "x-forwarded-for": forwarded } }, { incoming: { socket: { remoteAddress: socket } } });
    };
    expect((await send(trusting, "1.1.1.1, 9.9.9.9", "10.0.0.1")).status).toBe(202);
    expect((await send(trusting, "1.1.1.1", "10.0.0.2")).status).toBe(429);
    expect((await send(trusting, "2.2.2.2", "10.0.0.1")).status).toBe(202);

    const ignoring = makeBackend({ config: makeConfig({ limits: { requestsPerCallerPerMinute: 1 } }) });
    expect((await send(ignoring, "1.1.1.1", "10.0.0.1")).status).toBe(202);
    expect((await send(ignoring, "2.2.2.2", "10.0.0.1")).status).toBe(429);
  });

  it("counts a caller without a socket address as unknown", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { requestsPerCallerPerMinute: 1 } }) });
    const { init } = postFrom("x");
    expect((await backend.app.request("/requests", init)).status).toBe(202);
    expect((await backend.app.request("/requests", init)).status).toBe(429);
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
