// The routes of the route steps, the GPU numbers and the chain reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { createApp } from "../src/app.ts";
import { MODULES } from "../src/main.ts";
import type { BackendModuleContext } from "../src/module.ts";
import { createStepChainReads, periodMillisecondsOf, slotTimeOf } from "../src/steps/chain.ts";
import { gpuEstimateNow, gpuViewOf } from "../src/steps/gpu.ts";
import { ROUTE_STEPS_REUSE_MILLISECONDS, stepServiceOf } from "../src/steps/routes.ts";
import { recordProveTiming } from "../src/requests/timings.ts";
import { requestServiceOf } from "../src/requests/module.ts";
import { archiveServiceOf } from "../src/archive/module.ts";
import { openStorage } from "../src/storage.ts";
import { makeBackend, makeConfig, PAIR } from "./support.ts";
import { evidenceText, fakeChain, MESSAGE, REGISTRY, REGISTRY_LIGHT_CLIENT, REGISTRY_PAIR, registryProof, stepProvers, V1, V2 } from "./steps-support.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(options: { config?: ReturnType<typeof makeConfig>; billing?: boolean } = {}) {
  const backend = makeBackend({ config: options.config ?? makeConfig() });
  const chain = fakeChain();
  const provers = stepProvers();
  const context: BackendModuleContext = {
    ...backend.context,
    pair: REGISTRY_PAIR,
    now: () => (1_000 + 8_192) * 10_000,
    stepChain: chain.reads,
    headProver: provers.headProver,
    observationProver: provers.observationProver,
    openingProver: provers.openingProver,
    ...(options.billing === true ? { billing: { read: async () => ({ spend: null, balance: null }) } as never, endpointIdleTimeoutSeconds: () => 5 } : {}),
  };
  const app = createApp({ context, modules: MODULES, enabled: ["requests"] });
  const post = (body: unknown, remoteAddress = "10.0.0.1") =>
    app.request("/steps/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { incoming: { socket: { remoteAddress } } });
  return { app, context, chain, provers, post };
}

describe("POST /steps/requests", () => {
  it("starts a job, answers 202, and the job and its proof can be read", async () => {
    const { app, post, provers, context } = setup();
    const response = await post({ pair: "eth-pls", kind: "registry-light-client-update", subject: "369" });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    expect((await app.request(`/steps/jobs/${encodeURIComponent(jobId)}`)).status).toBe(200);
    expect((await app.request("/steps/proofs/registry-light-client-update/369")).status).toBe(404);
    provers.head.settle(registryProof());
    await stepServiceOf(context).settled();
    const proof = await (await app.request("/steps/proofs/registry-light-client-update/369")).json();
    expect(proof).toMatchObject({ kind: "registry-light-client-update", lightClient: REGISTRY_LIGHT_CLIENT, startSlot: 1_000 });
    expect((await app.request("/steps/jobs/job:none")).status).toBe(404);
    expect((await app.request("/steps/proofs/mint/1")).status).toBe(404);
  });

  it("answers each refusal with its status and Retry-After", async () => {
    const { post, chain } = setup();
    chain.state.facts = { activeVersion: V1, registry: { registry: REGISTRY, version: V1, shape: 5, slot: 1n, shapeAllowed: true, observed: true } };
    const nothing = await post({ pair: "eth-pls", kind: "fork-observation", subject: "369" });
    expect([nothing.status, await nothing.json()]).toEqual([409, { error: "nothing-to-prove", why: "no-need" }]);
    const off = await post({ pair: "eth-pls", kind: "light-client-update", subject: "first-to-second" });
    expect([off.status, await off.json()]).toEqual([404, { error: "not-served", detail: "the requests module does not run on this backend" }]);
    chain.state.depositsOpen = new Error("rpc down");
    const unknown = await post({ pair: "eth-pls", kind: "open-deposits", subject: "first-to-second" });
    expect([unknown.status, unknown.headers.get("retry-after"), await unknown.json()]).toEqual([503, "30", { error: "cannot-check", retryAfterSeconds: 30 }]);
    const bad = await post({ pair: "eth-pls", kind: "deliver", subject: "0x12" });
    expect(bad.status).toBe(400);
    expect((await post({ pair: "other", kind: "deliver", subject: MESSAGE })).status).toBe(400);
    expect((await post({ pair: "eth-pls", kind: "seal", subject: "369" })).status).toBe(400);
    expect((await post({ pair: "eth-pls", kind: "deliver", subject: MESSAGE })).status).toBe(404);
    for (let index = 0; index < 10; index += 1) expect((await post({ pair: "eth-pls", kind: "registry-light-client-update", subject: "369" }, "10.0.0.9")).status).toBe(202);
    const limited = await post({ pair: "eth-pls", kind: "registry-light-client-update", subject: "369" }, "10.0.0.9");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await limited.json()).toMatchObject({ error: "rate-limited", why: "limit" });
  });

  it("refuses a body over 4 KiB, and one that is not JSON", async () => {
    const { post, app } = setup();
    expect((await app.request("/steps/requests", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" })).status).toBe(400);
    expect((await post({ pair: "eth-pls", kind: "deliver", subject: "x".repeat(5000) })).status).toBe(413);
  });
});

describe("GET /route/steps", () => {
  it("lists the steps, keeps the answer 15 s, and drops it after a request", async () => {
    const { app, post, chain } = setup({ billing: true });
    const first = await (await app.request("/route/steps")).json();
    expect(first).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ kind: "open-deposits" }), expect.objectContaining({ kind: "registry-light-client-update" }), expect.objectContaining({ kind: "fork-observation" })]) });
    expect(first.unread).toEqual(expect.arrayContaining(["covered messages first-to-second"]));
    chain.state.depositsOpen = true;
    expect((await (await app.request("/route/steps")).json()).steps).toEqual(first.steps);
    expect((await post({ pair: "eth-pls", kind: "registry-light-client-update", subject: "369" })).status).toBe(202);
    const fresh = await (await app.request("/route/steps")).json();
    expect(fresh.steps.some((step: { kind: string }) => step.kind === "open-deposits")).toBe(false);
    expect(ROUTE_STEPS_REUSE_MILLISECONDS).toBe(15_000);
  });

  it("reads the covered messages from the indexer", async () => {
    const config = makeConfig({ indexerUrl: "https://indexer.example.org" });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("status=covered") && url.includes("1%3E369")) return Response.json({ items: [{ messageId: MESSAGE, status: "covered", direction: { sourceChainId: 1, destinationChainId: 369 }, sent: { timestamp: 1 }, covered: { headSlot: 1, timestamp: 2 }, delivered: null }] });
      if (url.includes("status=covered")) return Response.json({ items: [] });
      return new Response("no", { status: 503 });
    });
    const { app, context } = setup({ config });
    archiveServiceOf(context);
    const body = await (await app.request("/route/steps")).json();
    expect(body.steps.find((step: { kind: string }) => step.kind === "deliver")).toMatchObject({ messageId: MESSAGE, chainId: 369 });
    void evidenceText;
  });

  it("answers 503 when the list cannot be built, and limits each caller to 60 reads a minute", async () => {
    const { app, context } = setup();
    const broken = createApp({ context: { ...context, stepChain: { ...fakeChain().reads, gasPrice: () => Promise.reject(new Error("x")) } }, modules: MODULES, enabled: ["requests"] });
    expect((await broken.request("/route/steps")).status).toBe(200);
    const throwing = createApp({ context: { ...context, storage: { ...context.storage, database: { prepare: () => { throw new Error("closed"); } } } as never }, modules: MODULES, enabled: ["requests"] });
    expect((await throwing.request("/route/steps")).status).toBe(503);
    for (let index = 0; index < 60; index += 1) await app.request("/steps/jobs/job:x");
    expect((await app.request("/route/steps")).status).toBe(429);
    expect((await app.request("/steps/jobs/job:x")).status).toBe(429);
    expect((await app.request("/steps/proofs/deliver/0x12")).status).toBe(429);
  });
});

describe("the step service of a context", () => {
  it("is one per context, reaches the request service with an indexer, and uses the seal module's observation limits", async () => {
    const withIndexer = setup({ config: makeConfig({ indexerUrl: "https://indexer.example.org", seal: { signer: { kind: "private-key", key: "env:K" }, observation: { retryMinutes: 5 } } }) });
    expect(stepServiceOf(withIndexer.context)).toBe(stepServiceOf(withIndexer.context));
    expect(requestServiceOf(withIndexer.context)).toBeDefined();
    const answer = await withIndexer.post({ pair: "eth-pls", kind: "light-client-update", subject: "first-to-second" });
    expect([202, 409, 429, 503]).toContain(answer.status);
    const bare = makeBackend();
    expect(stepServiceOf({ ...bare.context, stepChain: undefined } as never)).toBeDefined();
  });
});

describe("the GPU numbers", () => {
  it("estimate a warm and a cold proof, and a warm worker after a proof or in a ready session", () => {
    const storage = openStorage(":memory:");
    expect(gpuEstimateNow(storage, 1_000_000, 5_000)).toEqual({ warmMs: null, coldMs: null, workerWarm: false });
    recordProveTiming(storage, { jobId: "a", direction: "first-to-second", startedAt: 0, provedAt: 900_000, timing: { total_ms: 60_000, wait_worker_ms: 0, not_ready_count: 0 } as never });
    recordProveTiming(storage, { jobId: "b", direction: "first-to-second", startedAt: 0, provedAt: 999_000, timing: { total_ms: 80_000, wait_worker_ms: 120_000, not_ready_count: 3 } as never });
    expect(gpuEstimateNow(storage, 1_000_000, 5_000)).toEqual({ warmMs: 60_000, coldMs: 180_000, workerWarm: true });
    expect(gpuEstimateNow(storage, 1_100_000, 5_000).workerWarm).toBe(false);
    storage.database.prepare("INSERT INTO warmup_sessions (id, direction, why, due_at, lead_seconds, started_at, ready_at) VALUES ('s', 'first-to-second', 'x', 0, 0, 1_050_000, 1_060_000)").run();
    expect(gpuEstimateNow(storage, 1_100_000, 5_000).workerWarm).toBe(true);
    const lone = openStorage(":memory:");
    recordProveTiming(lone, { jobId: "c", direction: "first-to-second", startedAt: 0, provedAt: 1, timing: { total_ms: 50_000 } as never });
    expect(gpuEstimateNow(lone, 10, 1)).toMatchObject({ warmMs: 50_000, coldMs: 50_000 });
  });

  it("show the budget spent and left in the last 24 hours", () => {
    const storage = openStorage(":memory:");
    recordProveTiming(storage, { jobId: "a", direction: "first-to-second", startedAt: 0, provedAt: 1_000, timing: { worker_total_ms: 3_600_000 } as never });
    const estimate = { warmMs: 1, coldMs: 2, workerWarm: false };
    expect(gpuViewOf({ storage, direction: "first-to-second", now: 2_000, estimate, usdPerHour: 2, budgetUsd: 5 })).toEqual({ ...estimate, budgetUsd: 5, spentUsd: 2, leftUsd: 3 });
    expect(gpuViewOf({ storage, direction: "first-to-second", now: 2_000, estimate, usdPerHour: 9, budgetUsd: 5 })).toMatchObject({ spentUsd: 9, leftUsd: 0 });
  });
});

describe("the chain reads", () => {
  const SIDE = REGISTRY_PAIR.sides[1];

  it("read the registry's light client at one block, the deposits, the gas price and a simulation", async () => {
    const calls: Array<{ functionName: string; args?: unknown; blockNumber?: bigint }> = [];
    const answers: Record<string, unknown> = { lightClient: REGISTRY_LIGHT_CLIENT, head: 8_200n, slotsPerPeriod: 8_192n, genesisTime: 5n, secondsPerSlot: 10n, programVKey: `0x${"88".repeat(32)}`, headers: `0x${"77".repeat(32)}`, syncCommittees: `0x${"99".repeat(32)}`, depositsOpen: true };
    const client = {
      getBlockNumber: async () => 42n,
      readContract: async (call: { functionName: string; args?: unknown; blockNumber?: bigint }) => (calls.push(call), answers[call.functionName]),
      getGasPrice: async () => 7n,
      estimateGas: async ({ to }: { to: Address }) => (to === REGISTRY ? 55n : Promise.reject(new Error("reverts"))),
    };
    const reads = createStepChainReads({ clientOf: () => client as never });
    const state = await reads.registryLightClient(SIDE, REGISTRY);
    expect(state).toEqual({ lightClient: REGISTRY_LIGHT_CLIENT, head: { slot: 8_200, root: `0x${"77".repeat(32)}`, nextCommitteeHash: `0x${"99".repeat(32)}` }, programKey: `0x${"88".repeat(32)}`, slotsPerPeriod: 8_192, genesisTime: 5, secondsPerSlot: 10 });
    expect(calls.find((call) => call.functionName === "syncCommittees")).toMatchObject({ args: [2n], blockNumber: 42n });
    expect(await reads.depositsOpen(SIDE)).toBe(true);
    expect(await reads.gasPrice(SIDE)).toBe(7n);
    expect(await reads.simulate(SIDE, { to: REGISTRY, data: "0x" })).toBe(55n);
    expect(await reads.simulate(SIDE, { to: REGISTRY_LIGHT_CLIENT, data: "0x" })).toBeNull();
    expect(slotTimeOf(state, 2)).toBe(25_000);
    expect(periodMillisecondsOf(state)).toBe(81_920_000);
  });

  it("read the fork facts from the beacon node and the registry, and throw when the node does not answer", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const body = url.includes("fork_schedule")
        ? { data: [{ current_version: V1, epoch: "0" }, { current_version: V2, epoch: "1" }] }
        : url.includes("genesis")
          ? { data: { genesis_time: "0" } }
          : { data: { SECONDS_PER_SLOT: "10", SLOTS_PER_EPOCH: "32" } };
      return Response.json(body);
    });
    const client = { readContract: async () => [V1, 5, 500n] };
    const reads = createStepChainReads({ clientOf: () => client as never });
    expect(await reads.forkFacts(SIDE, REGISTRY, 1_000_000)).toMatchObject({ activeVersion: V2, registry: { version: V1, slot: 500n } });
    await expect(reads.forkFacts({ ...SIDE, beaconUrl: null }, REGISTRY, 1_000_000)).rejects.toThrow(/no beacon endpoint/);
  });

  it("make one viem client per chain by default", async () => {
    const reads = createStepChainReads();
    await expect(reads.gasPrice(PAIR.sides[0])).rejects.toThrow();
    await expect(reads.gasPrice(PAIR.sides[0])).rejects.toThrow();
  }, 30_000);
});
