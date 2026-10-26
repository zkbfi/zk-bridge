import type { PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proofCategory } from "@zk-bridge/shared";
import { BotConfigError } from "../../src/config/bot-config.ts";
import { grindInWorker } from "../../src/msgboard/grind.ts";
import type { CommandExecutor, CommandSpec } from "../../src/prover/execute-command.ts";
import { startPublisher, UP_TO_DATE_WAIT_SECONDS, type PublisherOverrides } from "../../src/publisher/service.ts";
import { PROGRAM_KEY, feedItem, word } from "../support/builders.ts";
import { startFakeBoard, type FakeBoard } from "../support/fake-board.ts";
import { startFakeIndexer, type FakeIndexer } from "../support/fake-indexer.ts";
import { createServiceWorld, proofPackageJson, type ServiceWorld, type ServiceWorldOptions } from "../support/service-world.ts";

// Made-up value with the real shape. It is not a live key.
const RUNPOD_KEY = "rpa_TESTONLY1234567890abcdefghijkl";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function world(options: ServiceWorldOptions = {}): Promise<ServiceWorld> {
  const created = await createServiceWorld(options);
  closers.push(created.cleanup);
  return created;
}
async function board(): Promise<FakeBoard> {
  const started = await startFakeBoard();
  closers.push(() => started.stop());
  return started;
}
async function indexer(): Promise<FakeIndexer> {
  const started = await startFakeIndexer();
  closers.push(() => started.stop());
  return started;
}

/** A client that answers the three reads of the light client reader. */
const lightClientClient = {
  readContract: async ({ functionName }: { functionName: string }) => (functionName === "head" ? 100n : functionName === "programVKey" ? PROGRAM_KEY : word(101)),
} as unknown as PublicClient;

function recordingExecutor(answer: { code: number; stdout?: string }) {
  const specs: CommandSpec[] = [];
  const executor: CommandExecutor = async (spec) => {
    specs.push(spec);
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: "" };
  };
  return { executor, specs };
}

const publisherConfig = { publisher: { prover: { binary: "/bin/zk-bridge-prover" } } };
const readySetup = (boardUrl: string, extra: ServiceWorldOptions["setup"] = {}): ServiceWorldOptions["setup"] => ({
  endpointUrl: "https://worker.example.org",
  runpodApiKey: { source: "environment", variable: "RUNPOD_API_KEY" },
  msgboardUrl: { source: "environment", variable: "BOARD_URL" },
  directions: ["first-to-second"],
  policy: { proveWhenTransferWaits: false, intervalSeconds: 3600 },
  ...extra,
});
const environmentFor = (boardUrl: string) => ({ RUNPOD_API_KEY: RUNPOD_KEY, BOARD_URL: boardUrl, PATH: "/custom/bin" });

function start(created: ServiceWorld, overrides: PublisherOverrides) {
  return startPublisher({ context: created.context, signal: new AbortController().signal, runOnce: true, overrides });
}

describe("startPublisher refuses an incomplete setup", () => {
  it("names a missing publisher section", async () => {
    const created = await world();
    await expect(start(created, {})).rejects.toThrow(new BotConfigError("The bot configuration has no publisher section."));
  });

  it("names a missing remote prover endpoint", async () => {
    const created = await world({ config: publisherConfig });
    await expect(start(created, {})).rejects.toThrow("The setup file has no remote prover endpoint (endpointUrl).");
  });

  it("names a missing reference to the RunPod key", async () => {
    const created = await world({ config: publisherConfig, setup: { endpointUrl: "https://worker.example.org" } });
    await expect(start(created, {})).rejects.toThrow("The setup file has no reference to the RunPod key (runpodApiKey).");
  });

  it("names a missing msgboard endpoint", async () => {
    const created = await world({ config: publisherConfig, setup: { endpointUrl: "https://worker.example.org", runpodApiKey: { source: "environment", variable: "RUNPOD_API_KEY" } } });
    await expect(start(created, {})).rejects.toThrow("The setup file has no msgboard endpoint (msgboardUrl).");
  });

  it("requires the indexer when the policy proves for a waiting transfer", async () => {
    const created = await world({ config: publisherConfig, setup: readySetup("x", { policy: { proveWhenTransferWaits: true, intervalSeconds: 0 } }), environment: environmentFor("http://127.0.0.1:1") });
    await expect(start(created, {})).rejects.toThrow("The policy proves when a transfer waits, so publisher.indexerUrl is required.");
  });
});

describe("startPublisher runs one step for each direction", () => {
  it("runs the prover with the key in the environment only, and logs a step that found nothing to prove", async () => {
    const node = await board();
    const created = await world({ config: publisherConfig, setup: readySetup(node.url, { directions: ["first-to-second", "second-to-first"] }), environment: environmentFor(node.url) });
    const { executor, specs } = recordingExecutor({ code: 3 });
    await start(created, { executor, publicClient: () => lightClientClient, now: () => 1_800_000_000_000 });
    expect(specs).toHaveLength(2);
    expect(specs.map((spec) => spec.args[4]).sort()).toEqual(["ethereum_to_pulsechain", "pulsechain_to_ethereum"]);
    expect(specs.every((spec) => spec.args[2] === "prove")).toBe(true);
    for (const spec of specs) {
      expect(spec.command).toBe("/bin/zk-bridge-prover");
      expect(spec.timeoutMilliseconds).toBe(1_800_000);
      expect(spec.environment).toEqual({ PATH: "/custom/bin", RUNPOD_API_KEY: RUNPOD_KEY });
      expect(spec.args.join(" ")).not.toContain(RUNPOD_KEY);
    }
    const steps = created.events().filter((event) => event.event === "publisher_step").sort((left, right) => String(left.direction).localeCompare(String(right.direction)));
    expect(steps).toEqual([
      expect.objectContaining({ level: "info", action: "nothing-to-prove", bot: "publisher", direction: "first-to-second", pair: "eth-pls" }),
      expect.objectContaining({ level: "info", action: "nothing-to-prove", bot: "publisher", direction: "second-to-first", pair: "eth-pls" }),
    ]);
    expect(created.logLines.join("\n")).not.toContain(RUNPOD_KEY);
    expect(UP_TO_DATE_WAIT_SECONDS).toBe(120);
  });

  it("falls back to a default PATH when the environment has none", async () => {
    const node = await board();
    const created = await world({ config: publisherConfig, setup: readySetup(node.url), environment: { ...environmentFor(node.url), PATH: undefined } });
    const { executor, specs } = recordingExecutor({ code: 3 });
    await start(created, { executor, publicClient: () => lightClientClient });
    expect(specs[0]!.environment).toMatchObject({ PATH: "/usr/bin:/bin" });
  });

  it("posts the proof it made to the board, through the grind function it is given", async () => {
    const node = await board();
    const created = await world({ config: publisherConfig, setup: readySetup(node.url), environment: environmentFor(node.url) });
    const { executor } = recordingExecutor({ code: 0, stdout: `${proofPackageJson()}\n` });
    const grind = vi.fn(grindInWorker);
    await start(created, { executor, grind, publicClient: () => lightClientClient });
    expect(grind).toHaveBeenCalledOnce();
    expect(grind.mock.calls[0]![0]).toMatchObject({ boardUrl: `${node.url}/`, category: proofCategory("eth-pls", "first-to-second"), timeoutMilliseconds: 300_000 });
    expect(node.messages).toHaveLength(1);
    expect(node.messages[0]!.category).toBe(proofCategory("eth-pls", "first-to-second"));
    expect(created.events().find((event) => event.event === "publisher_step")).toMatchObject({ action: "published", postCount: 1 });
  });

  it("grinds in a worker thread when no grind function is given", async () => {
    const node = await board();
    const created = await world({ config: publisherConfig, setup: readySetup(node.url), environment: environmentFor(node.url) });
    const { executor } = recordingExecutor({ code: 0, stdout: `${proofPackageJson()}\n` });
    await start(created, { executor, publicClient: () => lightClientClient });
    expect(node.messages).toHaveLength(1);
  });

  it("uses the board it is given and opens none of its own", async () => {
    const created = await world({ config: publisherConfig, setup: readySetup("http://127.0.0.1:1"), environment: environmentFor("http://127.0.0.1:1") });
    const { executor } = recordingExecutor({ code: 0, stdout: `${proofPackageJson()}\n` });
    const post = vi.fn(async () => ({ messageHash: word(0xb1), grindMilliseconds: 1 }));
    await start(created, { executor, board: { post }, publicClient: () => lightClientClient });
    expect(post).toHaveBeenCalledOnce();
  });

  it("proves for a waiting transfer that the indexer lists, and only then", async () => {
    const node = await board();
    const feed = await indexer();
    const options: ServiceWorldOptions = {
      config: { publisher: { ...publisherConfig.publisher, indexerUrl: feed.url } },
      setup: readySetup(node.url, { policy: { proveWhenTransferWaits: true, intervalSeconds: 0 } }),
      environment: environmentFor(node.url),
    };
    const quiet = recordingExecutor({ code: 3 });
    const first = await world(options);
    await start(first, { executor: quiet.executor, publicClient: () => lightClientClient });
    expect(quiet.specs).toEqual([]);
    expect(first.events().find((event) => event.event === "publisher_step")).toMatchObject({ level: "debug", action: "idle", reason: "no-demand" });
    feed.items.push({ ...feedItem(), status: "waiting_for_finality" });
    const waiting = recordingExecutor({ code: 3 });
    await start(await world(options), { executor: waiting.executor, publicClient: () => lightClientClient });
    expect(waiting.specs).toHaveLength(1);
  });

  it("logs a light client that cannot be read, when no client is given and the endpoint refuses", async () => {
    const node = await board();
    const created = await world({ config: publisherConfig, setup: readySetup(node.url), environment: environmentFor(node.url) });
    const { executor, specs } = recordingExecutor({ code: 3 });
    await start(created, { executor });
    expect(specs).toEqual([]);
    expect(created.events().some((event) => event.event === "light_client_unreadable")).toBe(true);
  }, 60_000);

  it("runs the real command executor when none is given, and logs that the prover cannot start", async () => {
    const node = await board();
    const created = await world({ config: { publisher: { prover: { binary: "/nonexistent/zk-bridge-prover" } } }, setup: readySetup(node.url), environment: environmentFor(node.url) });
    await start(created, { publicClient: () => lightClientClient });
    const failure = created.events().find((event) => event.event === "proving_failed");
    expect(failure).toMatchObject({ level: "error", error: { name: "CommandStartError" } });
  });
});
