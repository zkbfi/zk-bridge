import { describe, expect, it } from "vitest";
import { runpodCheck } from "../src/checks/prover.ts";
import { walletChecks } from "../src/checks/wallets.ts";
import type { ChainClient } from "../src/deps.ts";
import { addr, fakeFetch, makeDeps, type Reply } from "./support.ts";

const balance = (wei: bigint): ChainClient => ({ getBalance: async () => wei }) as unknown as ChainClient;
const ETH = 10n ** 18n;

describe("walletChecks", () => {
  it("makes a check for each wallet and each chain it has a minimum for", () => {
    const checks = walletChecks(makeDeps());
    expect(checks.map((check) => [check.id, check.name])).toEqual([
      ["wallet-runner-11155111", "Runner wallet on Sepolia"],
      ["wallet-runner-943", "Runner wallet on PulseChain testnet"],
    ]);
  });

  it("reports the balance and asks for the address of the wallet", async () => {
    let asked: unknown;
    const deps = makeDeps({ client: () => ({ getBalance: async (request: unknown) => ((asked = request), ETH / 2n) }) as unknown as ChainClient });
    const [sepolia] = walletChecks(deps);
    expect(await sepolia?.run(deps)).toEqual({ state: "ok", detail: "0.5 ETH" });
    expect(asked).toEqual({ address: addr("9") });
  });

  it("is degraded under the minimum and down when empty", async () => {
    const low = makeDeps({ client: () => balance(ETH / 100n) });
    expect(await walletChecks(low)[0]?.run(low)).toEqual({ state: "degraded", detail: "0.01 ETH, under the 0.05 ETH minimum" });
    const empty = makeDeps({ client: () => balance(0n) });
    expect(await walletChecks(empty)[0]?.run(empty)).toEqual({ state: "down", detail: "0 ETH, the wallet is empty" });
  });

  it("shows a long fraction in four digits", async () => {
    const deps = makeDeps({ client: () => balance(123_456_789_000_000_000n) });
    expect(await walletChecks(deps)[0]?.run(deps)).toEqual({ state: "ok", detail: "0.1234 ETH" });
  });
});

describe("runpodCheck", () => {
  const base = "https://api.runpod.io/v2/serverless";
  const check = runpodCheck;
  /** `GET /v2/serverless/{id}`, cut to what the check reads. */
  const endpoint = (id: string, extra: object = {}) => ({ id, name: "n", type: "LOAD_BALANCER", workers: { min: 0, max: 2, idleTimeout: 5 }, gpu: { pools: ["ADA_24", "AMPERE_24"], excludedTypes: [], minCudaVersion: "12.8", allowedCudaVersions: [] }, ...extra });
  /** `GET /v2/serverless/{id}/workers`: the statuses of the workers. */
  const workers = (...statuses: string[]) => ({ endpointVersion: 7, workers: statuses.map((status, index) => ({ id: `w${index}`, status, isStale: false, gpuCount: 1 })), summary: { total: statuses.length } });
  const ep2 = endpoint("ep2", { workers: { min: 1, max: 3, idleTimeout: 5 }, gpu: { pools: ["ADA_32_PRO"] } });
  /** Routes for two endpoints; the longer addresses come first because the fake matches by prefix. */
  const routes = (first: Reply | null, second: Reply | null, firstWorkers: Reply = { body: workers("RUNNING", "THROTTLED") }, secondWorkers: Reply = { body: workers() }) => ({
    [`${base}/ep1/workers`]: firstWorkers,
    [`${base}/ep2/workers`]: secondWorkers,
    [`${base}/ep1`]: first ?? { status: 404, body: { title: "Not Found", status: 404, detail: "no such endpoint" } },
    [`${base}/ep2`]: second ?? { status: 404, body: { title: "Not Found", status: 404, detail: "no such endpoint" } },
  });

  it("reads each endpoint and its workers from REST v2 with the key, and reports each one", async () => {
    const c = { now: 1 };
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = fakeFetch(
      Object.fromEntries(Object.entries(routes({ body: endpoint("ep1") }, { body: ep2 })).map(([url, reply]) => [url, (u: string, init?: RequestInit) => (seen.push({ url: u, init }), reply)])),
      c,
    );
    const deps = makeDeps({ clock: c, fetch });
    expect(await check.run(deps)).toEqual({
      state: "ok",
      detail: "gpu-24gb: 1 running now (min 0, max 2), GPUs ADA_24, AMPERE_24; gpu-32gb: 0 running now (min 1, max 3), GPUs ADA_32_PRO",
    });
    expect(seen.map((call) => call.url).sort()).toEqual([`${base}/ep1`, `${base}/ep1/workers`, `${base}/ep2`, `${base}/ep2/workers`]);
    for (const call of seen) {
      expect(call.init?.method ?? "GET").toBe("GET");
      expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer rp_key");
      expect(call.url).not.toContain("graphql");
    }
  });

  it("counts running, idle and starting workers, not throttled or unhealthy ones", async () => {
    const c = { now: 1 };
    const deps = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, { body: ep2 }, { body: workers("RUNNING", "IDLE", "INITIALIZING", "THROTTLED", "UNHEALTHY") }), c) });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: expect.stringContaining("gpu-24gb: 3 running now (min 0, max 2)") });
  });

  it("says how many workers of which tier still run an older configuration, and what the endpoint version is", async () => {
    const c = { now: 1 };
    const stale = (flags: boolean[], version: number | null = 7) => ({ endpointVersion: version, workers: flags.map((isStale, index) => ({ id: `w${index}`, status: "RUNNING", isStale, gpuCount: 1 })), summary: { total: flags.length } });
    const deps = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, { body: ep2 }, { body: stale([true, false]) }, { body: stale([false]) }), c) });
    const outcome = await check.run(deps);
    expect(outcome.state).toBe("ok");
    expect(outcome.detail).toBe(
      "gpu-24gb: 2 running now (min 0, max 2), GPUs ADA_24, AMPERE_24, 1 of 2 workers still runs an older configuration than endpoint version 7; gpu-32gb: 1 running now (min 1, max 3), GPUs ADA_32_PRO. " +
        "Endpoint version is RunPod's count of changes to an endpoint's settings, such as a new image.",
    );
    const both = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, { body: ep2 }, { body: stale([true]) }, { body: stale([true, true], null) }), c) });
    const text = (await check.run(both)).detail;
    expect(text).toContain("gpu-24gb: 1 running now (min 0, max 2), GPUs ADA_24, AMPERE_24, 1 of 1 workers still runs an older configuration than endpoint version 7;");
    expect(text).toContain("gpu-32gb: 2 running now (min 1, max 3), GPUs ADA_32_PRO, 2 of 2 workers still run an older configuration.");
  });

  it("says nothing about versions when no worker is stale", async () => {
    const c = { now: 1 };
    const deps = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, { body: ep2 }), c) });
    const outcome = await check.run(deps);
    expect(outcome.detail).not.toMatch(/older|version/);
  });

  it("handles missing workers, minimum and GPU list", async () => {
    const c = { now: 1 };
    const bare = { id: "ep1", workers: { max: 3 } };
    const empty = { id: "ep2", workers: { max: 1 }, gpu: { pools: [] } };
    const deps = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: bare }, { body: empty }, { body: {} }, { body: { workers: null } }), c) });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "gpu-24gb: 0 running now (min 0, max 3), no GPU list; gpu-32gb: 0 running now (min 0, max 1), no GPU list" });
  });

  it("is degraded when an endpoint cannot prove or is missing, naming it", async () => {
    const c = { now: 1 };
    const zero = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1", { workers: { min: 0, max: 0 } }) }, { body: ep2 }), c) });
    expect(await check.run(zero)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-24gb: the largest number of workers is 0, so it cannot prove (min 0, max 0); gpu-32gb: 0 running") });
    const unset = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, { body: { id: "ep2" } }), c) });
    expect(await check.run(unset)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-32gb: the largest number of workers is 0") });
    const missing = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, null), c) });
    expect(await check.run(missing)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-32gb: RunPod has no endpoint with this id (Not Found: no such endpoint)") });
    const odd = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: "text" }, { body: ep2 }), c) });
    expect(await check.run(odd)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-24gb: RunPod answered something that is not an endpoint") });
    const text = makeDeps({ clock: c, fetch: fakeFetch(routes({ text: "oops" }, { text: "oops" }), c) });
    expect((await check.run(text)).state).toBe("degraded");
  });

  it("says which part is unknown when only the worker list fails, and keeps the endpoint's own figures", async () => {
    const c = { now: 1 };
    const deps = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, { body: ep2 }, { status: 500, body: { title: "Internal Server Error" } }), c) });
    expect(await check.run(deps)).toEqual({
      state: "degraded",
      detail: "gpu-24gb: running workers unknown, RunPod answered 500 for the worker list: Internal Server Error (min 0, max 2), GPUs ADA_24, AMPERE_24; gpu-32gb: 0 running now (min 1, max 3), GPUs ADA_32_PRO",
    });
  });

  it("names a missing endpoint or an unreadable worker list by its status alone when RunPod gives no problem text", async () => {
    const c = { now: 1 };
    const gone = makeDeps({ clock: c, fetch: fakeFetch(routes({ status: 404, text: "" }, { body: ep2 }), c) });
    expect(await check.run(gone)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-24gb: RunPod has no endpoint with this id;") });
    const busy = makeDeps({ clock: c, fetch: fakeFetch(routes({ body: endpoint("ep1") }, { body: ep2 }, { status: 503, text: "<html>" }, { status: 500, body: { status: 500 } }), c) });
    const outcome = await check.run(busy);
    expect(outcome.detail).toContain("gpu-24gb: running workers unknown, RunPod answered 503 for the worker list (min 0, max 2)");
    expect(outcome.detail).toContain("gpu-32gb: running workers unknown, RunPod answered 500 for the worker list (min 1, max 3)");
  });

  it("is down on a refused key, an HTTP error, a network error, naming the problem RunPod gives", async () => {
    const c = { now: 1 };
    const run = (reply: Reply) => check.run(makeDeps({ clock: c, fetch: fakeFetch(routes(reply, reply), c) }));
    expect(await run({ status: 401 })).toEqual({ state: "down", detail: "RunPod refused the API key (401)" });
    expect(await run({ status: 403, body: { title: "Forbidden", detail: "scope" } })).toEqual({ state: "down", detail: "RunPod refused the API key (403): Forbidden: scope" });
    expect(await run({ status: 429 })).toEqual({ state: "down", detail: "RunPod answered 429" });
    expect(await run({ status: 429, body: { title: "Too Many Requests", detail: "daily limit" } })).toEqual({ state: "down", detail: "RunPod answered 429: Too Many Requests: daily limit" });
    expect(await run({ status: 500, text: "<html>" })).toEqual({ state: "down", detail: "RunPod answered 500" });
  });
});
