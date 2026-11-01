import { describe, expect, it } from "vitest";
import { runpodCheck } from "../src/checks/prover.ts";
import { walletChecks } from "../src/checks/wallets.ts";
import type { ChainClient } from "../src/deps.ts";
import { addr, fakeFetch, makeDeps } from "./support.ts";

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
  const url = "https://rest.runpod.io/v1/endpoints/ep1?includeWorkers=true";
  const check = runpodCheck;

  it("reads the endpoint through the REST API with the key, and reports workers and GPUs", async () => {
    const c = { now: 1 };
    let seen: RequestInit | undefined;
    const fetch = fakeFetch({ [url]: (_u, init) => ((seen = init), { body: { id: "ep1", workersMin: 0, workersMax: 2, gpuTypeIds: ["NVIDIA RTX A6000", "NVIDIA L40S"], workers: [{ id: "w1" }] } }) }, c);
    const deps = makeDeps({ clock: c, fetch });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "1 worker running now (min 0, max 2), GPUs NVIDIA RTX A6000, NVIDIA L40S" });
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer rp_key");
  });

  it("handles an endpoint with no workers listed and no GPU list", async () => {
    const c = { now: 1 };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [url]: { body: { workersMin: 1, workersMax: 1 } } }, c) });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "0 workers running now (min 1, max 1), no GPU list" });
  });

  it("shows no minimum as zero", async () => {
    const c = { now: 1 };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [url]: { body: { workersMax: 3, workers: [{}, {}] } } }, c) });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "2 workers running now (min 0, max 3), no GPU list" });
  });

  it("is down when RunPod refuses the key or cannot find the endpoint, and degraded when it cannot prove", async () => {
    const c = { now: 1 };
    expect(await check.run(makeDeps({ clock: c, fetch: fakeFetch({ [url]: { status: 401 } }, c) }))).toEqual({ state: "down", detail: "RunPod refused the API key (401)" });
    expect(await check.run(makeDeps({ clock: c, fetch: fakeFetch({ [url]: { status: 404 } }, c) }))).toEqual({ state: "down", detail: "RunPod has no endpoint with this id (404)" });
    expect(await check.run(makeDeps({ clock: c, fetch: fakeFetch({ [url]: { status: 500 } }, c) }))).toEqual({ state: "down", detail: "RunPod answered 500" });
    expect(await check.run(makeDeps({ clock: c, fetch: fakeFetch({ [url]: { body: { workersMin: 0, workersMax: 0, workers: [] } } }, c) }))).toEqual({
      state: "degraded",
      detail: "the largest number of workers is 0, so it cannot prove (min 0, max 0)",
    });
    expect(await check.run(makeDeps({ clock: c, fetch: fakeFetch({ [url]: { text: "oops" } }, c) }))).toEqual({ state: "degraded", detail: "RunPod answered something that is not an endpoint" });
  });
});
