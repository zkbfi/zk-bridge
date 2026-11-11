import { describe, expect, it } from "vitest";
import { createForkScheduleStore, memoryForkScheduleText } from "@zk-bridge/shared";
import { bridgeCheck, forkCutoverCheck, gateCheck } from "../src/checks/bridges.ts";
import type { ChainClient } from "../src/deps.ts";
import { fakeFetch, makeDeps, pair } from "./support.ts";

describe("bridgeCheck", () => {
  const client = (open: boolean | Error): ChainClient => ({ readContract: async () => { if (open instanceof Error) throw open; return open; } }) as unknown as ChainClient;

  it("is ok when deposits are open", async () => {
    const deps = makeDeps({ client: () => client(true) });
    const check = bridgeCheck(deps, 11155111);
    expect(check.id).toBe("bridge-11155111");
    expect(check.name).toBe("Sepolia bridge");
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "deposits are open" });
  });

  it("says deposits are closed", async () => {
    const deps = makeDeps({ client: () => client(false) });
    expect(await bridgeCheck(deps, 943).run(deps)).toEqual({ state: "degraded", detail: "deposits are closed, sends are refused" });
  });

  it("asks the bridge contract of the chain", async () => {
    let asked: unknown;
    const deps = makeDeps({ client: () => ({ readContract: async (request: unknown) => ((asked = request), true) }) as unknown as ChainClient });
    await bridgeCheck(deps, 943).run(deps);
    expect(asked).toMatchObject({ address: "0x" + "a".repeat(40), functionName: "depositsOpen" });
  });
});

describe("gateCheck", () => {
  /** A gate read at a block whose next block lands in epoch 10. */
  const gate = (values: { mode?: number; enforcing?: boolean; sealed?: boolean; confirmed?: [bigint, boolean] }): ChainClient =>
    ({
      getBlock: async () => ({ number: 77n, timestamp: 3840n, parentBeaconBlockRoot: null }),
      readContract: async ({ functionName }: { functionName: string }) =>
        ({
          mode: values.mode ?? 0,
          enforcing: values.enforcing ?? true,
          isSealed: values.sealed ?? false,
          confirmedEpoch: values.confirmed ?? [10n, true],
          genesisTime: 0n,
          secondsPerSlot: 12n,
          slotsPerEpoch: 32n,
          genesisValidatorsRoot: "0x" + "00".repeat(32),
          beaconRoots: "0x" + "bb".repeat(20),
        })[functionName],
    }) as unknown as ChainClient;

  it("reports an enforcing gate and its confirmed epoch", async () => {
    const deps = makeDeps({ client: () => gate({}) });
    const check = gateCheck(deps, 11155111);
    expect(check.id).toBe("gate-11155111");
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "enforcing, epoch 10 is confirmed" });
  });

  it("says when the current epoch still needs its confirmation", async () => {
    const deps = makeDeps({ client: () => gate({ confirmed: [9n, true] }) });
    expect(await gateCheck(deps, 11155111).run(deps)).toEqual({ state: "ok", detail: "enforcing, last confirmed epoch 9, epoch 10 needs a confirmation before the next send" });
    const none = makeDeps({ client: () => gate({ confirmed: [0n, false] }) });
    expect(await gateCheck(none, 11155111).run(none)).toEqual({ state: "ok", detail: "enforcing, no epoch confirmed yet, epoch 10 needs a confirmation before the next send" });
  });

  it("reports a gate in a detection mode as ok: by design it admits sends until the chain gains beacon roots", async () => {
    const roots = makeDeps({ client: () => gate({ mode: 1, enforcing: false }) });
    expect(await gateCheck(roots, 943).run(roots)).toEqual({ state: "ok", detail: "detection mode (detect-beacon-roots): admits sends until PulseChain testnet gains beacon roots or a newer opcode, then enforces for good" });
    const registry = makeDeps({ client: () => gate({ mode: 2, enforcing: false }) });
    expect(await gateCheck(registry, 943).run(registry)).toEqual({ state: "ok", detail: "detection mode (detect-beacon-roots-and-registry): admits sends until PulseChain testnet gains beacon roots or a newer opcode, then enforces for good" });
  });

  it("reports a seal-only gate as ok: it admits every send until it is sealed, and needs no confirmation", async () => {
    const sealOnly = makeDeps({ client: () => gate({ mode: 3, confirmed: [0n, false] }) });
    expect(await gateCheck(sealOnly, 11155111).run(sealOnly)).toEqual({ state: "ok", detail: "seal-only mode (seal-only): admits every send until a proof of a fork the route cannot follow seals it" });
    const withRegistry = makeDeps({ client: () => gate({ mode: 4, confirmed: [0n, false] }) });
    expect((await gateCheck(withRegistry, 943).run(withRegistry)).detail).toContain("seal-only mode (seal-only-with-registry)");
    const sealed = makeDeps({ client: () => gate({ mode: 3, sealed: true }) });
    expect((await gateCheck(sealed, 943).run(sealed)).state).toBe("down");
  });

  it("is degraded for an enforcing-mode gate that does not enforce", async () => {
    const broken = makeDeps({ client: () => gate({ mode: 0, enforcing: false }) });
    expect(await gateCheck(broken, 943).run(broken)).toEqual({ state: "degraded", detail: "mode enforcing but not enforcing, it admits every send" });
  });

  it("is down for a sealed gate, which refuses every send for good", async () => {
    const sealed = makeDeps({ client: () => gate({ sealed: true }) });
    expect(await gateCheck(sealed, 943).run(sealed)).toEqual({ state: "down", detail: "sealed after a fork, it refuses every send and the seal never clears" });
    const detecting = makeDeps({ client: () => gate({ sealed: true, mode: 1, enforcing: false }) });
    expect((await gateCheck(detecting, 943).run(detecting)).state).toBe("down");
  });
});

describe("forkCutoverCheck", () => {
  const NOW_SECONDS = 1_800_000_000;
  /** Sepolia's schedule: one fork at epoch E (genesis time chosen so the fork is `away` seconds from now). */
  const beacon = (away: number) => ({
    "https://beacon-a.example.org/key-a/eth/v1/config/fork_schedule": { body: { data: [{ current_version: "0x90000069", epoch: "0" }, { current_version: "0x90000070", epoch: "100" }] } },
    "https://beacon-a.example.org/key-a/eth/v1/beacon/genesis": { body: { data: { genesis_time: String(NOW_SECONDS + away - 100 * 384) } } },
    "https://beacon-a.example.org/key-a/eth/v1/config/spec": { body: { data: { SECONDS_PER_SLOT: "12", SLOTS_PER_EPOCH: "32" } } },
  });
  /** A client that answers the light client head, the gate and the registry. */
  const client = (reads: Record<string, unknown> = {}): ChainClient =>
    ({
      readContract: async ({ functionName }: { functionName: string }) => {
        const answers: Record<string, unknown> = { head: 3000n, mode: 0, enforcing: true, isSealed: false, forkRegistry: "0x" + "0".repeat(40), latestObserved: ["0x90000070", 6, 3100n], ...reads };
        return answers[functionName];
      },
    }) as unknown as ChainClient;
  const deps = (away: number, reads: Record<string, unknown> = {}, routes: Record<string, { status?: number }> = {}) => {
    const clock = { now: NOW_SECONDS * 1000 };
    return makeDeps({ clock, fetch: fakeFetch({ ...beacon(away), ...routes }, clock), client: () => client(reads) });
  };

  it("is ok while no pause is near, with the next fork and its countdown", async () => {
    const run = deps(14 * 3600);
    const check = forkCutoverCheck(run, "first-to-second");
    expect(check.id).toBe("fork-cutover-first-to-second");
    expect(check.name).toBe("Sepolia sends before a fork");
    const outcome = await check.run(run);
    expect(outcome.state).toBe("ok");
    expect(outcome.detail).toContain("Sends from Sepolia pause at");
    expect(outcome.detail).toContain("12 h before the Altair fork (epoch 100)");
    expect(outcome.detail).toContain("(Sends pause in 1h 59m) gate not sealed, mode enforcing");
  });

  it("is degraded, with the numbers of the pause, while sends are paused", async () => {
    const run = deps(600);
    const outcome = await forkCutoverCheck(run, "first-to-second").run(run);
    expect(outcome.state).toBe("degraded");
    expect(outcome.detail).toContain("Sends from Sepolia are paused since");
    expect(outcome.detail).toContain("finalized head is past slot 3200; it is slot 3000 now.");
  });

  it("says that no fork is scheduled, reads the registry of the deployment, and names a registry that observed nothing", async () => {
    const clock = { now: NOW_SECONDS * 1000 };
    const none = makeDeps({
      clock,
      fetch: fakeFetch({ ...beacon(0), "https://beacon-a.example.org/key-a/eth/v1/config/fork_schedule": { body: { data: [{ current_version: "0x90000069", epoch: "0" }] } } }, clock),
      client: () => client({ latestObserved: ["0x00000000", 0, 0n] }),
      pair: { ...pair, sides: [{ ...pair.sides[0], contracts: { ...pair.sides[0].contracts, forkRegistry: "0x" + "7".repeat(40) as `0x${string}` } }, pair.sides[1]] as const },
    });
    const outcome = await forkCutoverCheck(none, "first-to-second").run(none);
    expect(outcome).toEqual({ state: "ok", detail: "no fork is scheduled on Sepolia gate not sealed, mode enforcing; registry has observed nothing" });
  });

  it("reads the registry that the gate names, and the other direction", async () => {
    const run = deps(8 * 86_400, { forkRegistry: "0x" + "8".repeat(40), mode: 2 });
    const outcome = await forkCutoverCheck(run, "second-to-first").run(run);
    // The beacon of PulseChain testnet is not served by this fake: unreachable, so the state is degraded.
    expect(outcome.state).toBe("degraded");
    expect(outcome.detail).toContain("PulseChain testnet's beacon node did not answer");
    expect(outcome.detail).toContain("registry version 0x90000070, shape 6, slot 3100");
  });

  it("says when the gate is sealed", async () => {
    const run = deps(8 * 86_400, { isSealed: true });
    expect((await forkCutoverCheck(run, "first-to-second").run(run)).detail).toContain("gate sealed, mode enforcing");
  });

  it("keeps the schedule it read, and decides from that copy when the beacon node stops answering", async () => {
    const forkSchedules = createForkScheduleStore(memoryForkScheduleText());
    const clock = { now: NOW_SECONDS * 1000 };
    const live = makeDeps({ clock, fetch: fakeFetch(beacon(14 * 3600), clock), client: () => client(), forkSchedules });
    expect((await forkCutoverCheck(live, "first-to-second").run(live)).state).toBe("ok");
    const silent = makeDeps({ clock, fetch: fakeFetch({}, clock), client: () => client(), forkSchedules });
    const outcome = await forkCutoverCheck(silent, "first-to-second").run(silent);
    expect(outcome.state).toBe("ok");
    expect(outcome.detail).toContain("(Sends pause in 1h 59m) Sepolia's beacon node did not answer, so this uses the fork schedule saved by this app at");
  });

  it("is degraded when the source chain has no beacon endpoint", async () => {
    const clock = { now: NOW_SECONDS * 1000 };
    const run = makeDeps({ clock, client: () => client(), pair: { ...pair, sides: [{ ...pair.sides[0], beaconUrl: null }, pair.sides[1]] as const } });
    const outcome = await forkCutoverCheck(run, "first-to-second").run(run);
    expect(outcome.state).toBe("degraded");
    expect(outcome.detail).toContain("Sepolia's beacon node did not answer");
  });
});
