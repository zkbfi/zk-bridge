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
  const url = "https://api.runpod.io/graphql";
  const check = runpodCheck;
  const row = (extra: object) => ({ id: "ep1", name: "n", workersMin: 0, workersMax: 2, gpuIds: "ADA_24, AMPERE_24", pods: [{ desiredStatus: "RUNNING" }, { desiredStatus: "EXITED" }], ...extra });
  const answer = (...rows: Array<object | null>) => ({ body: { data: { myself: { endpoints: rows } } } });
  const row2 = { id: "ep2", workersMin: 1, workersMax: 3, gpuIds: "ADA_32", pods: [] };

  it("asks GraphQL once with the key for all endpoints, and reports each one", async () => {
    const c = { now: 1 };
    let seen: RequestInit | undefined;
    const fetch = fakeFetch({ [url]: (_u, init) => ((seen = init), answer(row({}), row2)) }, c);
    const deps = makeDeps({ clock: c, fetch });
    expect(await check.run(deps)).toEqual({
      state: "ok",
      detail: "gpu-24gb: 1 running now (min 0, max 2), GPUs ADA_24, AMPERE_24; gpu-32gb: 0 running now (min 1, max 3), GPUs ADA_32",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen?.method).toBe("POST");
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer rp_key");
    expect(String(seen?.body)).toContain("myself");
  });

  it("handles missing pods, minimum and GPU list", async () => {
    const c = { now: 1 };
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [url]: answer({ id: "ep1", workersMax: 3 }, { id: "ep2", workersMax: 1, gpuIds: "", pods: null }) }, c) });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "gpu-24gb: 0 running now (min 0, max 3), no GPU list; gpu-32gb: 0 running now (min 0, max 1), no GPU list" });
  });

  it("is degraded when an endpoint cannot prove or is missing, naming it", async () => {
    const c = { now: 1 };
    const zero = makeDeps({ clock: c, fetch: fakeFetch({ [url]: answer(row({ workersMax: 0 }), row2) }, c) });
    expect(await check.run(zero)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-24gb: the largest number of workers is 0, so it cannot prove (min 0, max 0); gpu-32gb: 0 running") });
    const unset = makeDeps({ clock: c, fetch: fakeFetch({ [url]: answer(row({}), { id: "ep2" }) }, c) });
    expect(await check.run(unset)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-32gb: the largest number of workers is 0") });
    const missing = makeDeps({ clock: c, fetch: fakeFetch({ [url]: answer(row({}), null) }, c) });
    expect(await check.run(missing)).toEqual({ state: "degraded", detail: expect.stringContaining("gpu-32gb: not in the RunPod answer") });
    const odd = makeDeps({ clock: c, fetch: fakeFetch({ [url]: { body: { data: { myself: null } } } }, c) });
    expect(await check.run(odd)).toEqual({ state: "degraded", detail: "RunPod answered something that is not a list of endpoints" });
    const text = makeDeps({ clock: c, fetch: fakeFetch({ [url]: { text: "oops" } }, c) });
    expect((await check.run(text)).state).toBe("degraded");
  });

  it("is down on a refused key, an HTTP error or GraphQL errors", async () => {
    const c = { now: 1 };
    const run = (reply: object) => check.run(makeDeps({ clock: c, fetch: fakeFetch({ [url]: reply }, c) }));
    expect(await run({ status: 401 })).toEqual({ state: "down", detail: "RunPod refused the API key (401)" });
    expect(await run({ status: 403 })).toEqual({ state: "down", detail: "RunPod refused the API key (403)" });
    expect(await run({ status: 429 })).toEqual({ state: "down", detail: "RunPod answered 429" });
    expect(await run({ body: { errors: [{ message: "bad field" }] } })).toEqual({ state: "down", detail: "RunPod GraphQL error: bad field" });
    expect(await run({ body: { errors: [null] } })).toEqual({ state: "down", detail: "RunPod GraphQL error: no message" });
  });
});
