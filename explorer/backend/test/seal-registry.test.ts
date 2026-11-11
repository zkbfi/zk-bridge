// The keep-alive of a fork registry's own light client: the backend posts its update only when nobody did for a period.
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { beaconLightClientAbi } from "@zk-bridge/shared";
import { createRegistryKeepAlive, type RegistryKeepAliveInput } from "../src/seal/registry-watch.ts";
import { start } from "../src/seal/module.ts";
import type { SealSender } from "../src/seal/seal-watch.ts";
import type { StepService } from "../src/steps/service.ts";
import { makeBackend, makeConfig, memoryLogger } from "./support.ts";
import { fakeChain, REGISTRY_LIGHT_CLIENT, REGISTRY_PAIR, registryProof, registryState, stepProvers } from "./steps-support.ts";

const HASH: Hex = `0x${"ab".repeat(32)}`;
/** One period after slot 1000 of the registry's clock (10 s slots from 0, 8192 slots a period). */
const DUE = (1_000 + 8_192) * 10_000;

const PROOF = { kind: "registry-light-client-update" as const, subject: "369", chainId: 369, lightClient: REGISTRY_LIGHT_CLIENT, programKey: `0x${"88".repeat(32)}`, startSlot: 1_000, startRoot: `0x${"77".repeat(32)}`, newSlot: 1_064, newRoot: `0x${"66".repeat(32)}`, publicValues: "0xabcd", proof: "0x1234", provedAt: 1 };

function watchOf(options: { now?: number; answer?: Awaited<ReturnType<StepService["submit"]>>; proof?: unknown; job?: unknown; readState?: RegistryKeepAliveInput["readState"]; simulate?: RegistryKeepAliveInput["simulate"]; send?: SealSender } = {}) {
  const log = memoryLogger();
  const alerts: string[] = [];
  const submit = vi.fn(async () => options.answer ?? { jobId: "step:1" });
  const service = { submit, wait: vi.fn(async () => {}), proof: () => (options.proof === undefined ? PROOF : options.proof), job: () => options.job ?? null } as unknown as StepService;
  const send = vi.fn<SealSender>(options.send ?? (async () => ({ hash: HASH, success: true })));
  const simulate = vi.fn(options.simulate ?? (async () => 300_000n));
  const watch = createRegistryKeepAlive({
    chainId: 369,
    chainName: "PulseChain",
    pair: "eth-pls",
    now: () => options.now ?? DUE,
    logger: log.logger,
    alert: (text) => alerts.push(text),
    readState: options.readState ?? (async () => registryState()),
    service,
    simulate,
    send,
  });
  return { watch, log, alerts, submit, send, simulate };
}

describe("createRegistryKeepAlive", () => {
  it("posts nothing while the light client is younger than one period, and logs that once", async () => {
    const { watch, log, submit } = watchOf({ now: DUE - 1_000 });
    expect(await watch.check()).toEqual({ kind: "not-needed", headAgeSeconds: 81_919 });
    await watch.check();
    expect(log.lines.filter((line) => line.includes("registry_keepalive_not_needed"))).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("after a period asks the step service as a liveness proof, simulates and sends update()", async () => {
    const { watch, submit, send, simulate, log } = watchOf();
    expect(await watch.check()).toEqual({ kind: "posted", hash: HASH, success: true, newSlot: 1_064 });
    expect(submit).toHaveBeenCalledWith({ kind: "registry-light-client-update", subject: "369", caller: "backend", pair: "eth-pls", liveness: true });
    const call = simulate.mock.calls[0]?.[0] as { to: string; data: Hex };
    expect(call.to).toBe(REGISTRY_LIGHT_CLIENT);
    expect(decodeFunctionData({ abi: beaconLightClientAbi, data: call.data })).toMatchObject({ functionName: "update", args: ["0x1234", "0xabcd"] });
    expect(send).toHaveBeenCalledWith({ ...call, gas: 300_000n });
    expect(log.lines.join("\n")).toContain("registry_keepalive_posted");
  });

  it("waits when the step service refuses, and names the refusal", async () => {
    expect(await watchOf({ answer: { refused: "cannot-check", retryAfterSeconds: 30 } }).watch.check()).toEqual({ kind: "waiting", reason: "cannot-check" });
    expect(await watchOf({ answer: { refused: "not-served", detail: "no prover" } }).watch.check()).toEqual({ kind: "waiting", reason: "not-served: no prover" });
    expect(await watchOf({ answer: { invalid: "no registry" } }).watch.check()).toEqual({ kind: "waiting", reason: "no registry" });
  });

  it("fails without a proof from the head, with the job's reason when there is one", async () => {
    expect(await watchOf({ proof: null }).watch.check()).toEqual({ kind: "failed", stage: "prove", error: "no proof from the light client's head" });
    expect(await watchOf({ proof: { ...PROOF, startSlot: 999 }, job: { error: "the prover stopped with exit code 1" } }).watch.check()).toEqual({ kind: "failed", stage: "prove", error: "the prover stopped with exit code 1" });
    expect(await watchOf({ proof: { kind: "open-deposits" } }).watch.check()).toMatchObject({ kind: "failed", stage: "prove" });
  });

  it("sends nothing when the light client refuses the update (someone posted first)", async () => {
    const { watch, send, log } = watchOf({ simulate: async () => Promise.reject(new Error("HeadNotAdvancing")) });
    expect(await watch.check()).toEqual({ kind: "failed", stage: "simulate", error: "HeadNotAdvancing" });
    expect(send).not.toHaveBeenCalled();
    expect(log.lines.join("\n")).toContain("registry_keepalive_refused");
  });

  it("alerts when the update reverts on chain or cannot be sent, and logs a failed read", async () => {
    const reverted = watchOf({ send: async () => ({ hash: HASH, success: false }) });
    expect(await reverted.watch.check()).toMatchObject({ kind: "posted", success: false });
    expect(reverted.alerts[0]).toContain("reverted on chain");
    const broken = watchOf({ send: async () => Promise.reject(new Error("nonce too low")) });
    expect(await broken.watch.check()).toEqual({ kind: "failed", stage: "send", error: "nonce too low" });
    expect(broken.alerts[0]).toContain("could not be sent (nonce too low)");
    const unread = watchOf({ readState: async () => Promise.reject("rpc down") });
    expect(await unread.watch.check()).toEqual({ kind: "failed", stage: "check", error: "rpc down" });
  });

  it("never runs two checks at once, and logs the not-needed line again after a due check", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let now = DUE;
    const log = memoryLogger();
    const watch = createRegistryKeepAlive({
      chainId: 369,
      chainName: "PulseChain",
      pair: "eth-pls",
      now: () => now,
      logger: log.logger,
      alert: () => {},
      readState: async () => (await held, registryState()),
      service: { submit: async () => ({ refused: "cannot-check", retryAfterSeconds: 1 }) } as unknown as StepService,
      simulate: async () => 1n,
      send: async () => ({ hash: HASH, success: true }),
    });
    const first = watch.check();
    expect(await watch.check()).toBeNull();
    release();
    await first;
    now = DUE - 1_000;
    await watch.check();
    expect(log.lines.filter((line) => line.includes("registry_keepalive_not_needed"))).toHaveLength(1);
  });
});

describe("the seal module keeps the registry's light client alive", () => {
  it("proves through the step service and posts from the seal signer, on a chain with a registry", async () => {
    const backend = makeBackend({ config: makeConfig({ seal: { signer: { kind: "private-key", key: "env:K" }, observation: { enabled: false } } }), enabled: ["seal"] });
    const provers = stepProvers();
    const chain = fakeChain();
    const port = { send: vi.fn(async () => ({ hash: HASH, success: true })), feeQuote: vi.fn(async () => ({ baseFee: 10n, priorityFee: 1n })) };
    const gate: Record<string, unknown> = { mode: 4, enforcing: true, isSealed: true, forkRegistry: REGISTRY_PAIR.sides[1].contracts.forkRegistry };
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => gate[functionName]);
    const estimateGas = vi.fn(async () => 300_000n);
    const context = { ...backend.context, pair: REGISTRY_PAIR, now: () => DUE, stepChain: chain.reads, headProver: provers.headProver, openSealSigner: async () => ({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }) as never };
    // Each timer runs its check once more at once: the second keep-alive check joins the job of the first.
    const stop = await start(context, { client: () => ({ readContract, estimateGas }) as never, port: () => port as never, every: (_milliseconds, check) => (check(), () => {}) });
    await vi.waitFor(() => expect(provers.head.calls).toHaveLength(1));
    provers.head.settle(registryProof());
    await vi.waitFor(() => expect(port.send).toHaveBeenCalled());
    expect(backend.log.lines.join("\n")).toContain('"keepingAlive":[369]');
    await stop();
  });

  it("keeps nothing alive when switched off, or without the head prover", async () => {
    for (const [registryKeepAlive, withProver] of [[{ enabled: false }, true], [{}, false]] as const) {
      const backend = makeBackend({ config: makeConfig({ seal: { signer: { kind: "private-key", key: "env:K" }, observation: { enabled: false }, registryKeepAlive } }), enabled: ["seal"] });
      const readContract = vi.fn(async () => true);
      const context = { ...backend.context, pair: REGISTRY_PAIR, ...(withProver ? { headProver: stepProvers().headProver } : {}), openSealSigner: async () => ({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }) as never };
      const stop = await start(context, { client: () => ({ readContract }) as never, port: () => ({}) as never, every: () => () => {} });
      await stop();
      expect(backend.log.lines.join("\n")).toContain('"keepingAlive":[]');
    }
  });
});
