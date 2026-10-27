import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeProofMessage, loadPair, proofCategory } from "@zk-bridge/shared";
import type { Hex } from "viem";
import type { BoardPublisher } from "../../src/msgboard/board.ts";
import { executeCommand } from "../../src/prover/execute-command.ts";
import { createProverBinary } from "../../src/prover/prover-binary.ts";
import { createBinaryProofSource } from "../../src/publisher/proof-source.ts";
import { runPublisherStep, type PublisherDependencies } from "../../src/publisher/publisher.ts";
import { INITIAL_PUBLISHER_STATE, publisherStateSchema } from "../../src/publisher/state.ts";
import { createStateFile } from "../../src/runtime/state-file.ts";
import { PROGRAM_KEY, fakeLightClient, memoryLogger, proofMessage, word } from "../support/builders.ts";

const FAKE_PROVER = new URL("../support/fake-prover.mjs", import.meta.url).pathname;
// Made-up values with the real shapes. None is a live key.
const RUNPOD_KEY = "rpa_TESTONLY1234567890abcdefghijkl";
const KEY_VARIABLE = "RUNPOD_API_KEY";
const NOW = 1_800_000_000_000;

const deployment = {
  chain_a: section(1, 0x10),
  chain_b: section(369, 0x20),
};
function section(chainId: number, seed: number) {
  const address = (offset: number) => `0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`;
  return {
    chain_id: chainId,
    bridge: address(1),
    mediator: address(2),
    token_factory: address(3),
    wrapped_native: address(5),
    gate: address(6),
    light_client: address(7),
    start_block: 5,
  };
}
const pair = loadPair({
  environment: {
    EXPLORER_RPC_URL_1: "http://127.0.0.1:1/rpc/vk_TESTONLY0987654321zyxwvu/evm/1",
    EXPLORER_RPC_URL_369: "http://127.0.0.1:2/rpc/vk_TESTONLY0987654321zyxwvu/evm/369",
    EXPLORER_BEACON_URL_1: "http://127.0.0.1:3",
    EXPLORER_BEACON_URL_369: "http://127.0.0.1:4",
  },
  deployment,
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "publisher-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The package that the prover prints for an update from `startSlot` to `newSlot`. */
function packageJson(startSlot: bigint, newSlot: bigint): string {
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
    destination: { chainId: 369, lightClient: pair.sides[1].contracts.lightClient },
    createdAt: "2026-10-25T00:00:00Z",
  });
}

type Scenario = { exitCode: number; stdout?: string; stderr?: string };

function setup(options: { name?: string; policy?: { proveWhenTransferWaits: boolean; intervalSeconds: number }; transferWaits?: boolean } = {}) {
  const folder = join(directory, options.name ?? "default");
  mkdirSync(folder, { recursive: true });
  const scenarioPath = join(folder, "scenario.json");
  const logPath = join(folder, "prover-runs.jsonl");
  const statePath = join(folder, "state.json");
  const setScenario = (scenario: Scenario) => writeFileSync(scenarioPath, JSON.stringify({ logPath, keyVariable: KEY_VARIABLE, ...scenario }));
  setScenario({ exitCode: 3 });
  const runs = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const posts: Array<{ category: Hex; payload: Hex }> = [];
  const board: BoardPublisher & { failNext: boolean } = {
    failNext: false,
    async post(input) {
      if (board.failNext) {
        board.failNext = false;
        throw new Error("the board refused the message");
      }
      posts.push(input);
      return { messageHash: word(0xb0 + posts.length), grindMilliseconds: 5 };
    },
  };
  const lightClient = fakeLightClient();
  const { logger, lines } = memoryLogger([RUNPOD_KEY]);
  let clock = NOW;
  const build = (): PublisherDependencies => ({
    pairName: "eth-pls",
    direction: "first-to-second",
    category: proofCategory("eth-pls", "first-to-second"),
    lightClient,
    proofSource: createBinaryProofSource(
      createProverBinary({
        binaryPath: FAKE_PROVER,
        pair,
        executor: executeCommand,
        timeoutMilliseconds: 20_000,
        backend: { kind: "remote", mode: { mode: "load-balancing" }, endpoint: "https://worker.example.org", apiKeyVariable: KEY_VARIABLE },
        proverSecret: { variable: KEY_VARIABLE, value: RUNPOD_KEY },
        baseEnvironment: { PATH: process.env.PATH ?? "" },
        temporaryDirectory: join(folder, "tmp"),
        logger,
      }),
    ),
    board,
    transferWaits: options.transferWaits === undefined ? null : async () => options.transferWaits as boolean,
    state: createStateFile({ path: statePath, schema: publisherStateSchema, initial: INITIAL_PUBLISHER_STATE }),
    policy: options.policy ?? { proveWhenTransferWaits: false, intervalSeconds: 3600 },
    republishSeconds: 600,
    retryBackoffSeconds: 120,
    upToDateWaitSeconds: 120,
    now: () => clock,
    logger,
  });
  return { build, setScenario, runs, posts, board, lightClient, lines, advance: (seconds: number) => (clock += seconds * 1000), statePath };
}

describe("publisher decisions", () => {
  it("does nothing when the prover says there is nothing to prove, and does not ask again at once", async () => {
    const s = setup();
    const dependencies = s.build();
    expect(await runPublisherStep(dependencies)).toEqual({ action: "nothing-to-prove" });
    expect(s.posts).toEqual([]);
    expect(await runPublisherStep(dependencies)).toEqual({ action: "idle", reason: "up-to-date-recently" });
    expect(s.runs()).toHaveLength(1);
    s.advance(121);
    s.setScenario({ exitCode: 3 });
    expect(await runPublisherStep(dependencies)).toEqual({ action: "nothing-to-prove" });
    expect(s.runs()).toHaveLength(2);
  });

  it("proves, posts the proof message on the category of the pair and direction, and keeps the key off the command line", async () => {
    const s = setup();
    s.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
    const result = await runPublisherStep(s.build());
    expect(result).toMatchObject({ action: "published", postCount: 1, newSlot: 164n });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]?.category).toBe(proofCategory("eth-pls", "first-to-second"));
    expect(decodeProofMessage(s.posts[0]?.payload as Hex)).toMatchObject({ startSlot: 100n, newSlot: 164n, direction: "first-to-second", programKey: PROGRAM_KEY });

    const [run] = s.runs();
    expect(run.args.join(" ")).not.toContain(RUNPOD_KEY);
    expect(run.args.slice(2, 3)).toEqual(["prove"]);
    expect(run.args).toEqual(expect.arrayContaining(["--route", "ethereum_to_pulsechain", "--to", "stdout"]));
    expect(run.keyInEnvironment).toBe(RUNPOD_KEY);
    // The prover configuration file named the variable, never the key; it was private; it is gone.
    expect(run.configText).toContain(`remote_api_key_env = "${KEY_VARIABLE}"`);
    expect(run.configText).not.toContain(RUNPOD_KEY);
    expect(run.configMode).toBe("600");
    expect(existsSync(run.configPath)).toBe(false);
  });

  it("does not hand the parent environment to the prover", async () => {
    process.env.PARENT_SECRET = "must-not-leak";
    try {
      const s = setup();
      s.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
      await runPublisherStep(s.build());
      expect(s.runs()[0].parentSecretVisible).toBe(false);
    } finally {
      delete process.env.PARENT_SECRET;
    }
  });

  it("posts the same proof again when the republish time has passed, and not before", async () => {
    const s = setup();
    s.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
    const dependencies = s.build();
    await runPublisherStep(dependencies);
    s.advance(599);
    expect(await runPublisherStep(dependencies)).toEqual({ action: "idle", reason: "proof-posted-recently" });
    s.advance(1);
    expect(await runPublisherStep(dependencies)).toMatchObject({ action: "republished", postCount: 2 });
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1]?.payload).toBe(s.posts[0]?.payload);
    expect(s.runs()).toHaveLength(1); // no new proof for the same head
  });

  it("stops posting once the light client stores a head at or past the proof", async () => {
    const s = setup();
    s.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
    const dependencies = s.build();
    await runPublisherStep(dependencies);
    s.lightClient.state = { ...s.lightClient.state, headSlot: 164n, headRoot: word(0xcc) };
    s.advance(10);
    expect(await runPublisherStep(dependencies)).toEqual({ action: "dropped-proof", reason: "covered" });
    expect(s.posts).toHaveLength(1);
    expect(JSON.parse(readFileSync(s.statePath, "utf8")).pending).toBeNull();
  });

  it("drops a proof when the head moved to a slot other than its start", async () => {
    const s = setup();
    s.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
    const dependencies = s.build();
    await runPublisherStep(dependencies);
    s.lightClient.state = { ...s.lightClient.state, headSlot: 120n, headRoot: word(0xdd) };
    expect(await runPublisherStep(dependencies)).toEqual({ action: "dropped-proof", reason: "head-moved" });
  });

  it("discards a proof that starts at a head the light client no longer stores", async () => {
    const s = setup();
    s.setScenario({ exitCode: 0, stdout: packageJson(96n, 164n) });
    expect(await runPublisherStep(s.build())).toEqual({ action: "stale-proof" });
    expect(s.posts).toEqual([]);
  });

  it("survives a restart: it proves nothing twice and republishes from the saved proof", async () => {
    const s = setup();
    s.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
    await runPublisherStep(s.build());
    const restarted = s.build(); // new objects, same state file
    expect(await runPublisherStep(restarted)).toEqual({ action: "idle", reason: "proof-posted-recently" });
    s.advance(700);
    expect(await runPublisherStep(restarted)).toMatchObject({ action: "republished", postCount: 2 });
    expect(s.runs()).toHaveLength(1);
  });

  it("keeps a proof when the post fails, and posts it on the next step", async () => {
    const s = setup();
    s.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
    s.board.failNext = true;
    const dependencies = s.build();
    expect(await runPublisherStep(dependencies)).toEqual({ action: "post-failed" });
    expect(await runPublisherStep(dependencies)).toMatchObject({ action: "published", postCount: 1 });
    expect(s.runs()).toHaveLength(1);
  });

  it("backs off after a failed run, and never writes the key to a log line", async () => {
    const s = setup();
    s.setScenario({ exitCode: 1, stderr: `error: the worker refused the key ${RUNPOD_KEY}` });
    const dependencies = s.build();
    expect(await runPublisherStep(dependencies)).toEqual({ action: "prove-failed" });
    expect(await runPublisherStep(dependencies)).toEqual({ action: "idle", reason: "backoff" });
    expect(s.runs()).toHaveLength(1);
    expect(s.lines.join("\n")).not.toContain(RUNPOD_KEY);
    expect(s.lines.join("\n")).toContain("worker refused the key");
    s.advance(121);
    expect(await runPublisherStep(dependencies)).toEqual({ action: "prove-failed" });
    expect(s.runs()).toHaveLength(2);
  });

  it("takes any proof source: a queue endpoint that is polled until the proof is ready needs no change in the publisher", async () => {
    const s = setup();
    const message = proofMessage({ startSlot: 100n, newSlot: 164n });
    let polls = 0;
    const queueSource = {
      // Submit, then poll: the shape of a queue mode. The publisher sees only the final answer.
      async produce() {
        while (polls < 3) {
          polls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return { kind: "proof" as const, proofPackage: JSON.parse(packageJson(100n, 164n)) as never, message };
      },
    };
    const dependencies = { ...s.build(), proofSource: queueSource as never };
    expect(await runPublisherStep(dependencies)).toMatchObject({ action: "published", newSlot: 164n });
    expect(polls).toBe(3);
    expect(s.posts).toHaveLength(1);
  });

  it("proves when a transfer waits, even inside the interval, and only then", async () => {
    const waiting = setup({ policy: { proveWhenTransferWaits: true, intervalSeconds: 0 }, transferWaits: true });
    waiting.setScenario({ exitCode: 0, stdout: packageJson(100n, 164n) });
    expect(await runPublisherStep(waiting.build())).toMatchObject({ action: "published" });

    const quiet = setup({ name: "quiet", policy: { proveWhenTransferWaits: true, intervalSeconds: 0 }, transferWaits: false });
    expect(await runPublisherStep(quiet.build())).toEqual({ action: "idle", reason: "no-demand" });
    expect(quiet.runs()).toHaveLength(0);
  });
});
