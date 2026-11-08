import { describe, expect, it } from "vitest";
import { beaconCheck, lightClientCheck, lightClientDeadlineCheck, rpcCheck } from "../src/checks/chains.ts";
import type { ChainClient } from "../src/deps.ts";
import { parseStatusConfig } from "../src/config.ts";
import { addr, config as baseConfig, fakeFetch, makeDeps, pair } from "./support.ts";

const NOW = 1_800_000_000;
const sepolia = pair.sides[0];
const pulse = pair.sides[1];

describe("rpcCheck", () => {
  it("is named after the chain", () => {
    expect(rpcCheck(makeDeps(), 943).name).toBe("PulseChain testnet RPC");
    expect(beaconCheck(makeDeps(), 943).name).toBe("PulseChain testnet beacon node");
  });

  const block = (age: number): ChainClient => ({ getBlock: async () => ({ number: 5_000_000n, timestamp: BigInt(NOW - age) }) }) as unknown as ChainClient;

  it("reports the height and how old the block is", async () => {
    const deps = makeDeps({ client: () => block(12) });
    expect(await rpcCheck(makeDeps(), sepolia.chainId).run(deps)).toEqual({ state: "ok", detail: "block 5000000, 12 s old" });
  });

  it("is degraded when the block is old and down when it is much older", async () => {
    expect(await rpcCheck(makeDeps(), sepolia.chainId).run(makeDeps({ client: () => block(300) }))).toEqual({
      state: "degraded",
      detail: "block 5000000 is 5 min old, a block should be under 2 min old",
    });
    expect(await rpcCheck(makeDeps(), sepolia.chainId).run(makeDeps({ client: () => block(900) }))).toMatchObject({ state: "down" });
  });
});

describe("beaconCheck", () => {
  const routes = (finalizedSlot: number, extra: Record<string, unknown> = {}) => ({
    "https://beacon-a.example.org/key-a/eth/v1/beacon/genesis": { body: { data: { genesis_time: String(NOW - 12 * 1000) } } },
    "https://beacon-a.example.org/key-a/eth/v1/beacon/headers/finalized": { body: { data: { header: { message: { slot: String(finalizedSlot) } } } } },
    ...extra,
  });

  it("reports the finalized slot and its age", async () => {
    const c = { now: NOW * 1000 };
    const deps = makeDeps({ clock: c, fetch: fakeFetch(routes(1000 - 60), c) });
    expect(await beaconCheck(makeDeps(), sepolia.chainId).run(deps)).toEqual({ state: "ok", detail: "finalized slot 940, 12 min old" });
    expect(deps.memory.get("genesis-11155111")).toBe(NOW - 12_000);
  });

  it("is degraded when finality is late and down when it has stopped", async () => {
    const c = { now: NOW * 1000 };
    expect(await beaconCheck(makeDeps(), sepolia.chainId).run(makeDeps({ clock: c, fetch: fakeFetch(routes(1000 - 200), c) }))).toMatchObject({ state: "degraded", detail: expect.stringContaining("40 min old") });
    expect(await beaconCheck(makeDeps(), sepolia.chainId).run(makeDeps({ clock: c, fetch: fakeFetch(routes(1), c) }))).toMatchObject({ state: "down" });
  });

  it("uses the genesis it already knows, and fails on a bad genesis", async () => {
    const c = { now: NOW * 1000 };
    const known = makeDeps({ clock: c, fetch: fakeFetch({ ...routes(990) }, c) });
    known.memory.set("genesis-11155111", NOW - 12 * 1000);
    await beaconCheck(makeDeps(), sepolia.chainId).run(known);
    expect(known.fetch).toHaveBeenCalledTimes(1);
    const bad = makeDeps({ clock: c, fetch: fakeFetch({ "https://beacon-a.example.org/key-a/eth/v1/beacon/genesis": { status: 500 } }, c) });
    await expect(beaconCheck(makeDeps(), sepolia.chainId).run(bad)).rejects.toThrow(/genesis/);
    const odd = makeDeps({ clock: c, fetch: fakeFetch({ "https://beacon-a.example.org/key-a/eth/v1/beacon/genesis": { body: { data: {} } } }, c) });
    await expect(beaconCheck(makeDeps(), sepolia.chainId).run(odd)).rejects.toThrow(/genesis/);
  });
});

describe("lightClientCheck", () => {
  const PERIOD = 8192;
  const SECONDS = 12;
  const committee = (known: boolean) => (known ? "0x" + "11".repeat(32) : "0x" + "00".repeat(32));
  /** A light client on `pulse` that follows `sepolia`, with a head `ageOfHead` seconds old. `updates` are the handoff slots the source serves (null: it serves none). */
  function setup(options: { headSlot: number; known: boolean; finalizedSlot: number; ageOfHead: number; updates?: number[]; archived?: number[] }) {
    const genesis = NOW - options.ageOfHead - options.headSlot * SECONDS;
    const pulseClient = {
      getBlockNumber: async () => 100n,
      readContract: async ({ functionName }: { functionName: string }) =>
        ({ head: BigInt(options.headSlot), slotsPerPeriod: BigInt(PERIOD), genesisTime: BigInt(genesis), secondsPerSlot: BigInt(SECONDS), syncCommittees: committee(options.known) })[functionName],
    } as unknown as ChainClient;
    const c = { now: NOW * 1000 };
    const fetch = fakeFetch(
      {
        "https://beacon-a.example.org/key-a/eth/v1/beacon/headers/finalized": { body: { data: { header: { message: { slot: String(options.finalizedSlot) } } } } },
        "https://beacon-a.example.org/key-a/eth/v1/beacon/light_client/updates": options.updates
          ? { body: options.updates.map((slot) => ({ data: { attested_header: { beacon: { slot: String(slot) } } } })) }
          : { status: 404 },
        ...Object.fromEntries(
          Array.from({ length: 4 }, (_, index) => 8 + index).flatMap((period) => {
            const answer = options.archived?.includes(period) ? { body: { format: "zkb-handoff-update/1", chainId: 11155111, period } } : { status: 404 };
            return [
              [`http://127.0.0.1:8787/archive/handoffs/11155111/${period}.json`, answer],
              [`http://127.0.0.1:42069/api/proofs/handoffs/11155111/${period}.json`, { status: 404 }],
            ];
          }),
        ),
      },
      c,
    );
    return makeDeps({ clock: c, fetch, client: () => pulseClient });
  }
  const deps0 = makeDeps();
  const check = lightClientCheck(deps0, "first-to-second");

  it("says how old the head is and when the light client must update, with the owner's wording", async () => {
    const deps = setup({ headSlot: 81_712, known: true, finalizedSlot: 89_400, ageOfHead: 26 * 3600 });
    expect(await check.run(deps)).toEqual({ state: "degraded", detail: "head 26 h old, must update within 2 h" });
    expect(check.id).toBe("lightclient-first-to-second");
    expect(check.name).toBe("PulseChain testnet light client");
    expect(lightClientCheck(deps0, "second-to-first").name).toBe("Sepolia light client");
  });

  it("is ok when the head is fresh and the deadline is far", async () => {
    const deps = setup({ headSlot: 81_712, known: true, finalizedSlot: 81_712, ageOfHead: 3600 });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "head 1 h old, must update within 27 h" });
  });

  it("is ok with a head that is the newest finalized header", async () => {
    const deps = setup({ headSlot: 80_000, known: true, finalizedSlot: 80_000, ageOfHead: 600 });
    expect(await check.run(deps)).toMatchObject({ state: "ok", detail: expect.stringMatching(/^head 10 min old, must update within \d+ h$/) });
  });

  it("is down when the deadline passed and the source serves the handoffs", async () => {
    const deps = setup({ headSlot: 9 * PERIOD + 10, known: false, finalizedSlot: 10 * PERIOD + 50, ageOfHead: 40 * 3600, updates: [9 * PERIOD + 5] });
    const outcome = await check.run(deps);
    expect(outcome.state).toBe("down");
    expect(outcome.detail).toMatch(/^head 40 h old, the deadline passed \d+(\.\d)? h ago and it needs handoff steps/);
  });

  it("is down when the source gives no handoff, because no proof can move the light client", async () => {
    const deps = setup({ headSlot: 9 * PERIOD + 10, known: false, finalizedSlot: 10 * PERIOD + 50, ageOfHead: 40 * 3600 });
    const outcome = await check.run(deps);
    expect(outcome).toMatchObject({ state: "down", detail: expect.stringContaining("stranded, ") });
    expect(outcome.detail).toContain("no proof can move it");
  });

  it("is not stranded when the backend's handoff archive has the period the beacon node lacks (2026-11-07)", async () => {
    const deps = setup({ headSlot: 9 * PERIOD + 10, known: false, finalizedSlot: 10 * PERIOD + 50, ageOfHead: 40 * 3600, archived: [9] });
    const outcome = await check.run(deps);
    expect(outcome.state).toBe("down");
    expect(outcome.detail).toMatch(/needs handoff steps/);
    expect(outcome.detail).not.toContain("stranded");
  });

  it("names every source it tried when it is stranded", async () => {
    const deps = setup({ headSlot: 9 * PERIOD + 10, known: false, finalizedSlot: 10 * PERIOD + 50, ageOfHead: 40 * 3600 });
    const outcome = await check.run(deps);
    expect(outcome.detail).toContain("127.0.0.1:8787 (handoff archive): period 9: answered 404");
  });

  it("explains a missing beacon endpoint", async () => {
    const without = makeDeps({ pair: { ...pair, sides: [{ ...sepolia, beaconUrl: null }, pulse] as const } });
    await expect(lightClientCheck(without, "first-to-second").run(without)).rejects.toThrow("no beacon endpoint for Sepolia");
  });
});

describe("lightClientDeadlineCheck", () => {
  const PERIOD = 8192;
  const SECONDS = 12;
  const HEAD = 15 * PERIOD + 100;
  /** A light client on the destination chain whose deadline is `secondsLeft` away (the next committee is known: it strands in period 17). */
  function setup(secondsLeft: number, overrides: Parameters<typeof makeDeps>[0] = {}) {
    const genesis = NOW - 17 * PERIOD * SECONDS + secondsLeft;
    const calls: string[] = [];
    const client = {
      getBlockNumber: async () => 100n,
      readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        return ({ head: BigInt(HEAD), slotsPerPeriod: BigInt(PERIOD), genesisTime: BigInt(genesis), secondsPerSlot: BigInt(SECONDS), syncCommittees: "0x" + "11".repeat(32) })[functionName];
      },
    } as unknown as ChainClient;
    return { deps: makeDeps({ clock: { now: NOW * 1000 }, client: () => client, ...overrides }), calls };
  }
  const check = lightClientDeadlineCheck(makeDeps(), "first-to-second");

  it("is named after the destination chain, in section chains", () => {
    expect(check.id).toBe("lightclient-deadline-first-to-second");
    expect(check.name).toBe("PulseChain testnet light client deadline");
    expect(check.section).toBe("chains");
    const back = lightClientDeadlineCheck(makeDeps(), "second-to-first");
    expect(back.id).toBe("lightclient-deadline-second-to-first");
    expect(back.name).toBe("Sepolia light client deadline");
  });

  it("is ok above the degraded threshold, with the owner's wording, and reads the chain only", async () => {
    const { deps, calls } = setup(Math.round(20.4 * 3600));
    expect(await check.run(deps)).toEqual({ state: "ok", detail: `PulseChain testnet checks Sepolia: 20.4 h until stranded (head slot ${HEAD}, period 15, strands in period 17)` });
    expect(calls).toContain("head");
    const { deps: back } = setup(Math.round(20.4 * 3600));
    expect((await lightClientDeadlineCheck(back, "second-to-first").run(back)).detail.startsWith("Sepolia checks PulseChain testnet: 20.4 h")).toBe(true);
  });

  it("is degraded at the degraded threshold and just under it", async () => {
    const at = setup(43_200);
    expect((await check.run(at.deps)).state).toBe("degraded");
    const under = setup(Math.round(10 * 3600));
    expect(await check.run(under.deps)).toMatchObject({ state: "degraded", detail: expect.stringContaining("10.0 h until stranded") });
    expect((await check.run(setup(43_201).deps)).state).toBe("ok");
  });

  it("is down at the down threshold and under it", async () => {
    expect((await check.run(setup(21_601).deps)).state).toBe("degraded");
    expect(await check.run(setup(21_600).deps)).toMatchObject({ state: "down", detail: expect.stringContaining("6.0 h until stranded") });
    expect((await check.run(setup(Math.round(5.2 * 3600)).deps)).detail).toBe(`PulseChain testnet checks Sepolia: 5.2 h until stranded (head slot ${HEAD}, period 15, strands in period 17)`);
  });

  it("is down and says how long ago it stranded once the deadline passed", async () => {
    const { deps } = setup(-Math.round(3.1 * 3600));
    expect(await check.run(deps)).toEqual({
      state: "down",
      detail: `PulseChain testnet checks Sepolia: stranded 3.1 h ago unless handoff updates move it (head slot ${HEAD}, period 15, stranded in period 17)`,
    });
    expect((await check.run(setup(0).deps)).state).toBe("down");
  });

  it("uses the thresholds of the configuration", async () => {
    const custom = parseStatusConfig(JSON.stringify({ ...JSON.parse(JSON.stringify(baseConfig)), lightClients: { deadlineDegradedSeconds: 7200, deadlineDownSeconds: 3600 } }));
    expect(custom.lightClients).toMatchObject({ deadlineDegradedSeconds: 7200, deadlineDownSeconds: 3600 });
    expect((await check.run(setup(10_000, { config: custom }).deps)).state).toBe("ok");
    expect((await check.run(setup(5000, { config: custom }).deps)).state).toBe("degraded");
    expect((await check.run(setup(3000, { config: custom }).deps)).state).toBe("down");
  });
});
