// The auto-seal of the deposit gates: the watch of one chain, the module that runs one per chain, and its start-up.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { SealOffer } from "@zk-bridge/shared";
import { createSealWatch, type SealSender } from "../src/seal/seal-watch.ts";
import { asBotLogger, portSender, register, start } from "../src/seal/module.ts";
import { startBackend } from "../src/main.ts";
import { BackendConfigError } from "../src/config.ts";
import { makeBackend, makeConfig, memoryLogger, PAIR, SECRETS } from "./support.ts";

const GATE: Address = "0x1111111111111111111111111111111111111111";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const READY: SealOffer = { kind: "ready", call: { to: GATE, data: "0x1234" }, evidence: "0x", gas: 70_000n, via: "registry" };
/** A throwaway key that holds nothing (the Hardhat test account 0). */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const watchOf = (offer: () => Promise<SealOffer>, send: SealSender = async () => ({ hash: HASH, success: true })) => {
  const log = memoryLogger();
  const alerts: string[] = [];
  const watch = createSealWatch({ chainId: 943, chainName: "PulseChain testnet", gate: GATE, offer, send, logger: log.logger, alert: (text) => alerts.push(text) });
  return { watch, log, alerts };
};

describe("createSealWatch", () => {
  it("sends a seal whose simulation succeeded, with the simulated gas, and alerts before and after", async () => {
    const send = vi.fn<SealSender>(async () => ({ hash: HASH, success: true }));
    const { watch, log, alerts } = watchOf(async () => READY, send);
    expect(await watch.check()).toEqual({ kind: "sent", hash: HASH, success: true, via: "registry" });
    expect(send).toHaveBeenCalledWith({ to: GATE, data: "0x1234", gas: 70_000n });
    expect(alerts).toEqual([
      "The PulseChain testnet chain shows a fork the route cannot follow (the fork registry): sending seal() to its deposit gate.",
      `The PulseChain testnet deposit gate is sealed by transaction ${HASH}.`,
    ]);
    expect(log.lines.join("\n")).toContain("seal_ready");
    expect(log.lines.join("\n")).toContain("seal_sent");
  });

  it("names beacon evidence, and says when the seal reverted on chain or could not be sent", async () => {
    const beacon: SealOffer = { ...READY, via: "beacon" };
    const reverted = watchOf(async () => beacon, async () => ({ hash: HASH, success: false }));
    expect(await reverted.watch.check()).toMatchObject({ kind: "sent", success: false, via: "beacon" });
    expect(reverted.alerts[0]).toContain("(beacon evidence)");
    expect(reverted.alerts[1]).toContain("reverted on chain");
    const broken = watchOf(async () => READY, async () => Promise.reject(new Error("nonce too low")));
    expect(await broken.watch.check()).toEqual({ kind: "failed", stage: "send", error: "nonce too low" });
    expect(broken.alerts[1]).toBe("The seal of the PulseChain testnet deposit gate could not be sent (nonce too low); the next epoch tries again.");
    const thrown = watchOf(async () => READY, async () => Promise.reject("text"));
    expect(await thrown.watch.check()).toMatchObject({ kind: "failed", error: "text" });
  });

  it("sends nothing when no seal would succeed, and logs a reason only when it changes", async () => {
    const send = vi.fn<SealSender>();
    let reason = "the registry shows no shape outside the allowed set";
    const { watch, log, alerts } = watchOf(async () => ({ kind: "unavailable", reason }), send);
    expect(await watch.check()).toEqual({ kind: "not-needed", reason });
    await watch.check();
    reason = "the beacon state has no disallowed shape";
    await watch.check();
    expect(send).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
    expect(log.lines.filter((line) => line.includes("seal_not_needed"))).toHaveLength(2);
  });

  it("alerts once for a sealed gate, and survives a check that fails", async () => {
    const sealed = watchOf(async () => ({ kind: "sealed" }));
    expect(await sealed.watch.check()).toEqual({ kind: "sealed" });
    await sealed.watch.check();
    expect(sealed.alerts).toHaveLength(1);
    expect(sealed.alerts[0]).toContain("is sealed: it refuses every send for good");
    const failing = watchOf(async () => Promise.reject(new Error("rpc down")));
    expect(await failing.watch.check()).toEqual({ kind: "failed", stage: "check", error: "rpc down" });
    expect(failing.log.lines.join("\n")).toContain("seal_check_failed");
  });

  it("never runs two checks at once", async () => {
    let release = (): void => {};
    const send = vi.fn<SealSender>(() => new Promise((resolve) => (release = () => resolve({ hash: HASH, success: true }))));
    const { watch } = watchOf(async () => READY, send);
    const first = watch.check();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(await watch.check()).toBeNull();
    release();
    expect(await first).toMatchObject({ kind: "sent" });
  });
});

describe("the seal module", () => {
  const sealConfig = () => makeConfig({ seal: { signer: { kind: "private-key", key: "env:ZKB_SEAL_KEY" } } });

  it("does nothing without a seal section or a signer", async () => {
    const { context, log } = makeBackend({ enabled: ["seal"] });
    const routes: string[] = [];
    register({ get: (path: string) => routes.push(path) } as never, context);
    expect(routes).toEqual(["/fork-observations/:chainId/latest"]);
    const stop = await start(context);
    await stop();
    expect(log.lines.join("\n")).toContain("seal_off");
    const withSection = makeBackend({ config: sealConfig(), enabled: ["seal"] });
    await (await start(withSection.context))();
    expect(withSection.log.lines.join("\n")).toContain("seal_off");
  });

  it("checks each chain's gate at once and every epoch, from the signer, and sends through the port", async () => {
    const { context, log } = makeBackend({ config: sealConfig(), enabled: ["seal"] });
    const timers: number[] = [];
    const stops = vi.fn();
    const port = { send: vi.fn(async () => ({ hash: HASH, success: true })), feeQuote: vi.fn(async () => ({ baseFee: 10n, priorityFee: 1n })) };
    // The gate reads say "sealed", so no seal is offered; the read of `isSealed` shows each gate is asked.
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => ({ mode: 3, enforcing: true, isSealed: true, forkRegistry: "0x0000000000000000000000000000000000000000" })[functionName]);
    const stop = await start(
      { ...context, openSealSigner: async () => ({ address: TEST_ACCOUNT }) as never },
      {
        client: () => ({ readContract }) as never,
        port: () => port as never,
        every: (milliseconds, check) => {
          timers.push(milliseconds);
          check();
          return stops;
        },
      },
    );
    await vi.waitFor(() => expect(log.lines.filter((line) => line.includes("seal_gate_sealed"))).toHaveLength(2));
    expect(timers).toEqual([384_000, 320_000]);
    expect(log.lines.join("\n")).toContain("seal_started");
    await stop();
    expect(stops).toHaveBeenCalledTimes(2);
    expect(port.send).not.toHaveBeenCalled();
  });

  it("reads the default clients and port of a side, and stops its timers", async () => {
    const { context, log } = makeBackend({ config: sealConfig(), enabled: ["seal"] });
    const pair = { ...PAIR, sides: [{ ...PAIR.sides[0], beaconUrl: null }, PAIR.sides[1]] as const };
    const stop = await start({ ...context, pair, openSealSigner: async () => ({ address: TEST_ACCOUNT }) as never });
    // The RPC endpoints of the test pair do not resolve: each check fails and is logged.
    await vi.waitFor(() => expect(log.lines.filter((line) => line.includes("seal_check_failed"))).toHaveLength(2), { timeout: 20_000 });
    await stop();
  });

  it("prices a send with the quote of now and the simulated gas plus the buffer", async () => {
    const port = { feeQuote: vi.fn(async () => ({ baseFee: 10n, priorityFee: 2n })), send: vi.fn(async () => ({ hash: HASH, success: false })) };
    expect(await portSender(port as never)({ to: GATE, data: "0x12", gas: 100_000n })).toEqual({ hash: HASH, success: false });
    expect(port.send).toHaveBeenCalledWith({ to: GATE, data: "0x12", gas: 130_000n, maxFeePerGas: 22n, maxPriorityFeePerGas: 2n });
  });

  it("gives the runner's signer a logger in its shape", () => {
    const log = memoryLogger();
    const adapted = asBotLogger(log.logger);
    adapted.debug("a");
    adapted.info("b");
    adapted.warn("c", { x: 1 });
    adapted.child({}).error("d");
    expect(log.lines.map((line) => JSON.parse(line).event)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the seal module at start-up", () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
  const environment = { RUNPOD_API_KEY: SECRETS.runpodApiKey, BACKEND_WEBHOOK_BEARER: SECRETS.webhookBearer, PATH: "/usr/bin", ZKB_SEAL_KEY: TEST_KEY };

  it("refuses the module without a seal section", async () => {
    await expect(startBackend({ config: makeConfig(), pair: PAIR, enabled: ["seal"], environment, write: () => {} })).rejects.toThrow(BackendConfigError);
  });

  it("opens the signer by reference and never writes the key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backend-seal-"));
    directories.push(directory);
    const lines: string[] = [];
    const config = makeConfig({ databasePath: join(directory, "backend.sqlite"), listen: { host: "127.0.0.1", port: 0 }, seal: { signer: { kind: "private-key", key: "env:ZKB_SEAL_KEY" } } });
    const running = await startBackend({ config, pair: PAIR, enabled: ["seal"], environment, write: (line) => lines.push(line) });
    try {
      await vi.waitFor(() => expect(lines.join("\n")).toContain("seal_started"));
      expect(lines.join("\n")).toContain(TEST_ACCOUNT);
      expect(lines.join("\n")).not.toContain(TEST_KEY.slice(2));
    } finally {
      await running.stop();
    }
  });
});
