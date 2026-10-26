import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyProverSetup, saveProverSetup, type ProverSetup } from "@zk-bridge/shared/config";
import { BotConfigError } from "../../src/config/bot-config.ts";
import { loadBotContext, sidesOfDirection } from "../../src/runtime/context.ts";

// Made-up values with the real shapes. None is a live key.
const VALVE_KEY = "vk_TESTONLY0987654321zyxwvu";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function section(chainId: number, seed: number) {
  const address = (offset: number) => `0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`;
  return { chain_id: chainId, bridge: address(1), mediator: address(2), token_factory: address(3), native_router: address(4), wrapped_native: address(5), gate: address(6), light_client: address(7), fee_router: address(8), start_block: 5 };
}

async function files(setup: ProverSetup, config: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bots-context-"));
  scratch.push(directory);
  const setupFile = join(directory, "prover-setup.json");
  const deploymentFile = join(directory, "deployment.json");
  const configPath = join(directory, "bots.json");
  await saveProverSetup(setupFile, setup);
  await writeFile(deploymentFile, JSON.stringify({ chain_a: section(1, 0x10), chain_b: section(369, 0x20) }));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, stateDirectory: join(directory, "state"), setupFile, deploymentFile, ...config }));
  return { configPath, directory };
}

describe("loading the context", () => {
  it("builds the pair from the endpoints of the setup file, resolved through references, and redacts them in the log", async () => {
    const setup: ProverSetup = {
      ...emptyProverSetup(),
      chains: {
        "1": { rpc: { source: "environment", variable: "ETH_RPC" }, beacon: { source: "environment", variable: "ETH_BEACON" } },
        "369": { rpc: { source: "environment", variable: "PLS_RPC" }, beacon: { source: "environment", variable: "PLS_BEACON" } },
      },
    };
    const { configPath } = await files(setup);
    const lines: string[] = [];
    const context = await loadBotContext({
      configPath,
      environment: {
        ETH_RPC: `https://one.valve.city/rpc/${VALVE_KEY}/evm/1`,
        ETH_BEACON: "http://127.0.0.1:5052",
        PLS_RPC: `https://one.valve.city/rpc/${VALVE_KEY}/evm/369`,
        PLS_BEACON: "http://127.0.0.1:5053",
      },
      write: (line) => lines.push(line),
    });
    expect(context.pair.sides[0].rpcUrl).toContain(VALVE_KEY);
    expect(context.pair.sides[1].beaconUrl).toBe("http://127.0.0.1:5053");
    expect(context.pair.sides[1].contracts.feeRouter).toBe(`0x${"28".repeat(20)}`);
    context.logger.info("connected", { rpc: context.pair.sides[0].rpcUrl });
    expect(lines.join("\n")).not.toContain(VALVE_KEY);
  });

  it("falls back to the variables of the indexer when the setup file names no endpoint", async () => {
    const { configPath } = await files(emptyProverSetup());
    const context = await loadBotContext({
      configPath,
      environment: { EXPLORER_RPC_URL_1: "http://127.0.0.1:1", EXPLORER_RPC_URL_369: "http://127.0.0.1:2" },
      write: () => undefined,
    });
    expect(context.pair.sides[0].rpcUrl).toBe("http://127.0.0.1:1");
  });

  it("names the missing deployment file", async () => {
    const { configPath } = await files(emptyProverSetup(), { deploymentFile: undefined });
    await expect(loadBotContext({ configPath, environment: {}, write: () => undefined })).rejects.toThrow(BotConfigError);
  });

  it("names a configuration file that cannot be read", async () => {
    await expect(loadBotContext({ configPath: "/nonexistent/bots.json", environment: {}, write: () => undefined })).rejects.toThrow(/Cannot read the bot configuration/);
  });

  it("puts the light client on the destination side of each direction", async () => {
    const { configPath } = await files(emptyProverSetup());
    const context = await loadBotContext({ configPath, environment: { EXPLORER_RPC_URL_1: "http://127.0.0.1:1", EXPLORER_RPC_URL_369: "http://127.0.0.1:2" }, write: () => undefined });
    expect(sidesOfDirection(context.pair, "first-to-second")).toMatchObject({ source: { chainId: 1 }, destination: { chainId: 369 } });
    expect(sidesOfDirection(context.pair, "second-to-first")).toMatchObject({ source: { chainId: 369 }, destination: { chainId: 1 } });
  });
});
