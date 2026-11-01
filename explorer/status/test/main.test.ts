import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main, parseArguments } from "../src/main.ts";
import type { ChainClient } from "../src/deps.ts";

const deployment = {
  chain_a: { chain_id: 11155111, bridge: "0x" + "1".repeat(40), mediator: "0x" + "2".repeat(40), token_factory: "0x" + "3".repeat(40), wrapped_native: "0x" + "4".repeat(40), gate: "0x" + "5".repeat(40), light_client: "0x" + "6".repeat(40), start_block: 1 },
  chain_b: { chain_id: 943, bridge: "0x" + "a".repeat(40), mediator: "0x" + "b".repeat(40), token_factory: "0x" + "c".repeat(40), wrapped_native: "0x" + "d".repeat(40), gate: "0x" + "e".repeat(40), light_client: "0x" + "f".repeat(40), start_block: 2 },
};

function files(extra: object = {}) {
  const directory = mkdtempSync(join(tmpdir(), "status-"));
  writeFileSync(join(directory, "deployment.json"), JSON.stringify(deployment));
  const config = {
    schemaVersion: 1,
    listen: { host: "127.0.0.1", port: 0 },
    databasePath: join(directory, "data", "status.sqlite"),
    pair: "sepolia-pls943",
    deploymentFile: join(directory, "deployment.json"),
    intervalSeconds: 60,
    chains: {
      "11155111": { label: "Sepolia", symbol: "ETH", rpcUrl: "env:RPC_A", beaconUrl: "env:BEACON_A" },
      "943": { label: "PulseChain testnet", symbol: "tPLS", rpcUrl: "env:RPC_B" },
    },
    services: {
      indexerLocal: "http://127.0.0.1:1",
      indexerPublic: "http://127.0.0.1:1",
      backendLocal: "http://127.0.0.1:1",
      backendPublic: "http://127.0.0.1:1",
      webhookPublic: "http://127.0.0.1:1",
      gateway: "http://127.0.0.1:1",
      sites: { next: "http://127.0.0.1:1", main: "http://127.0.0.1:1" },
    },
    units: [{ name: "zk-bridge-backend" }],
    ...extra,
  };
  writeFileSync(join(directory, "status.json"), JSON.stringify(config));
  return join(directory, "status.json");
}
const environment = { RPC_A: "https://rpc-a.example.org/hunter2-key-a", BEACON_A: "https://beacon-a.example.org/k", RPC_B: "https://rpc-b.example.org/k", RUNPOD: "rp_key" };

describe("parseArguments", () => {
  it("reads --config and refuses anything else", () => {
    expect(parseArguments(["--config", "/x.json"])).toEqual({ configPath: "/x.json" });
    expect(() => parseArguments([])).toThrow(/--config/);
    expect(() => parseArguments(["--config"])).toThrow(/needs a value/);
    expect(() => parseArguments(["--other", "1"])).toThrow(/unknown argument/);
  });
});

describe("main", () => {
  it("runs the checks, serves the API and stops on the signal", async () => {
    const lines: string[] = [];
    const stop = new AbortController();
    let port = 0;
    const client = { getBlock: async () => { throw new Error("no chain here"); } } as unknown as ChainClient;
    const exit = main(["--config", files({ runpod: { endpointId: "ep", apiKey: "env:RUNPOD" } })], environment, {
      stopSignal: stop.signal,
      write: (line) => lines.push(line),
      fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      exec: async () => "LoadState=loaded\nActiveState=active\nSubState=running",
      client: () => client,
      onListening: (value) => (port = value),
    });
    await expect.poll(() => port).toBeGreaterThan(0);
    await expect.poll(async () => (await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()).checks, { timeout: 5000 }).toBeGreaterThan(5);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    expect(JSON.stringify(status)).not.toContain("hunter2-key-a");
    expect(status.sections.flatMap((section: { checks: unknown[] }) => section.checks).length).toBeGreaterThan(10);
    stop.abort();
    expect(await exit).toBe(0);
    expect(lines.some((line) => line.includes("status_started"))).toBe(true);
    expect(lines.join("\n")).not.toContain("hunter2-key-a");
  });

  it("stops at once when the signal has already fired", async () => {
    const stop = new AbortController();
    stop.abort();
    const exit = await main(["--config", files()], environment, { stopSignal: stop.signal, write: () => {}, fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch, exec: async () => "" });
    expect(exit).toBe(0);
  });

  it("returns 1 with a message that holds no secret when the configuration is wrong", async () => {
    const lines: string[] = [];
    expect(await main([], environment, { write: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toContain("--config");
    const missing = await main(["--config", files()], { ...environment, RPC_A: undefined }, { write: (line) => lines.push(line) });
    expect(missing).toBe(1);
    expect(lines[1]).toContain("RPC_A");
  });

  it.each(["SIGTERM", "SIGINT"] as const)("uses the process signals, the real clients, fetch and exec and stderr when nothing is overridden (%s)", async (signal) => {
    const written = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let port = 0;
    // Every endpoint is a port where nothing listens: the reads fail at once and no request leaves the machine.
    const local = { ...environment, RPC_A: "http://127.0.0.1:1/a", RPC_B: "http://127.0.0.1:1/b" };
    const exit = main(["--config", files()], local, { onListening: (value) => (port = value) });
    await expect.poll(() => port).toBeGreaterThan(0);
    process.emit(signal);
    expect(await exit).toBe(0);
    expect(written.mock.calls.some(([line]) => String(line).includes("status_started"))).toBe(true);
    expect(await main([], local)).toBe(1);
    expect(written.mock.calls.some(([line]) => String(line).includes("zk-bridge-status: "))).toBe(true);
    written.mockRestore();
  });
});
