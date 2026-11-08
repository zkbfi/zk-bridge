import { describe, expect, it } from "vitest";
import { benchmarksCheck, indexerFeedCheck, pipelineCheck, gpuBillingCheck } from "../src/checks/pipeline.ts";
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

describe("gpuBillingCheck", () => {
  const url = `${backend}/billing?days=1`;
  const run = async (reply: { body?: object; status?: number; text?: string }) => {
    const c = { now: NOW };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [url]: reply }, c) });
    return gpuBillingCheck(backend).run(deps);
  };

  const amount = (usd: number) => ({ seconds: usd * 1000, usd });
  const buckets = (over: Record<string, number | null> = {}) => {
    const values = { proving: 0.71, idleAfterJob: 0.19, startingUp: 0.14, waitingForProof: 0.1, unusedEarlyStarts: 0.03, unaccounted: 0.03, ...over };
    return Object.fromEntries(Object.entries(values).map(([key, usd]) => [key, usd === null ? null : amount(usd)]));
  };
  const base = (extra: object = {}, billed = 1.2) => ({
    rateSource: "runpod",
    available: true,
    ageSeconds: 120,
    last24h: { billedUsd: billed, billedSeconds: 5400, breakdown: buckets() },
    account: { balanceUsd: 153.38, daysLeft: 93.4 },
    total: {},
    ...extra,
  });
  const account = (balanceUsd: number, daysLeft: number | null) => ({ account: { balanceUsd, daysLeft } });
  const last24h = (billedUsd: number | null, over: Record<string, number | null> = {}) => ({ last24h: { billedUsd, breakdown: buckets(over) } });

  it("is the GPU billing check of the pipeline section", () => {
    expect(gpuBillingCheck(backend)).toMatchObject({ id: "gpu-billing", name: "GPU billing", section: "pipeline" });
  });

  it("leads with the total, then the buckets largest first, then the balance", async () => {
    expect(await run({ body: base() })).toEqual({
      state: "ok",
      detail: "$1.20 in 24 h: proving $0.71, idle after jobs $0.19, starting up $0.14, waiting for a proof $0.10, unused early starts $0.03, unaccounted $0.03; balance $153, 93 days left.",
    });
  });

  it("orders by size, drops buckets that round to $0.00, and shows a negative unaccounted by its size", async () => {
    const result = await run({ body: base(last24h(1, { proving: 0.2, idleAfterJob: 0.004, startingUp: 0.5, waitingForProof: 0, unusedEarlyStarts: 0.1, unaccounted: -0.22 }) ) });
    expect(result.detail).toBe("$1.00 in 24 h: starting up $0.50, unaccounted -$0.22, proving $0.20, unused early starts $0.10; balance $153, 93 days left.");
    expect(result.state).toBe("ok");
    // Equal sizes keep the order of the list.
    expect((await run({ body: base(last24h(1, { proving: 0.1, idleAfterJob: 0.1, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, unaccounted: 0 })) })).detail).toContain("proving $0.10, idle after jobs $0.10;");
  });

  it("keeps the line within 200 characters: the smallest buckets go and +N more says how many", async () => {
    const result = await run({ body: base({ ...last24h(1.2), ...account(20, 11.76), ageSeconds: 7200 }) });
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(result.detail).toMatch(/^\$1\.20 in 24 h: proving \$0\.71, idle after jobs \$0\.19, [^;]*\+\d more; RunPod figures are 2 h old; balance \$20, 11 days left \(under 14\)\.$/);
    expect(result.state).toBe("degraded");
    // With room to spare nothing is hidden.
    expect((await run({ body: base() })).detail).not.toContain("more");
  });

  it("is degraded when the balance covers fewer than 14 days, and says the days left", async () => {
    const low = await run({ body: base(account(20, 11.76)) });
    expect(low.state).toBe("degraded");
    expect(low.detail).toContain("balance $20, 11 days left (under 14)");
    expect((await run({ body: base(account(23.8, 14)) })).state).toBe("ok");
    expect((await run({ body: base(account(23.7, 13.99)) })).state).toBe("degraded");
  });

  it("says when there is no spend to divide by, and when the figures are old", async () => {
    expect((await run({ body: base(account(153.38, null)) })).detail).toContain("balance $153, no spend in the last 7 days");
    expect((await run({ body: base({ ageSeconds: 2700 }) })).detail).toContain("+1 more; RunPod figures are 45 min old; balance");
    expect((await run({ body: base(account(4.5, 20)) })).detail).toContain("balance $4.50,");
  });

  it("is degraded when the unaccounted dollars pass 25% of the bill, and says the numbers", async () => {
    const mismatch = await run({ body: base(last24h(1, { proving: 0.5, idleAfterJob: 0.1, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, unaccounted: 0.4 })) });
    expect(mismatch.state).toBe("degraded");
    expect(mismatch.detail).toBe("$1.00 in 24 h: proving $0.50, unaccounted $0.40 (40% of the $1.00 billed, records do not match the bill), idle after jobs $0.10; balance $153, 93 days left.");
    // The records claim more than was billed: negative counts the same way.
    const over = await run({ body: base(last24h(1, { proving: 1.3, idleAfterJob: 0, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, unaccounted: -0.3 })) });
    expect(over.state).toBe("degraded");
    expect(over.detail).toContain("unaccounted -$0.30 (30% of the $1.00 billed, records do not match the bill)");
    // Exactly 25% is still ok; no bill, or no unaccounted figure, cannot be compared.
    expect((await run({ body: base(last24h(1, { unaccounted: 0.25 })) })).state).toBe("ok");
    expect((await run({ body: base(last24h(0, { unaccounted: 0.25 })) })).state).toBe("ok");
    expect((await run({ body: base(last24h(1, { unaccounted: null })) })).state).toBe("ok");
  });

  it("is degraded when the idle timeout RunPod reports differs from the backend's configuration, and says both numbers", async () => {
    const idle = (configured: number | null, endpoint: number | null) => base({ assumptions: { idleTimeoutSeconds: configured, endpointIdleTimeoutSeconds: endpoint } });
    const differs = await run({ body: idle(5, 60) });
    expect(differs.state).toBe("degraded");
    expect(differs.detail).toContain("RunPod idle timeout is 60 s, the backend config says 5 s; balance $153");
    expect(differs.detail.length).toBeLessThanOrEqual(200);
    // Equal, unknown (null: the backend could not read the endpoint) or missing: nothing to say.
    for (const body of [idle(5, 5), idle(5, null), idle(null, 60), base()]) {
      const same = await run({ body });
      expect(same.state).toBe("ok");
      expect(same.detail).not.toContain("idle timeout");
    }
  });

  it("keeps the flagged unaccounted bucket when the line is shortened", async () => {
    const result = await run({
      body: base({ ...last24h(1, { proving: 0.5, idleAfterJob: 0.1, startingUp: 0.05, waitingForProof: 0.05, unusedEarlyStarts: 0.04, unaccounted: 0.26 }), ...account(20, 11.76), ageSeconds: 7200 }),
    });
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(result.detail).toContain("unaccounted $0.26 (26% of the $1.00 billed, records do not match the bill)");
    expect(result.detail).toMatch(/\+\d more/);
  });

  it("leaves out the account when the request came through Caddy", async () => {
    expect((await run({ body: base({ account: { balanceUsd: null, daysLeft: null } }) })).detail).toBe(
      "$1.20 in 24 h: proving $0.71, idle after jobs $0.19, starting up $0.14, waiting for a proof $0.10, unused early starts $0.03, unaccounted $0.03.",
    );
  });

  it("says when RunPod's billing cannot be read, and gives what our records hold at the assumed price", async () => {
    const records = { rateSource: "assumed", available: false, assumptions: { gpuUsdPerHour: 2.25 }, last24h: { billedUsd: null, breakdown: buckets({ unaccounted: null }) }, total: {} };
    expect(await run({ body: records })).toEqual({
      state: "ok",
      detail: "RunPod billing is not available; our records for 24 h at the assumed $2.25/h: proving $0.71, idle after jobs $0.19, starting up $0.14, waiting for a proof $0.10, unused early starts $0.03.",
    });
    expect((await run({ body: { rateSource: "assumed", total: {} } })).detail).toBe("RunPod billing is not available; our records for 24 h.");
    // Billed but not available: not trusted either.
    expect((await run({ body: { ...records, available: true, last24h: { billedUsd: 1 } } })).detail).toBe("$1.00 in 24 h.");
    expect((await run({ body: { ...records, available: false, last24h: { billedUsd: 1, breakdown: buckets() } } })).state).toBe("ok");
  });

  it("says so when there is no record at all, and is down on a bad answer", async () => {
    expect((await run({ body: base({ last24h: { billedUsd: 0, breakdown: buckets({ proving: 0, idleAfterJob: 0, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, unaccounted: 0 }) }, ...account(153.38, 93) }) })).detail).toBe(
      "$0.00 in 24 h; balance $153, 93 days left.",
    );
    expect(await run({ status: 429 })).toEqual({ state: "down", detail: "answered 429 on /billing" });
    expect(await run({ text: "x" })).toEqual({ state: "down", detail: "answered something that is not the GPU billing" });
  });

  it("keeps the detail within the sanitizer: one line, no URL, at most 200 characters", async () => {
    const result = await run({ body: base({ ...account(20, 11.76), ageSeconds: 7200 }) });
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(result.detail).not.toMatch(/https?:|\n/);
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
