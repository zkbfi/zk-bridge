import { describe, expect, it } from "vitest";
import { bridgeCheck, gateCheck } from "../src/checks/bridges.ts";
import type { ChainClient } from "../src/deps.ts";
import { makeDeps } from "./support.ts";

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
