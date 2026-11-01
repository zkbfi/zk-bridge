import { describe, expect, it } from "vitest";
import { benchmarksCheck, indexerFeedCheck, pipelineCheck } from "../src/checks/pipeline.ts";
import { fakeFetch, makeDeps } from "./support.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const backend = "http://127.0.0.1:8787";
const indexer = "http://127.0.0.1:42069";

describe("benchmarksCheck", () => {
  const check = (deps = makeDeps()) => benchmarksCheck(deps, backend);
  const stat = (medianMs: number | null, count = 3) => ({ count, medianMs, p90Ms: medianMs });
  const body = (extra: object = {}) => ({
    indexer: "ok",
    steps: { total: stat(240_000, 5) },
    byDirection: { "first-to-second": { total: stat(180_000, 3) }, "second-to-first": { total: stat(null, 0) } },
    recent: [
      { direction: "second-to-first", provedAt: NOW - 5 * HOUR, totalMs: 1 },
      { direction: "first-to-second", provedAt: NOW - 2 * HOUR, totalMs: 200_000 },
      { direction: "first-to-second", provedAt: NOW - 9 * HOUR, totalMs: 1 },
    ],
    ...extra,
  });

  it("gives the last proof of each direction and the median time", async () => {
    const c = { now: NOW };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [`${backend}/benchmarks?window=24h`]: { body: body() } }, c) });
    const outcome = await check(deps).run(deps);
    expect(outcome).toEqual({
      state: "ok",
      detail: "Sepolia to PulseChain testnet: last proof 2 h ago, median 3 min over 3 proofs in 24 h; PulseChain testnet to Sepolia: last proof 5 h ago, no proof time in 24 h",
    });
  });

  it("says when a direction has no proof in the window", async () => {
    const c = { now: NOW };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [`${backend}/benchmarks?window=24h`]: { body: body({ recent: [], byDirection: {} }) } }, c) });
    expect((await check(deps).run(deps)).detail).toContain("Sepolia to PulseChain testnet: no proof in 24 h");
  });

  it("says so when proofs were made but the list of recent ones does not show them", async () => {
    const c = { now: NOW };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [`${backend}/benchmarks?window=24h`]: { body: body({ recent: [{ direction: "first-to-second" }, null] }) } }, c) });
    expect((await check(deps).run(deps)).detail).toContain("Sepolia to PulseChain testnet: last proof not in the list, median 3 min over 3 proofs in 24 h");
  });

  it("is degraded when the backend cannot read the indexer, down on a bad answer", async () => {
    const c = { now: NOW };
    const lame = makeDeps({ clock: c, fetch: fakeFetch({ [`${backend}/benchmarks?window=24h`]: { body: body({ indexer: "unavailable" }) } }, c) });
    expect(await check(lame).run(lame)).toMatchObject({ state: "degraded", detail: expect.stringContaining("the backend cannot reach the indexer") });
    const bad = makeDeps({ clock: c, fetch: fakeFetch({ [`${backend}/benchmarks?window=24h`]: { status: 429 } }, c) });
    expect(await check(bad).run(bad)).toEqual({ state: "down", detail: "answered 429 on /benchmarks" });
    const odd = makeDeps({ clock: c, fetch: fakeFetch({ [`${backend}/benchmarks?window=24h`]: { text: "x" } }, c) });
    expect(await check(odd).run(odd)).toEqual({ state: "down", detail: "answered something that is not the benchmarks" });
    const sparse = makeDeps({ clock: c, fetch: fakeFetch({ [`${backend}/benchmarks?window=24h`]: { body: { steps: {} } } }, c) });
    expect((await check(sparse).run(sparse)).detail).toContain("no proof in 24 h");
  });
});

describe("pipelineCheck", () => {
  const url = `${backend}/directions/first-to-second/pipeline`;
  const run = async (body: object | null, status = 200) => {
    const c = { now: NOW };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [url]: body === null ? { status } : { status, body } }, c) });
    return pipelineCheck(deps, backend, "first-to-second").run(deps);
  };
  const base = { now: NOW, batch: null, job: null, latestJob: null, latestProof: null, head: null, decision: null };

  it("is named by direction", () => {
    const check = pipelineCheck(makeDeps(), backend, "second-to-first");
    expect(check.id).toBe("pipeline-second-to-first");
    expect(check.name).toBe("Proofs from PulseChain testnet to Sepolia");
  });

  it("says it is idle, with the waiting batch and the last proof", async () => {
    expect(await run({ ...base, latestProof: { since: NOW - 3 * HOUR }, batch: { count: 4 } })).toEqual({
      state: "ok",
      detail: "idle, 4 transfers wait for a batch, newest proof held 3 h ago",
    });
    expect(await run({ ...base, batch: { count: 1 } })).toEqual({ state: "ok", detail: "idle, 1 transfer waits for a batch, no proof held" });
    expect(await run(base)).toEqual({ state: "ok", detail: "idle, nothing waits for a batch, no proof held" });
  });

  it("reports a running job and is degraded when it runs too long", async () => {
    const job = { jobId: "j1", status: "proving", step: "remote", startedAt: NOW - 5 * 60_000, elapsedMs: 5 * 60_000, detail: "x" };
    expect(await run({ ...base, job })).toEqual({ state: "ok", detail: "a proof job is running, 5 min so far" });
    expect(await run({ ...base, job: { ...job, elapsedMs: 2 * HOUR } })).toEqual({ state: "degraded", detail: "a proof job has run for 2 h, it should take under 1 h" });
  });

  it("is degraded when the newest job failed, and shows no URL of its error", async () => {
    const outcome = await run({ ...base, latestJob: { jobId: "j", status: "failed", createdAt: 1, updatedAt: NOW - HOUR, error: "fetch https://x.example/key failed" } });
    expect(outcome).toEqual({ state: "degraded", detail: "the newest proof job failed 1 h ago: fetch https://x.example/key failed" });
    expect((await run({ ...base, latestJob: { status: "failed", updatedAt: NOW, error: null } })).detail).toBe("the newest proof job failed 0 s ago: no reason recorded");
    expect((await run({ ...base, latestJob: { status: "done", updatedAt: NOW, error: null } })).state).toBe("ok");
  });

  it("copes with a failed job and a running job that lack their times", async () => {
    expect(await run({ ...base, latestJob: { status: "failed", error: "x" } })).toEqual({ state: "degraded", detail: "the newest proof job failed 0 s ago: x" });
    expect(await run({ ...base, job: { status: "proving" } })).toEqual({ state: "ok", detail: "a proof job is running, 0 s so far" });
  });

  it("is down when the backend does not answer well", async () => {
    expect(await run(null, 404)).toEqual({ state: "down", detail: "answered 404 on /directions/first-to-second/pipeline" });
    expect(await run(null, 200)).toEqual({ state: "down", detail: "answered something that is not a pipeline report" });
  });
});

describe("indexerFeedCheck", () => {
  const feed = (status: string, direction?: string) => `${indexer}/api/feed?${direction === undefined ? "" : `direction=${encodeURIComponent(direction)}&`}status=${encodeURIComponent(status)}&limit=`;
  const item = (sent: number, delivered?: number) => ({ sent: { timestamp: sent }, delivered: delivered === undefined ? null : { timestamp: delivered } });
  const routes = (overrides: Record<string, unknown> = {}) => ({
    [`${indexer}/api/summary`]: { body: { volume24h: [{ transfers: 3 }, { transfers: 4 }], inFlight: { total: 2 } } },
    [feed("delivered", "11155111>943")]: { body: { items: [item(0, NOW / 1000 - 7200)], nextCursor: null } },
    [feed("delivered", "943>11155111")]: { body: { items: [], nextCursor: null } },
    [feed("sent,waiting_for_finality,covered")]: { body: { items: [item(NOW / 1000 - 600), item(NOW / 1000 - 1800)], nextCursor: null } },
    ...overrides,
  });
  const run = async (replies: Record<string, unknown>) => {
    const c = { now: NOW };
    const deps = makeDeps({ clock: c, fetch: fakeFetch(replies as never, c) });
    return indexerFeedCheck(deps, indexer).run(deps);
  };

  it("reports the last delivery of each direction, the day's transfers and the oldest wait", async () => {
    expect(await run(routes())).toEqual({
      state: "ok",
      detail: "Sepolia to PulseChain testnet: last delivery 2 h ago; PulseChain testnet to Sepolia: no delivery yet; 7 transfers in the last 24 h; oldest undelivered transfer waits 30 min",
    });
  });

  it("says when nothing waits", async () => {
    const outcome = await run(routes({ [feed("sent,waiting_for_finality,covered")]: { body: { items: [], nextCursor: null } } }));
    expect(outcome.detail).toContain("no undelivered transfer");
  });

  it("is degraded when a transfer waits too long and down when it waits much longer", async () => {
    const wait = (seconds: number) => routes({ [feed("sent,waiting_for_finality,covered")]: { body: { items: [item(NOW / 1000 - seconds)], nextCursor: null } } });
    expect(await run(wait(3 * 3600))).toMatchObject({ state: "degraded", detail: expect.stringContaining("waits 3 h, delivery should happen within 2 h") });
    expect(await run(wait(8 * 3600))).toMatchObject({ state: "down" });
  });

  it("follows the pages of the work list to its oldest entry", async () => {
    const first = { items: [item(NOW / 1000 - 60)], nextCursor: "1:0x01" };
    const second = { items: [item(NOW / 1000 - 4000)], nextCursor: null };
    const outcome = await run(
      routes({ [feed("sent,waiting_for_finality,covered")]: (url: string) => ({ body: url.includes("cursor=") ? second : first }) }),
    );
    expect(outcome.detail).toContain("waits 1.1 h");
  });

  it("gives up on the pages after five and says the wait is at least that long", async () => {
    const outcome = await run(routes({ [feed("sent,waiting_for_finality,covered")]: { body: { items: [item(NOW / 1000 - 600)], nextCursor: "1:0x01" } } }));
    expect(outcome.detail).toContain("waits at least 10 min");
  });

  it("copes with a summary without volume, entries without a time and items without a send time", async () => {
    const odd = await run(
      routes({
        [`${indexer}/api/summary`]: { body: { volume24h: [{}, 5] } },
        [feed("sent,waiting_for_finality,covered")]: { body: { items: ["odd", { sent: {} }], nextCursor: null } },
      }),
    );
    expect(odd.detail).toContain("0 transfers in the last 24 h; no undelivered transfer");
    const none = await run(routes({ [`${indexer}/api/summary`]: { body: {} } }));
    expect(none.detail).toContain("0 transfers in the last 24 h");
  });

  it("lets a request that fails outright reach the runner", async () => {
    await expect(run(routes({ [`${indexer}/api/summary`]: { throws: "connect ECONNREFUSED" } }))).rejects.toThrow(/ECONNREFUSED/);
  });

  it("is down when the indexer does not answer well", async () => {
    expect(await run(routes({ [`${indexer}/api/summary`]: { status: 500 } }))).toEqual({ state: "down", detail: "answered 500 on /api/summary" });
    expect(await run(routes({ [`${indexer}/api/summary`]: { text: "x" } }))).toMatchObject({ state: "down", detail: "answered something that is not the summary" });
    expect(await run(routes({ [feed("delivered", "943>11155111")]: { status: 400 } }))).toEqual({ state: "down", detail: "answered 400 on /api/feed" });
    expect(await run(routes({ [feed("delivered", "943>11155111")]: { text: "x" } }))).toEqual({ state: "down", detail: "answered something that is not a feed" });
  });
});
