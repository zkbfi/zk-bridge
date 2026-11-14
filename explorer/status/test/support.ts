import { vi } from "vitest";
import type { Pair } from "@zk-bridge/shared";
import { parseStatusConfig } from "../src/config.ts";
import type { ChainClient, Deps } from "../src/deps.ts";

export const addr = (digit: string): `0x${string}` => `0x${digit.repeat(40)}`;

export const pair: Pair = {
  name: "sepolia-pls943",
  sides: [
    {
      name: "sepolia",
      chainId: 11155111,
      rpcUrl: "https://rpc-a.example.org/key-a",
      beaconUrl: "https://beacon-a.example.org/key-a",
      startBlock: 1,
      finalitySeconds: 768,
      contracts: { bridge: addr("1"), mediator: addr("2"), tokenFactory: addr("3"), wrappedNative: addr("4"), gate: addr("5"), lightClient: addr("6"), deliveryRouter: null, forkRegistry: null },
    },
    {
      name: "pulsechain-testnet-v4",
      chainId: 943,
      rpcUrl: "https://rpc-b.example.org/key-b",
      beaconUrl: "https://beacon-b.example.org/key-b",
      startBlock: 2,
      finalitySeconds: 768,
      contracts: { bridge: addr("a"), mediator: addr("b"), tokenFactory: addr("c"), wrappedNative: addr("d"), gate: addr("e"), lightClient: addr("f"), deliveryRouter: null, forkRegistry: null },
    },
  ],
};

export const config = parseStatusConfig(
  JSON.stringify({
    schemaVersion: 1,
    databasePath: ":memory:",
    pair: "sepolia-pls943",
    deploymentFile: "/x",
    chains: {
      "11155111": { label: "Sepolia", symbol: "ETH", rpcUrl: "https://rpc-a.example.org/key-a", beaconUrl: "https://beacon-a.example.org/key-a" },
      "943": { label: "PulseChain testnet", symbol: "tPLS", rpcUrl: "https://rpc-b.example.org/key-b", beaconUrl: "https://beacon-b.example.org/key-b" },
    },
    runpod: { endpoints: [{ id: "ep1", label: "gpu-24gb" }, { id: "ep2", label: "gpu-32gb" }], apiKey: "rp_key" },
    wallets: [{ name: "runner", address: addr("9"), low: { "11155111": "0.05", "943": "1000" } }],
  }),
);

export type Reply = { status?: number; body?: unknown; text?: string; ms?: number; throws?: string };

/** A fetch that answers by URL (a string key, or the first key that the URL starts with). It moves the clock by `ms`. */
export function fakeFetch(routes: Record<string, Reply | ((url: string, init?: RequestInit) => Reply)>, clock: { now: number }): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((candidate) => url === candidate || url.startsWith(candidate));
    if (key === undefined) throw new Error(`unexpected request ${url}`);
    const route = routes[key] as Reply | ((url: string, init?: RequestInit) => Reply);
    const reply = typeof route === "function" ? route(url, init) : route;
    clock.now += reply.ms ?? 5;
    if (reply.throws !== undefined) throw new Error(reply.throws);
    const body = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(body, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
}

export function makeDeps(overrides: Partial<Deps> & { clock?: { now: number } } = {}): Deps & { clock: { now: number } } {
  const clock = overrides.clock ?? { now: 1_800_000_000_000 };
  return {
    config,
    pair,
    fetch: fakeFetch({}, clock),
    now: () => clock.now,
    exec: async () => "",
    client: () => ({}) as ChainClient,
    memory: new Map(),
    apiKey: "rp_key",
    requestTimeoutMilliseconds: 1000,
    ...overrides,
    clock,
  };
}
