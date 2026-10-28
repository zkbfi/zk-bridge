import { describe, expect, it } from "vitest";
import { proofCategory } from "@zk-bridge/shared";
import type { Hex } from "viem";
import type { ProveOutcome } from "@zk-bridge/shared/prover";
import { decideProving } from "../../src/publisher/decisions.ts";
import { runPublisherStep, type PublisherDependencies } from "../../src/publisher/publisher.ts";
import { INITIAL_PUBLISHER_STATE, type PublisherState } from "../../src/publisher/state.ts";
import type { StateFile } from "../../src/runtime/state-file.ts";
import { PROGRAM_KEY, fakeLightClient, memoryLogger, proofMessage, word } from "../support/builders.ts";

const NOW = 1_800_000_000_000;

function packageFor(startSlot: bigint, newSlot: bigint, overrides: Record<string, unknown> = {}) {
  const message = proofMessage({ startSlot, newSlot });
  return {
    schemaVersion: 1 as const,
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
    ...overrides,
  };
}

function memoryState(initial: PublisherState = INITIAL_PUBLISHER_STATE): StateFile<PublisherState> & { current: PublisherState } {
  const file = {
    current: initial,
    async load() {
      return file.current;
    },
    async save(state: PublisherState) {
      file.current = state;
    },
    async update(mutate: (state: PublisherState) => PublisherState) {
      file.current = mutate(file.current);
      return file.current;
    },
  };
  return file;
}

function world(options: { state?: PublisherState; outcome?: () => Promise<ProveOutcome>; transferWaits?: null; policy?: PublisherDependencies["policy"]; failPosts?: boolean } = {}) {
  const lightClient = fakeLightClient();
  const state = memoryState(options.state);
  const posts: Array<{ category: Hex; payload: Hex }> = [];
  const { logger, events } = memoryLogger();
  const dependencies: PublisherDependencies = {
    pairName: "eth-pls",
    direction: "first-to-second",
    category: proofCategory("eth-pls", "first-to-second"),
    lightClient,
    proofSource: { produce: options.outcome ?? (async () => ({ kind: "up-to-date" })) },
    board: {
      async post(input) {
        if (options.failPosts === true) throw new Error("the board refused the message");
        posts.push(input);
        return { messageHash: word(0xb0 + posts.length), grindMilliseconds: 5 };
      },
    },
    transferWaits: options.transferWaits ?? null,
    state,
    policy: options.policy ?? { proveWhenTransferWaits: false, intervalSeconds: 3600 },
    republishSeconds: 600,
    retryBackoffSeconds: 120,
    upToDateWaitSeconds: 120,
    now: () => NOW,
    logger,
  };
  return { dependencies, lightClient, state, posts, events };
}

const proofOutcome = (overrides: Record<string, unknown> = {}) => async (): Promise<ProveOutcome> => ({ kind: "proof", proofPackage: packageFor(100n, 164n, overrides) as never });

describe("runPublisherStep", () => {
  it("reports an unreadable light client and leaves the state alone", async () => {
    const { dependencies, lightClient, state, events } = world();
    lightClient.read = async () => {
      throw new Error("rpc down");
    };
    expect(await runPublisherStep(dependencies)).toEqual({ action: "chain-unreadable" });
    expect(state.current).toEqual(INITIAL_PUBLISHER_STATE);
    expect(events()).toEqual([expect.objectContaining({ level: "error", event: "light_client_unreadable", error: { name: "Error", message: "rpc down" } })]);
  });

  it("reports a failed post of a proof that is old enough to post again, and keeps the proof", async () => {
    const made = world({ outcome: proofOutcome() });
    await runPublisherStep(made.dependencies);
    const pending = made.state.current.pending!;
    const failing = world({ state: { ...made.state.current, pending: { ...pending, lastPostedAtMilliseconds: NOW - 601_000, postCount: 1 } }, failPosts: true });
    expect(await runPublisherStep(failing.dependencies)).toEqual({ action: "post-failed" });
    expect(failing.state.current.pending).toEqual({ ...pending, lastPostedAtMilliseconds: NOW - 601_000, postCount: 1 });
  });

  it("proves a new update at once after it drops a covered proof, and reports the new post, not the drop", async () => {
    const covered = { ...INITIAL_PUBLISHER_STATE, pending: { payload: "0x01" as Hex, startSlot: "36", startRoot: word(1), newSlot: "100", madeAtMilliseconds: NOW - 5_000, lastPostedAtMilliseconds: NOW - 4_000, postCount: 1, messageHash: word(9) } };
    const { dependencies, posts, state, events } = world({ state: covered, outcome: proofOutcome() });
    expect(await runPublisherStep(dependencies)).toEqual({ action: "published", postCount: 1, newSlot: 164n });
    expect(events().map((event) => event.event)).toEqual(["proof_dropped", "proving_started", "proof_made", "proof_posted"]);
    expect(posts).toHaveLength(1);
    expect(state.current.pending?.newSlot).toBe("164");
  });

  it("proves by the interval when no indexer is configured, because no transfer is known to wait", async () => {
    const { dependencies, posts } = world({ transferWaits: null, policy: { proveWhenTransferWaits: true, intervalSeconds: 3600 }, outcome: proofOutcome() });
    expect(await runPublisherStep(dependencies)).toMatchObject({ action: "published" });
    expect(posts).toHaveLength(1);
  });

  it("discards a proof whose program key is not the key of the light client", async () => {
    const { dependencies, state, posts, events } = world({ outcome: proofOutcome({ programKey: word(0x43) }) });
    expect(await runPublisherStep(dependencies)).toEqual({ action: "stale-proof" });
    expect(posts).toEqual([]);
    expect(state.current.pending).toBeNull();
    expect(state.current.lastProveAttempt).toEqual({ atMilliseconds: NOW, outcome: "failed" });
    expect(events().find((event) => event.event === "proof_discarded")).toMatchObject({ level: "warn", reason: "program-key-differs" });
  });

  it("compares the program key without regard to letter case", async () => {
    const { dependencies } = world({ outcome: proofOutcome({ programKey: PROGRAM_KEY.toUpperCase().replace("0X", "0x") }) });
    expect(await runPublisherStep(dependencies)).toMatchObject({ action: "published" });
  });

  it("discards a proof that does not encode, with the reason of the encoder", async () => {
    const { dependencies, posts, events } = world({ outcome: proofOutcome({ proof: "0xzz" }) });
    expect(await runPublisherStep(dependencies)).toEqual({ action: "stale-proof" });
    expect(posts).toEqual([]);
    const discarded = events().find((event) => event.event === "proof_discarded")!;
    expect(discarded.reason).toBe("wrong-field-size: proof must be 356 bytes");
  });
});

describe("decideProving", () => {
  it("proves by the interval when it never made a proof", async () => {
    const decision = await decideProving({
      nowMilliseconds: NOW,
      policy: { proveWhenTransferWaits: false, intervalSeconds: 60 },
      state: INITIAL_PUBLISHER_STATE,
      retryBackoffSeconds: 120,
      upToDateWaitSeconds: 120,
      transferWaits: async () => false,
    });
    expect(decision).toEqual({ prove: true, reason: "interval" });
  });
});
