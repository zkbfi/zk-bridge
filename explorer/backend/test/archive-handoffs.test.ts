import { describe, expect, it } from "vitest";
import type { HandoffProver, HandoffRecord } from "@zk-bridge/shared/prover";
import { createApp } from "../src/app.ts";
import { handoffArchiveBases } from "../src/config.ts";
import { createHandoffCapture, handoffEndpointsOf, handoffPeriods, hasHandoff, MAX_RETRY_MILLISECONDS, readHandoff, recentHandoffs, storeHandoff, type CaptureTarget } from "../src/archive/handoffs.ts";
import { health, runHandoffCapture, start } from "../src/archive/module.ts";
import type { LightClientFacts } from "../src/keepalive/plan.ts";
import { MODULES } from "../src/main.ts";
import type { BackendModuleContext } from "../src/module.ts";
import { openStorage } from "../src/storage.ts";
import { makeBackend, makeClock, makeConfig, memoryLogger, PAIR } from "./support.ts";

const SLOTS = 8192;
const record = (chainId: number, period: number, extra = ""): HandoffRecord => ({
  text: JSON.stringify({ attestedSlot: period * SLOTS + 8000, chainId, finalizedSlot: period * SLOTS + 7900, format: "zkb-handoff-update/1", period, signatureSlot: period * SLOTS + 8001, update: { extra } }),
  chainId,
  period,
  attestedSlot: period * SLOTS + 8000,
  finalizedSlot: period * SLOTS + 7900,
  signatureSlot: period * SLOTS + 8001,
});

/** Facts whose clock is in `period`, at `now` milliseconds. */
const factsAt = (period: number, now: number): LightClientFacts => ({ headSlot: 1, slotsPerPeriod: SLOTS, secondsPerSlot: 12, nextCommitteeKnown: false, genesisTime: Math.floor(now / 1000) - (period * SLOTS + 10) * 12 });

describe("the handoff table (2026-11-07)", () => {
  it("keeps the first record of a period, knows the same one again, and refuses a different one", () => {
    const storage = openStorage(":memory:");
    expect(storeHandoff(storage, record(943, 5), 100)).toBe("stored");
    expect(storeHandoff(storage, record(943, 5), 200)).toBe("known");
    expect(storeHandoff(storage, record(943, 5, "other"), 300)).toBe("conflict");
    expect(storeHandoff(storage, record(943, 3), 400)).toBe("stored");
    expect(storeHandoff(storage, record(1, 3), 50)).toBe("stored");
    expect(readHandoff(storage, 943, 5)).toBe(record(943, 5).text);
    expect(readHandoff(storage, 943, 6)).toBeNull();
    expect(hasHandoff(storage, 943, 3)).toBe(true);
    expect(hasHandoff(storage, 943, 4)).toBe(false);
    expect(handoffPeriods(storage, 943)).toEqual([3, 5]);
    expect(recentHandoffs(storage, 100).map((row) => [row.chainId, row.period, row.storedAt])).toEqual([
      [943, 3, 400],
      [943, 5, 100],
    ]);
  });

  it("gives the planner every source of a side, with this backend's table read directly", () => {
    const backend = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test/", handoffArchiveUrls: ["https://gateway.example/ipfs/cid/handoff-updates"] }) });
    const side = { ...PAIR.sides[1], stateUrls: ["https://states.example"], handoffUrls: ["https://more.example"] };
    const endpoints = handoffEndpointsOf(backend.context, side);
    expect(endpoints).toMatchObject({ chainId: 369, beaconUrl: side.beaconUrl, stateUrls: ["https://states.example"], handoffUrls: ["https://more.example"], archiveUrls: ["http://indexer.test/api/proofs/handoffs", "https://gateway.example/ipfs/cid/handoff-updates"] });
    expect(endpoints.local?.(4)).toBe(false);
    storeHandoff(backend.storage, record(369, 4), 1);
    expect(endpoints.local?.(4)).toBe(true);
    const bare = handoffEndpointsOf(backend.context, { ...PAIR.sides[0], stateUrls: undefined } as never);
    expect(bare).toMatchObject({ stateUrls: [], handoffUrls: [] });
  });

  it("names this backend's own route first, on a loopback address for a wildcard listen", () => {
    expect(handoffArchiveBases(makeConfig({ listen: { host: "127.0.0.1", port: 8787 } }))).toEqual(["http://127.0.0.1:8787/archive/handoffs"]);
    expect(handoffArchiveBases(makeConfig({ listen: { host: "0.0.0.0", port: 1 }, indexerUrl: "http://indexer.test" }))).toEqual(["http://127.0.0.1:1/archive/handoffs", "http://indexer.test/api/proofs/handoffs"]);
    expect(handoffArchiveBases(makeConfig({ listen: { host: "::", port: 2 } }))[0]).toBe("http://127.0.0.1:2/archive/handoffs");
    expect(handoffArchiveBases(makeConfig({ listen: { host: "::1", port: 3 } }))[0]).toBe("http://[::1]:3/archive/handoffs");
  });
});

describe("the handoff capture (2026-11-07)", () => {
  function setup(options: { answer?: (period: number) => HandoffRecord | Error; readFacts?: () => Promise<LightClientFacts>; current?: number } = {}) {
    const storage = openStorage(":memory:");
    const clock = makeClock(1_800_000_000_000);
    const log = memoryLogger();
    const asked: number[] = [];
    const prover: HandoffProver = {
      async handoffUpdate({ period }) {
        asked.push(period);
        const answer = options.answer?.(period) ?? record(943, period);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const target: CaptureTarget = { direction: "second-to-first", chainId: 943, readFacts: options.readFacts ?? (async () => factsAt(options.current ?? 10, clock.now())) };
    const capture = createHandoffCapture({ storage, prover, targets: [target], backfillPeriods: 3, intervalMilliseconds: 600_000, logger: log.logger, now: clock.now });
    return { storage, clock, log, asked, capture };
  }
  const events = (log: ReturnType<typeof memoryLogger>, name: string) => log.lines.filter((line) => line.includes(`"event":"${name}"`));

  it("asks for every ended period of the window that has no record, and keeps each", async () => {
    const run = setup();
    storeHandoff(run.storage, record(943, 8), 1);
    await run.capture.runOnce();
    expect(run.asked).toEqual([7, 9]);
    expect(handoffPeriods(run.storage, 943)).toEqual([7, 8, 9]);
    expect(events(run.log, "handoff_captured")).toHaveLength(2);
    expect(run.capture.status()).toEqual({ kept: 3, failing: 0 });
    await run.capture.runOnce();
    expect(run.asked).toEqual([7, 9]);
  });

  it("starts at period 0 near genesis", async () => {
    const run = setup({ current: 1 });
    await run.capture.runOnce();
    expect(run.asked).toEqual([0]);
  });

  it("waits longer after each failure, at most six hours, and keeps a conflicting record out", async () => {
    let fail = true;
    const run = setup({ answer: (period) => (period === 9 && fail ? new Error("no source has the handoff update") : period === 8 ? record(943, 7) : record(943, period)) });
    storeHandoff(run.storage, record(943, 7, "first"), 1);
    await run.capture.runOnce();
    expect(run.asked).toEqual([8, 9]);
    expect(events(run.log, "handoff_capture_failed")).toHaveLength(2);
    expect(events(run.log, "handoff_capture_failed")[0]).toContain("the prover gave the record of chain 943, period 7");
    expect(run.capture.status().failing).toBe(2);
    await run.capture.runOnce();
    expect(run.asked).toEqual([8, 9]);
    run.clock.advance(600_000);
    await run.capture.runOnce();
    expect(run.asked).toEqual([8, 9, 8, 9]);
    expect(events(run.log, "handoff_capture_failed").at(-1)).toContain('"retryInSeconds":1200');
    for (let index = 0; index < 8; index += 1) {
      run.clock.advance(MAX_RETRY_MILLISECONDS);
      await run.capture.runOnce();
    }
    expect(events(run.log, "handoff_capture_failed").at(-1)).toContain(`"retryInSeconds":${MAX_RETRY_MILLISECONDS / 1000}`);
    fail = false;
    run.clock.advance(MAX_RETRY_MILLISECONDS);
    await run.capture.runOnce();
    expect(hasHandoff(run.storage, 943, 9)).toBe(true);
    // Period 8 keeps answering a record of another period.
    expect(run.capture.status().failing).toBe(1);
  });

  it("logs a conflict when another record of the period arrived while the prover ran", async () => {
    const storage = openStorage(":memory:");
    const clock = makeClock(1_800_000_000_000);
    const log = memoryLogger();
    const capture = createHandoffCapture({
      storage,
      prover: {
        async handoffUpdate() {
          storeHandoff(storage, record(943, 9), 1);
          return record(943, 9, "other");
        },
      },
      targets: [{ direction: "second-to-first", chainId: 943, readFacts: async () => factsAt(10, clock.now()) }],
      backfillPeriods: 1,
      intervalMilliseconds: 600_000,
      logger: log.logger,
      now: clock.now,
    });
    await capture.runOnce();
    expect(log.lines.some((line) => line.includes("handoff_capture_conflict"))).toBe(true);
    expect(readHandoff(storage, 943, 9)).toBe(record(943, 9).text);
  });

  it("logs a light client it cannot read and goes on; a second call joins the running pass", async () => {
    const run = setup({ readFacts: async () => Promise.reject(new Error("rpc down")) });
    const first = run.capture.runOnce();
    const second = run.capture.runOnce();
    await Promise.all([first, second, run.capture.settled()]);
    expect(events(run.log, "handoff_capture_read_failed")).toHaveLength(1);
    expect(run.asked).toEqual([]);
  });
});

describe("the handoff routes and the capture timer of the archive module (2026-11-07)", () => {
  it("lists the periods, serves a record unchanged, and refuses a bad path", async () => {
    const backend = makeBackend({ enabled: ["archive"] });
    storeHandoff(backend.storage, record(943, 5), backend.clock.now());
    storeHandoff(backend.storage, record(943, 2), backend.clock.now() - 8 * 86_400_000);
    const app = createApp({ context: backend.context, modules: MODULES, enabled: ["archive"] });
    expect(await (await app.request("/archive/handoffs/943")).json()).toEqual({ periods: [2, 5] });
    expect((await app.request("/archive/handoffs/x")).status).toBe(400);
    const found = await app.request("/archive/handoffs/943/5.json");
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toContain("application/json");
    expect(await found.text()).toBe(record(943, 5).text);
    expect((await app.request("/archive/handoffs/943/6.json")).status).toBe(404);
    expect((await app.request("/archive/handoffs/943/5")).status).toBe(400);
    expect((await app.request("/archive/handoffs/a/5.json")).status).toBe(400);
    // The live route lists the records of the last seven days only.
    const rows = (await (await app.request("/archive/proofs")).json()) as { handoffs: Array<{ period: number }> };
    expect(rows.handoffs.map((row) => row.period)).toEqual([5]);
  });

  it("runs the capture from start when the context has the command, and says why not otherwise", async () => {
    const base = makeBackend({ config: makeConfig({ handoffCapture: { intervalSeconds: 60 } }), enabled: ["archive"] });
    const asked: number[] = [];
    const context: BackendModuleContext = {
      ...base.context,
      handoffProver: {
        async handoffUpdate({ period, direction }) {
          asked.push(period);
          return record(direction === "first-to-second" ? 1 : 369, period);
        },
      },
      readLightClientOf: async () => factsAt(4, base.clock.now()),
    };
    const stop = await start(context);
    await runHandoffCapture(context);
    await stop();
    expect(asked.length).toBeGreaterThan(0);
    expect(handoffPeriods(base.storage, 1).length + handoffPeriods(base.storage, 369).length).toBe(8);
    expect(health(context).detail).toContain("8 handoff records, 0 periods failing");

    const off = makeBackend({ config: makeConfig({ handoffCapture: { enabled: false } }), enabled: ["archive"] });
    await (await start({ ...off.context, handoffProver: context.handoffProver as HandoffProver }))();
    expect(off.log.lines.join("\n")).toContain("handoffCapture.enabled is false");
    const missing = makeBackend({ enabled: ["archive"] });
    await (await start(missing.context))();
    expect(missing.log.lines.join("\n")).toContain("no handoff-update command in this context");
    await runHandoffCapture(missing.context);
  });

  it("follows only a source chain with a beacon endpoint, and reads the light client over its RPC by default", async () => {
    const base = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test/" }), enabled: ["archive"] });
    const asked: string[] = [];
    const pair = { ...PAIR, sides: [PAIR.sides[0], { ...PAIR.sides[1], beaconUrl: null, rpcUrl: "http://127.0.0.1:1" }] as typeof PAIR.sides };
    const context: BackendModuleContext = {
      ...base.context,
      pair,
      handoffProver: {
        async handoffUpdate({ direction }) {
          asked.push(direction);
          throw new Error("not reached");
        },
      },
    };
    const stop = await start(context);
    await runHandoffCapture(context);
    await stop();
    // Chain 1 is followed through the light client on chain 369, whose RPC refuses: the read fails and is logged.
    expect(asked).toEqual([]);
    expect(base.log.lines.join("\n")).toContain("handoff_capture_read_failed");
    expect(base.log.lines.join("\n")).toContain('"chainId":1');
    expect(base.log.lines.join("\n")).not.toContain('"chainId":369');
  });
});
