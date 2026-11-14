import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, toFunctionSelector } from "viem";
import * as rpcProxy from "../src/rpc-proxy/module.ts";
import { DEFAULT_RPC_CHAINS, DEFAULT_RPC_METHODS, MULTICALL3_ADDRESS } from "../src/rpc-proxy/settings.ts";
import { parseBackendConfig } from "../src/config.ts";
import { makeBackend, makeConfig } from "./support.ts";

const GATE = "0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3";
const REGISTRY = "0x0f094a965f280599b41f57a5182955f4afad063f";
const REGISTRY_LIGHT_CLIENT = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x6666666666666666666666666666666666666666";
const OUTSIDER = "0x7777777777777777777777777777777777777777";
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function deploymentFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "rpc-proxy-"));
  directories.push(directory);
  const file = join(directory, "deployment.json");
  writeFileSync(file, JSON.stringify({ chain_b: { chain_id: 943, bridge: "0x5897d3de91d59fb691e3887d6ffbba072384293a", gate: GATE, fork_registry: REGISTRY } }));
  return file;
}

type Sent = { url: string; headers: Record<string, string>; body: unknown };

/** eRPC and the indexer on the network. `down` makes both fail. */
function fakeNetwork() {
  const sent: Sent[] = [];
  const state = { down: false, erpcStatus: 200 };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (state.down) throw new TypeError("fetch failed");
    if (url === "http://indexer.test/api/tokens") return Response.json({ tokens: [{ chainId: 943, address: TOKEN }] });
    const body = JSON.parse(String(init?.body)) as unknown;
    sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    if (state.erpcStatus !== 200) return new Response("busy", { status: state.erpcStatus });
    const entries = (Array.isArray(body) ? body : [body]) as { id: number; method: string; params?: [{ to: string; data: string }] }[];
    const results = entries.map((entry) => {
      const view = entry.params?.[0];
      const isRegistryView = entry.method === "eth_call" && view?.to === REGISTRY && view.data === toFunctionSelector("lightClient()");
      return { jsonrpc: "2.0", id: entry.id, result: isRegistryView ? word(REGISTRY_LIGHT_CLIENT) : "0x1" };
    });
    return Response.json(Array.isArray(body) ? results : results[0]);
  });
  return { sent, state };
}

const config = (overrides: Record<string, unknown> = {}) =>
  makeConfig({ deploymentFile: deploymentFile(), indexerUrl: "http://indexer.test", trustForwardedHeader: true, modules: ["rpc-proxy"], ...overrides });

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const balanceCall = (to: string) => ({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OUTSIDER, 1n] }) }, "latest"] });

describe("the rpc-proxy settings", () => {
  it("serves the four chains with the dapp's methods by default, and refuses an upstream without {chainId}", () => {
    const settings = makeConfig().rpcProxy;
    expect(Object.keys(settings.chains).sort()).toEqual(["1", "11155111", "369", "943"]);
    expect(settings.chains).toEqual(DEFAULT_RPC_CHAINS);
    expect(settings.methods).toEqual(DEFAULT_RPC_METHODS);
    expect(settings.multicall3).toBe(MULTICALL3_ADDRESS);
    expect(settings.maxBatchLength).toBe(50);
    expect(() => makeConfig({ rpcProxy: { upstreamUrl: "http://127.0.0.1:8792/zkb/evm/943" } })).toThrow(/must hold \{chainId\}/);
    expect(settings.maxCallGas).toBe(30_000_000);
  });

  it("takes any-address functions with static arguments only, so each has one exact length", () => {
    expect(makeConfig({ rpcProxy: { anyAddressFunctions: ["f(uint256,bytes32,bool)", "g()"] } }).rpcProxy.anyAddressFunctions).toHaveLength(2);
    for (const signature of ["name(string)", "f(bytes)", "f(uint256[])", "f((address))", "f(uint7)"]) {
      expect(() => makeConfig({ rpcProxy: { anyAddressFunctions: [signature] } })).toThrow(/static arguments/);
    }
  });

  it("the server's example runs the module against eRPC on its local port", () => {
    const text = readFileSync(new URL("../../../deploy/app-server/config/backend/backend.json.example", import.meta.url), "utf8");
    const parsed = parseBackendConfig(text);
    expect(parsed.modules).toContain("rpc-proxy");
    expect(parsed.rpcProxy.upstreamUrl).toBe("http://127.0.0.1:8792/zkb/evm/{chainId}");
  });
});

describe("POST /rpc/:chainId", () => {
  it("answers 404 for a chain it does not serve and for a path that is no chain id", async () => {
    fakeNetwork();
    const { app } = makeBackend({ config: config(), enabled: ["rpc-proxy"] });
    for (const path of ["/rpc/10", "/rpc/0x1", "/rpc/abc"]) {
      const response = await app.request(path, post({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "rpc.zkb.fi serves the chains 1, 369, 943, 11155111" });
    }
  });

  it("refuses a body over the limit with 413, and sets the CORS header on every answer", async () => {
    fakeNetwork();
    const { app } = makeBackend({ config: config({ rpcProxy: { maxBodyBytes: 1024 } }), enabled: ["rpc-proxy"] });
    const response = await app.request("/rpc/943", post({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: ["x".repeat(2000)] }));
    expect(response.status).toBe(413);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ id: null, error: { code: -32600, message: "rpc.zkb.fi refused the body: it is larger than 1024 bytes" } });
  });

  it("passes a read to eRPC for the chain, with the visitor's address from the forwarded header", async () => {
    const network = fakeNetwork();
    const { app, context } = makeBackend({ config: config(), enabled: ["rpc-proxy"] });
    const response = await app.request("/rpc/11155111", post({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, { "x-forwarded-for": "198.51.100.1, 203.0.113.9" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    expect(network.sent[0]).toMatchObject({ url: "http://127.0.0.1:8792/zkb/evm/11155111", headers: { "x-forwarded-for": "203.0.113.9" } });
    // An IPv6 visitor is counted by its /64 network; an unknown one sends no header.
    await app.request("/rpc/943", post({ jsonrpc: "2.0", id: 2, method: "eth_chainId" }, { "x-forwarded-for": "2001:db8:1:2:3:4:5:6" }));
    expect(network.sent[1]?.headers["x-forwarded-for"]).toBe("2001:db8:1:2::");
    await app.request("/rpc/943", post({ jsonrpc: "2.0", id: 3, method: "eth_chainId" }, { "x-forwarded-for": "not an address" }));
    expect(network.sent[2]?.headers["x-forwarded-for"]).toBeUndefined();
    expect(rpcProxy.health(context).detail).toBe("3 served, 0 refused, 0 invalid, 0 without an answer from eRPC; contracts+tokens by chain 1: 0+0, 369: 0+0, 943: 0+0, 11155111: 0+0; last refresh not yet");
  });

  it("knows no zkb.fi contract before start, and after start the deployment's, the registry's light client and the indexer's tokens", async () => {
    const network = fakeNetwork();
    const { app, context } = makeBackend({ config: config(), enabled: ["rpc-proxy"] });
    const send = async (to: string) => (await (await app.request("/rpc/943", post(balanceCall(to)))).json()) as { error?: { code: number } };
    expect((await send(GATE)).error?.code).toBe(-32602);
    const stop = await rpcProxy.start(context);
    for (const to of [GATE, REGISTRY_LIGHT_CLIENT]) expect((await send(to)).error).toBeUndefined();
    // The indexer's token: its Transfer logs pass, any other call to it does not.
    expect((await send(TOKEN)).error?.code).toBe(-32602);
    const transferLogs = { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ address: TOKEN, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] }] };
    expect(((await (await app.request("/rpc/943", post(transferLogs))).json()) as { error?: unknown }).error).toBeUndefined();
    expect((await send(OUTSIDER)).error?.code).toBe(-32602);
    // The refresh read the gate and registry views through eRPC, from the backend itself (no forwarded header).
    expect(network.sent[0]).toMatchObject({ url: "http://127.0.0.1:8792/zkb/evm/943", headers: { "content-type": "application/json" } });
    expect(rpcProxy.health(context).detail).toMatch(/3 served, 3 refused, 0 invalid, 0 without an answer from eRPC; contracts\+tokens by chain 1: 1\+0, 369: 4\+0, 943: 5\+1, 11155111: 1\+0; last refresh ok$/);
    await stop();
  });

  it("logs and counts an answer that eRPC could not give", async () => {
    const network = fakeNetwork();
    const { app, context, log } = makeBackend({ config: config(), enabled: ["rpc-proxy"] });
    network.state.down = true;
    const response = await app.request("/rpc/943", post({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }));
    expect(response.status).toBe(502);
    expect(log.lines.some((line) => line.includes("rpc_proxy_upstream_failed"))).toBe(true);
    expect(rpcProxy.health(context).detail).toMatch(/^0 served, 0 refused, 0 invalid, 1 without an answer from eRPC/);
  });
});

describe("the refresh", () => {
  it("tries again after 30 seconds when a source failed, then waits refreshSeconds, and stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const network = fakeNetwork();
    network.state.erpcStatus = 503;
    const { context, log } = makeBackend({ config: config({ rpcProxy: { refreshSeconds: 600 } }), enabled: ["rpc-proxy"] });
    const stop = await rpcProxy.start(context);
    expect(rpcProxy.health(context).detail).toMatch(/last refresh failed \(chain 943: the node answered 503\)$/);
    expect(log.lines.some((line) => line.includes("rpc_proxy_refresh_failed"))).toBe(true);
    const reads = () => network.sent.length;
    const before = reads();
    network.state.erpcStatus = 200;
    await vi.advanceTimersByTimeAsync(rpcProxy.RETRY_MILLISECONDS);
    expect(reads()).toBeGreaterThan(before);
    expect(rpcProxy.health(context).detail).toMatch(/last refresh ok$/);
    const afterRetry = reads();
    await vi.advanceTimersByTimeAsync(rpcProxy.RETRY_MILLISECONDS);
    expect(reads()).toBe(afterRetry);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(reads()).toBeGreaterThan(afterRetry);
    await stop();
    const stopped = reads();
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(reads()).toBe(stopped);
  });

  it("reads the deployment files of the settings, and no tokens without an indexer", async () => {
    const network = fakeNetwork();
    const file = deploymentFile();
    const { context } = makeBackend({ config: config({ indexerUrl: undefined, rpcProxy: { deploymentFiles: [file], chains: { "943": {} } } }), enabled: ["rpc-proxy"] });
    const stop = await rpcProxy.start(context);
    expect(rpcProxy.health(context).detail).toMatch(/contracts\+tokens by chain 943: 5\+0; last refresh ok$/);
    expect(network.sent.every((sent) => !sent.url.includes("indexer"))).toBe(true);
    await stop();
  });

  it("stops at once when stopped during a refresh, and throws at start for a deployment file that cannot be read", async () => {
    fakeNetwork();
    const { context } = makeBackend({ config: config(), enabled: ["rpc-proxy"] });
    const stop = await rpcProxy.start(context);
    await stop();
    const missing = makeBackend({ config: config({ rpcProxy: { deploymentFiles: ["/nowhere/deployment.json"] } }), enabled: ["rpc-proxy"] });
    await expect(rpcProxy.start(missing.context)).rejects.toThrow(/ENOENT/);
  });
});
