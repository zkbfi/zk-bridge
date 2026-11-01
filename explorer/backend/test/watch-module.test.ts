import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PULSEX_FACTORIES, STABLES } from "@zk-bridge/shared";
import { BackendConfigError, parseBackendConfig } from "../src/config.ts";
import type { LightClientFacts } from "../src/keepalive/plan.ts";
import { findActiveJob, getRequest, insertJob, lastProofStartedAt } from "../src/requests/jobs.ts";
import { start as startRequests } from "../src/requests/module.ts";
import { createRequestService } from "../src/requests/service.ts";
import { DEFAULT_WARMUP } from "../src/watch/warmup.ts";
import { createWarmupStore } from "../src/watch/warmup-store.ts";
import { MESSAGE_LIMIT, startWatch, watchedDirections } from "../src/watch/module.ts";
import { createProverPing } from "../src/watch/ping.ts";
import { PAIR, SECRETS, fakeProofNeed, makeBackend, makeConfig } from "./support.ts";
import { fakeBeacon, finalityUpdate, flush } from "./watch-support.ts";

const GENESIS = 1_606_824_023;
const SLOT = 12;
const PERIOD = 8192;
const HEAD = 1500 * PERIOD + 320;
const slotStart = (slot: number) => (GENESIS + slot * SLOT) * 1000;
const FINALITY = "/eth/v1/beacon/light_client/finality_update";
const FEED = `/api/feed?${new URLSearchParams({ direction: "1>369", status: "sent,waiting_for_finality", limit: String(MESSAGE_LIMIT) })}`;
const lightClient: LightClientFacts = { headSlot: HEAD, slotsPerPeriod: PERIOD, genesisTime: GENESIS, secondsPerSlot: SLOT, nextCommitteeKnown: true };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(slotStart(HEAD + 200));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watchedDirections", () => {
  const config = (watch: Record<string, unknown>, extra: Record<string, unknown> = {}) => makeConfig({ indexerUrl: "http://indexer.test", watch, ...extra });

  it("is on by default when the indexer and the source beacon endpoints are set", () => {
    expect(watchedDirections(config({}), PAIR)).toEqual(["first-to-second", "second-to-first"]);
    expect(watchedDirections(config({ directions: ["second-to-first"] }), PAIR)).toEqual(["second-to-first"]);
    expect(watchedDirections(config({}, { indexerUrl: undefined }), PAIR)).toEqual([]);
    const lonely = { ...PAIR, sides: [PAIR.sides[0], { ...PAIR.sides[1], beaconUrl: null }] as const };
    expect(watchedDirections(config({}), lonely)).toEqual([]);
    expect(watchedDirections(config({ directions: ["first-to-second"] }), lonely)).toEqual(["first-to-second"]);
  });

  it("is off when switched off, and a switched-on watch that cannot run is a configuration error", () => {
    expect(watchedDirections(config({ enabled: false }), PAIR)).toEqual([]);
    const lonely = { ...PAIR, sides: [PAIR.sides[0], { ...PAIR.sides[1], beaconUrl: null }] as const };
    expect(() => watchedDirections(config({ enabled: true }, { indexerUrl: undefined }), lonely)).toThrow(new BackendConfigError("watch.enabled needs indexerUrl and beaconUrls.369"));
  });

  it("parses the defaults of the watch section", () => {
    const parsed = parseBackendConfig(
      JSON.stringify({ schemaVersion: 1, deploymentFile: "d", databasePath: "x", publicUrl: "https://b.example.org", prover: { binary: "p" }, remote: { endpoint: "https://e.example.org" }, runpodApiKeyVariable: "K", webhookBearerVariable: "B" }),
    );
    expect(parsed.watch).toEqual({ sse: true, scanSeconds: 15, pairs: {}, warmup: { enabled: true, ...DEFAULT_WARMUP } });
    expect(() => makeConfig({ watch: { unknown: 1 } })).toThrow(BackendConfigError);
  });

  it("checks the warm-up settings", () => {
    expect(makeConfig({ watch: { warmup: { leadP: 0.5, dailyCapSeconds: 7200 } } }).watch.warmup).toMatchObject({ leadP: 0.5, dailyCapSeconds: 7200, holdIntervalSeconds: 40 });
    expect(() => makeConfig({ watch: { warmup: { leadP: 0 } } })).toThrow(BackendConfigError);
    expect(() => makeConfig({ watch: { warmup: { leadP: 1.5 } } })).toThrow(BackendConfigError);
    expect(() => makeConfig({ watch: { warmup: { minLeadSeconds: 700 } } })).toThrow(/minLeadSeconds must not be above maxLeadSeconds/);
    // The fixed lead time of before 2026-11-01 still loads, and does nothing.
    expect(makeConfig({ watch: { warmup: { leadSeconds: 45 } } }).watch.warmup.leadSeconds).toBe(45);
  });
});

describe("startWatch", () => {
  function setup(options: { warmup?: boolean; leadSeconds?: number } = {}) {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(HEAD, 500));
    beacon.set(FEED, { items: [] });
    const pings: number[] = [];
    const proofNeed = fakeProofNeed({ needed: true, why: "waiting-message" });
    const backend = makeBackend({
      config: makeConfig({ indexerUrl: "http://indexer.test", watch: { directions: ["first-to-second"], warmup: { enabled: options.warmup ?? true, ...(options.leadSeconds === undefined ? {} : { leadSeconds: options.leadSeconds }) } } }),
      proofNeed,
    });
    const context = {
      ...backend.context,
      now: Date.now,
      pingProver: async () => {
        pings.push(Date.now());
        return 200;
      },
    };
    const service = createRequestService({
      storage: context.storage,
      proverForJob: context.proverForJob,
      readProofNeed: context.readProofNeed,
      now: context.now,
      limits: context.config.limits,
      proverTimeoutMilliseconds: 1_800_000,
      logger: context.logger,
    });
    const events = () => backend.log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { beacon, backend, context, service, pings, proofNeed, named: (name: string) => events().filter((event) => event.event === name) };
  }

  it("a finality event over the stream starts the proving job within the same turn, with the latency logged", async () => {
    const run = setup();
    const stop = await startWatch({ context: run.context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient } });
    await flush();
    expect(run.named("watch_started")).toMatchObject([{ directions: ["first-to-second"], sse: true, warmup: true, lead: { seconds: 90, basis: "default" } }]);
    expect(run.named("config_ignored")).toEqual([]);
    expect(run.named("warmup_sessions_closed")).toEqual([]);
    expect(findActiveJob(run.context.storage, "first-to-second")).toBeNull();

    // A message in the epoch of HEAD + 100, then the finality that covers it, signed by 500 of 512.
    const sent = HEAD + 100;
    run.beacon.set(FEED, { items: [{ messageId: `0x${"ab".repeat(32)}`, sent: { timestamp: GENESIS + sent * SLOT, blockNumber: 1 } }, { messageId: `0x${"cd".repeat(32)}`, sent: null }] });
    const finalized = (Math.floor(sent / 32) + 1) * 32;
    const arrival = slotStart(finalized + 65) + 800;
    vi.setSystemTime(arrival);
    run.beacon.latest().send("light_client_finality_update", finalityUpdate(finalized, 500, finalized + 65));
    await flush();

    const active = findActiveJob(run.context.storage, "first-to-second");
    expect(active).not.toBeNull();
    expect(run.named("finality_seen").at(-1)).toMatchObject({ finalizedSlot: finalized, source: "sse", latencyMs: 800 });
    expect(run.named("proof_due")).toMatchObject([{ why: "message" }]);
    // The fake clock does not move during the reads: the job starts 0 ms after the event arrived.
    expect(run.named("job_started")).toMatchObject([{ jobId: active?.id, reason: "finality", why: "waiting-message", latencyMs: 0 }]);
    // The same update again starts nothing.
    run.beacon.latest().send("light_client_finality_update", finalityUpdate(finalized, 512, finalized + 66));
    await flush();
    expect(run.named("job_started")).toHaveLength(1);
    await stop();
    run.backend.prover.settleAll({ kind: "up-to-date" });
    await run.service.settled();
  });

  it("falls back to the poll when the node refuses the stream, and still starts the job", async () => {
    const run = setup();
    run.beacon.streamAnswers({ status: 501 });
    const stop = await startWatch({ context: run.context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient } });
    await flush();
    expect(run.named("watch_sse_failed")).toHaveLength(1);
    const sent = HEAD + 100;
    run.beacon.set(FEED, { items: [{ messageId: `0x${"ab".repeat(32)}`, sent: { timestamp: GENESIS + sent * SLOT } }] });
    const finalized = (Math.floor(sent / 32) + 1) * 32;
    vi.setSystemTime(slotStart(finalized + 65));
    run.beacon.set(FINALITY, finalityUpdate(finalized, 400, finalized + 65));
    await vi.advanceTimersByTimeAsync(SLOT * 1000);
    await flush();
    expect(run.named("finality_seen").at(-1)).toMatchObject({ finalizedSlot: finalized, source: "poll" });
    expect(findActiveJob(run.context.storage, "first-to-second")).not.toBeNull();
    await stop();
    run.backend.prover.settleAll({ kind: "up-to-date" });
    await run.service.settled();
  });

  it("pings the remote prover before an expected finality, on the scan timer", async () => {
    const run = setup();
    const sent = HEAD + 300;
    run.beacon.set(FEED, { items: [{ messageId: `0x${"ab".repeat(32)}`, sent: { timestamp: GENESIS + sent * SLOT } }] });
    const stop = await startWatch({ context: run.context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient } });
    const expected = ((Math.floor(sent / 32) + 3) * 32 + 1) * SLOT + GENESIS;
    vi.setSystemTime((expected - 60) * 1000);
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(run.pings).toHaveLength(1);
    expect(run.named("warmup_scheduled")).toMatchObject([{ why: "message", leadSeconds: 90 }]);
    expect(run.named("warmup_ready")).toMatchObject([{ why: "message", cold: false }]);
    await stop();
  });

  it("ends the sessions a stopped backend left open, and says that a fixed lead time is ignored", async () => {
    const run = setup({ leadSeconds: 45 });
    createWarmupStore(run.context.storage).openSession({ direction: "first-to-second", why: "message", dueAt: 0, leadSeconds: 90, at: Date.now() - 10_000 });
    const stop = await startWatch({ context: run.context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient } });
    expect(run.named("warmup_sessions_closed")).toMatchObject([{ count: 1 }]);
    expect(run.named("config_ignored")).toMatchObject([{ level: "warn", key: "watch.warmup.leadSeconds" }]);
    // Ended at the start: it stops counting against the daily cap.
    expect(createWarmupStore(run.context.storage).warmSecondsInWindow(Date.now() + 60_000)).toBe(10);
    await stop();
  });

  it("asks the source node for handoff updates when the light client is periods behind", async () => {
    const run = setup();
    const behind = { ...lightClient, headSlot: HEAD - 3 * PERIOD };
    run.beacon.set(FINALITY, finalityUpdate(HEAD + 64, 500));
    const stop = await startWatch({ context: run.context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => behind } });
    await flush();
    expect(run.beacon.requests.some((path) => path.startsWith("/eth/v1/beacon/light_client/updates?start_period="))).toBe(true);
    // The fake node serves no updates: the light client is stranded, and the watch says so.
    expect(run.named("proof_not_due")).toMatchObject([{ why: "stranded" }]);
    await stop();
  });

  it("logs that the watch is off and does nothing", async () => {
    const run = setup();
    const stop = await startWatch({ context: { ...run.context, config: makeConfig() }, service: run.service });
    expect(run.named("watch_off")).toMatchObject([{ reason: "watch.enabled is false" }]);
    const unset = await startWatch({ context: { ...run.context, config: makeConfig({ watch: {} }) }, service: run.service });
    expect(run.named("watch_off")[1]).toMatchObject({ reason: "indexerUrl or a beacon endpoint is not set" });
    await stop();
    await unset();
  });

  it("without a ping or with warm-ups off, sends no warm-ups", async () => {
    const run = setup({ warmup: false });
    const stop = await startWatch({ context: run.context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient } });
    expect(run.named("watch_started")).toMatchObject([{ warmup: false }]);
    await stop();
    const { pingProver: _unused, ...withoutPing } = run.context;
    const again = await startWatch({ context: { ...withoutPing, config: makeConfig({ indexerUrl: "http://indexer.test", watch: { directions: ["first-to-second"] } }) }, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient } });
    expect(run.named("watch_started")[1]).toMatchObject({ warmup: false });
    await again();
  });

  it("reports a bad indexer answer as a failed read", async () => {
    const run = setup();
    run.beacon.set(FEED, { nothing: true });
    const stop = await startWatch({ context: run.context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient } });
    await flush();
    expect(run.named("watch_read_failed")[0]).toMatchObject({ error: { message: "the chain indexer sent the feed in an unknown shape" } });
    run.beacon.set(FEED, {}, 502);
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(run.named("watch_read_failed")[1]).toMatchObject({ error: { message: "the chain indexer answered 502 for the feed" } });
    await stop();
  });

  it("with a minimum interval (named by its deprecated alias), values the waiting messages on PulseChain and proves when the interval since the last proof ends", async () => {
    const run = setup();
    const USDC = STABLES[0]!.address;
    const POOL = "0x0000000000000000000000000000000000000a01";
    const ZERO = "0x0000000000000000000000000000000000000000";
    const baseFees: Array<bigint | null> = [null, 7n];
    const chain = {
      getBlockNumber: async () => 5n,
      getBlock: async () => ({ baseFeePerGas: baseFees.length > 0 ? (baseFees.shift() as bigint | null) : 7n }),
      readContract: async (call: { address: string; functionName: string; args?: readonly unknown[] }) => {
        if (call.functionName === "getPair") return call.address === PULSEX_FACTORIES[0] && (call.args as string[]).includes(USDC) ? POOL : ZERO;
        if (call.functionName === "token0") return USDC;
        return [10n ** 12n, 10n ** 26n, 0];
      },
    };
    // The server's backend.json still names the interval maxWaitSeconds: read as minIntervalSeconds, with a warning.
    const context = { ...run.context, config: makeConfig({ indexerUrl: "http://indexer.test", watch: { directions: ["first-to-second"], pairs: { "eth-pls": { maxWaitSeconds: 600 } } } }) };
    // A proof of the direction started just now, before this process: the interval counts from it.
    insertJob(run.context.storage, { id: "earlier", direction: "first-to-second", now: Date.now() });
    run.context.storage.database.prepare("UPDATE jobs SET status = 'on-chain', new_slot = '1'").run();
    const lastProofAt = Date.now();
    const stop = await startWatch({ context, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient, chainClient: () => chain } });
    await flush();
    expect(run.named("config_deprecated")).toMatchObject([{ level: "warn", key: "watch.pairs.eth-pls.maxWaitSeconds" }]);
    expect(run.named("watch_started")).toMatchObject([{ batch: { "first-to-second": { minIntervalSeconds: 600, lookaheadSeconds: 384, profitMargin: 1 } } }]);
    const sent = HEAD + 100;
    const messageId = `0x${"ab".repeat(32)}`;
    run.beacon.set(FEED, { items: [{ messageId, sent: { timestamp: GENESIS + sent * SLOT }, transfer: { destinationToken: null } }] });
    const finalized = (Math.floor(sent / 32) + 1) * 32;
    const send = async (slot: number, participants: number) => {
      vi.setSystemTime(Math.max(Date.now(), slotStart(slot + 65)));
      run.beacon.latest().send("light_client_finality_update", finalityUpdate(slot, participants, slot + 65));
      await flush();
    };
    // The indexer does not serve the message, then serves it in an unknown shape: the batch cannot be valued.
    run.beacon.set(`/api/messages/${messageId}`, { error: "busy" }, 503);
    await send(finalized, 500);
    run.beacon.set(`/api/messages/${messageId}`, { data: "nope" });
    vi.setSystemTime(Date.now() + 61_000);
    await send(finalized, 501);
    expect(run.named("watch_economics_failed").map((line) => (line.error as { message: string }).message)).toEqual([
      "the chain indexer answered 503 for a message",
      "the chain indexer sent a message in an unknown shape",
    ]);
    // Served: a message that pays no fee does not cover the cost, so the batch waits for the interval to end.
    run.beacon.set(`/api/messages/${messageId}`, { data: "0x" });
    vi.setSystemTime(Date.now() + 61_000);
    await send(finalized, 502);
    expect(run.named("proof_not_due").at(-1)).toMatchObject({ why: "min-interval", feesUsd: "0.000000", lastProofAt: new Date(lastProofAt).toISOString(), dueAt: new Date(lastProofAt + 600_000).toISOString() });
    expect(findActiveJob(run.context.storage, "first-to-second")).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(run.named("proof_due")).toMatchObject([{ why: "message", trigger: "interval", batch: 1 }]);
    // The job it started is now the last proof.
    expect(lastProofStartedAt(run.context.storage, "first-to-second")).toBeGreaterThan(lastProofAt);
    await stop();
    run.backend.prover.settleAll({ kind: "up-to-date" });
    await run.service.settled();
  });

  it("a pair without PulseChain reads no prices", async () => {
    const run = setup();
    const testnet = { ...PAIR, sides: [PAIR.sides[0], { ...PAIR.sides[1], chainId: 943 }] as const };
    const asked: number[] = [];
    const chainClient = (side: { chainId: number }) => {
      asked.push(side.chainId);
      return { getBlockNumber: async () => 1n, getBlock: async () => ({ baseFeePerGas: 1n }), readContract: async () => null };
    };
    const stop = await startWatch({ context: { ...run.context, pair: testnet }, service: run.service, dependencies: { fetchFunction: () => run.beacon.fetchFunction, readLightClient: async () => lightClient, chainClient } });
    // Only the destination of the watched direction, for its base fee.
    expect(asked).toEqual([943]);
    await stop();
  });

  it("the requests module starts the watch with the global fetch and the chain reader, and stops it", async () => {
    const run = setup();
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(HEAD + 64, 500));
    vi.stubGlobal("fetch", beacon.fetchFunction);
    const stop = await startRequests({ ...run.context, config: makeConfig({ indexerUrl: "http://indexer.test", watch: { directions: ["first-to-second"], sse: false } }) });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.named("watch_started")).toHaveLength(1);
    // The chain reader asks the RPC endpoint over the same fetch, which answers no RPC: a failed read.
    expect(beacon.requests).toContain(FINALITY);
    expect(run.named("watch_read_failed")).toHaveLength(1);
    await stop();
  });
});

describe("the request service, for the watcher", () => {
  it("a finality request reads the indexer afresh, and logs its reason and latency", async () => {
    const proofNeed = fakeProofNeed({ needed: false });
    const backend = makeBackend({ proofNeed });
    const service = createRequestService({
      storage: backend.storage,
      proverForJob: backend.context.proverForJob,
      readProofNeed: proofNeed.read,
      now: backend.clock.now,
      limits: backend.context.config.limits,
      proverTimeoutMilliseconds: 1_800_000,
      logger: backend.log.logger,
    });
    const base = { pair: "eth-pls", direction: "first-to-second" as const, caller: "203.0.113.9" };
    expect(await service.submit({ ...base, reason: "user" })).toEqual({ refused: "nothing-to-prove" });
    proofNeed.answer({ needed: true, why: "waiting-message" });
    // A user request inside the reuse window gets the cached answer; the watcher's request does not.
    expect(await service.submit({ ...base, caller: "203.0.113.10", reason: "user" })).toEqual({ refused: "nothing-to-prove" });
    backend.clock.advance(1_500);
    const started = await service.submit({ ...base, caller: "watch", reason: "finality", since: backend.clock.now() - 1_200 });
    expect(started).toMatchObject({ jobId: expect.any(String) });
    expect(proofNeed.reads).toHaveLength(2);
    const line = backend.log.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.event === "job_started");
    expect(line).toMatchObject({ reason: "finality", why: "waiting-message", latencyMs: 1_200 });
    expect(getRequest(backend.storage, (started as { requestId: string }).requestId)).toMatchObject({ reason: "finality", messageId: null });
    backend.prover.settleAll({ kind: "up-to-date" });
    await service.settled();
  });
  it("takes the watcher's planned handoff when the indexer's age rule says nothing is due, and only from the watcher", async () => {
    // The planner reads the light client and the beacon chain; the indexer only knows the head's age. A head 2 h old
    // can still be 5.9 h from its committee deadline, and the age rule (12 h) would refuse it until it strands.
    const proofNeed = fakeProofNeed({ needed: false });
    const backend = makeBackend({ proofNeed });
    const service = createRequestService({
      storage: backend.storage,
      proverForJob: backend.context.proverForJob,
      readProofNeed: proofNeed.read,
      now: backend.clock.now,
      limits: backend.context.config.limits,
      proverTimeoutMilliseconds: 1_800_000,
      logger: backend.log.logger,
    });
    const base = { pair: "eth-pls", direction: "second-to-first" as const };
    expect(await service.submit({ ...base, caller: "203.0.113.9", reason: "keep-alive", plannedHandoff: true })).toEqual({ refused: "nothing-to-prove" });
    // A keep-alive of the age rule comes without the flag and meets the indexer's rule like any request.
    expect(await service.submit({ ...base, caller: "watch", reason: "finality" })).toEqual({ refused: "nothing-to-prove" });
    const started = await service.submit({ ...base, caller: "watch", reason: "finality", plannedHandoff: true });
    expect(started).toMatchObject({ jobId: expect.any(String) });
    const line = backend.log.lines.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.event === "job_started");
    expect(line).toMatchObject({ reason: "finality", why: "keep-alive" });
    backend.prover.settleAll({ kind: "up-to-date" });
    await service.settled();
  });
});

describe("createProverPing", () => {
  it("asks the endpoint's health route with the key and answers the status only", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchFunction = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const ping = createProverPing({ endpoint: "https://endpoint.example.org/", apiKey: SECRETS.runpodApiKey, fetchFunction: () => fetchFunction });
    expect(await ping()).toBe(204);
    expect(calls).toEqual([{ url: "https://endpoint.example.org/ping", authorization: `Bearer ${SECRETS.runpodApiKey}` }]);
    const withBody = createProverPing({ endpoint: "https://endpoint.example.org", apiKey: "k", fetchFunction: () => (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    expect(await withBody()).toBe(200);
  });

  it("uses the global fetch by default", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    expect(await createProverPing({ endpoint: "https://endpoint.example.org", apiKey: "k" })()).toBe(200);
  });
});
