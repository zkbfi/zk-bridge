import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProverSetup, saveProverSetup, type ProverSetup } from "@zk-bridge/shared/config";
import { loadBotContext, type BotContext } from "../../src/runtime/context.ts";
import { PROGRAM_KEY, proofMessage } from "./builders.ts";

function section(chainId: number, seed: number) {
  const address = (offset: number) => `0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`;
  return { chain_id: chainId, bridge: address(1), mediator: address(2), token_factory: address(3), native_router: address(4), wrapped_native: address(5), gate: address(6), light_client: address(7), delivery_router: address(8), start_block: 5 };
}

function withoutRouter(deployment: ReturnType<typeof section>, options: ServiceWorldOptions) {
  if (options.omitDeliveryRouter !== true) return deployment;
  const { delivery_router: _omitted, ...rest } = deployment;
  return rest;
}

/** The directory that a world keeps its files in, and the context loaded from them. */
export interface ServiceWorld {
  readonly context: BotContext;
  readonly directory: string;
  readonly logLines: string[];
  readonly events: () => Array<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

/** What {@link createServiceWorld} changes from the defaults. */
export interface ServiceWorldOptions {
  readonly setup?: Partial<ProverSetup>;
  /** Replaces whole sections of the bot configuration. */
  readonly config?: Record<string, unknown>;
  readonly environment?: Record<string, string | undefined>;
  /** Leave the delivery router out of the deployment file, as a deployment without a router does. */
  readonly omitDeliveryRouter?: boolean;
}

/**
 * Writes a setup file, a deployment file and a bot configuration into a scratch directory, and loads the context from
 * them, as the command line does. The pair is `eth-pls` with chains 1 and 369.
 */
export async function createServiceWorld(options: ServiceWorldOptions = {}): Promise<ServiceWorld> {
  const directory = await mkdtemp(join(tmpdir(), "bots-service-"));
  const setupFile = join(directory, "prover-setup.json");
  const deploymentFile = join(directory, "deployment.json");
  const configPath = join(directory, "bots.json");
  await saveProverSetup(setupFile, { ...emptyProverSetup(), ...options.setup });
  await writeFile(deploymentFile, JSON.stringify({ chain_a: withoutRouter(section(1, 0x10), options), chain_b: withoutRouter(section(369, 0x20), options) }));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, stateDirectory: join(directory, "state"), setupFile, deploymentFile, logLevel: "debug", ...options.config }));
  const logLines: string[] = [];
  const context = await loadBotContext({
    configPath,
    environment: {
      EXPLORER_RPC_URL_1: "http://127.0.0.1:1",
      EXPLORER_RPC_URL_369: "http://127.0.0.1:2",
      EXPLORER_BEACON_URL_1: "http://127.0.0.1:3",
      EXPLORER_BEACON_URL_369: "http://127.0.0.1:4",
      ...options.environment,
    },
    write: (line) => logLines.push(line),
    now: () => new Date(0),
  });
  return {
    context,
    directory,
    logLines,
    events: () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** The proof package that the prover prints for an update from `startSlot` to `newSlot`, as JSON text. */
export function proofPackageJson(startSlot = 100n, newSlot = 164n): string {
  const message = proofMessage({ startSlot, newSlot });
  return JSON.stringify({
    schemaVersion: 1,
    route: "ethereum_to_pulsechain",
    programKey: PROGRAM_KEY,
    startHeadSlot: Number(startSlot),
    startHeadRoot: message.startRoot,
    newHeadSlot: Number(newSlot),
    newHeadRoot: message.newRoot,
    latestFinalizedSlot: Number(newSlot),
    publicValues: message.publicValues,
    proof: message.proof,
    updateCalldata: "0x",
    backend: "remote",
    createdAt: "2026-10-25T00:00:00Z",
  });
}
