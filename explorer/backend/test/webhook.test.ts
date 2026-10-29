import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { beaconLightClientAbi, decodeProofMessage, proofCategory, type ProofDirection } from "@zk-bridge/shared";
import type { BoardPublisher } from "@zk-bridge/shared/msgboard";
import type { LightClientHead, ProverBinary } from "@zk-bridge/shared/prover";
import { PROGRAM_KEY, publicValuesFor, word } from "../../shared/test/support/prover-builders.ts";
import { MAXIMUM_BODY_BYTES } from "../src/requests/module.ts";
import { getJob, insertJob, updateJob } from "../src/requests/jobs.ts";
import { NOT_CONFIGURED_TEXT, REAL_SOURCE, TICK_INTERVAL_MILLISECONDS, configureWebhook, settled, start, type WebhookSource } from "../src/webhook/module.ts";
import { MAXIMUM_POST_ATTEMPTS, POST_FAILED_REASON, RETRY_BASE_MILLISECONDS, RETRY_CEILING_MILLISECONDS, createProofPublisher, retryDelayMilliseconds } from "../src/webhook/publish.ts";
import { bearerMatches, ensureProofTable } from "../src/webhook/receive.ts";
import { MODULES } from "../src/main.ts";
import { SECRETS, controllableProver, makeBackend, makeConfig, memoryLogger } from "./support.ts";

const TOKEN = SECRETS.webhookBearer;
const START_ROOT = word(0x21);
const NEW_ROOT = word(0x22);
const HEAD: LightClientHead = { headSlot: 100n, headRoot: START_ROOT, programKey: PROGRAM_KEY };

const SETTINGS = { BACKEND_WEBHOOK_BEARER: TOKEN };
const BOARD_URL = "http://board.invalid";

/** A package in the shape that the prover hands off, with the real byte sizes. */
function proofPackage(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    route: "ethereum_to_pulsechain",
    programKey: PROGRAM_KEY,
    startHeadSlot: 100,
    startHeadRoot: START_ROOT,
    newHeadSlot: 200,
    newHeadRoot: NEW_ROOT,
    latestFinalizedSlot: 200,
    publicValues: publicValuesFor(100n, START_ROOT, 200n, NEW_ROOT),
    proof: `0x${"ab".repeat(356)}`,
    updateCalldata: `0x${"cd".repeat(868)}`,
    backend: "remote",
    destination: { chainId: 369, lightClient: `0x${"b".repeat(40)}` },
    createdAt: "2026-10-28T00:00:00Z",
    ...overrides,
  };
}

type Fixture = ReturnType<typeof setup>;

function setup(options: { head?: LightClientHead; source?: Partial<WebhookSource>; verify?: ProverBinary["verify"]; config?: Record<string, unknown> } = {}) {
  const posts: Array<{ category: Hex; payload: Hex }> = [];
  const state = { boardFailure: null as Error | null, head: options.head ?? HEAD, headFailure: null as Error | null, beforePost: null as (() => void) | null, gate: null as Promise<void> | null };
  const reads: Array<{ rpcUrl: string; lightClient: Hex }> = [];
  const verifications: unknown[] = [];
  const board: BoardPublisher = {
    async post(input) {
      await state.gate;
      state.beforePost?.();
      if (state.boardFailure !== null) throw state.boardFailure;
      posts.push(input);
      return { messageHash: word(0x99), grindMilliseconds: 7 };
    },
  };
  const controllable = controllableProver();
  const prover = {
    ...controllable,
    binary: {
      ...controllable.binary,
      verify: options.verify ?? (async (input) => void verifications.push(input)),
    } satisfies ProverBinary,
  };
  const backend = makeBackend({ prover, enabled: ["requests", "webhook"], config: makeConfig({ msgboardUrl: BOARD_URL, ...options.config }) });
  configureWebhook(backend.context, {
    environment: SETTINGS,
    makeBoard: () => board,
    async readLightClient(input) {
      reads.push(input);
      if (state.headFailure !== null) throw state.headFailure;
      return state.head;
    },
    ...options.source,
  });
  return { ...backend, posts, state, reads, verifications };
}

function createProvingJob(fixture: Fixture, direction: ProofDirection = "first-to-second", id = "job-1") {
  insertJob(fixture.storage, { id, direction, now: fixture.clock.now() });
  updateJob(fixture.storage, id, { status: "proving" }, fixture.clock.now(), ["queued"]);
  return id;
}

async function send(fixture: Fixture, jobId: string, body: unknown, headers: Record<string, string | undefined> = { authorization: `Bearer ${TOKEN}` }) {
  return fixture.app.request(`/webhook/jobs/${jobId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const storedCount = (fixture: Fixture) => {
  ensureProofTable(fixture.storage);
  return (fixture.storage.database.prepare("SELECT count(*) AS total FROM webhook_proofs").get() as { total: number }).total;
};
const storedRow = (fixture: Fixture) => fixture.storage.database.prepare("SELECT * FROM webhook_proofs").get() as Record<string, unknown>;

afterEach(() => {
  vi.useRealTimers();
});

describe("the bearer token", () => {
  it("refuses a missing or wrong bearer token with 401 and stores nothing", async () => {
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }, { authorization: "Bearer " }, { authorization: `Basic ${TOKEN}` }]) {
      const answer = await send(fixture, jobId, proofPackage(), headers);
      expect(answer.status).toBe(401);
      expect(await answer.json()).toEqual({ error: "unauthorized" });
    }
    expect(storedCount(fixture)).toBe(0);
    expect(fixture.verifications).toHaveLength(0);
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
  });

  it("compares the whole token and never accepts an empty one", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });
});

describe("the body", () => {
  it("a real sized package fits the 4 KiB limit that every route keeps", async () => {
    const fixture = setup();
    expect(Buffer.byteLength(JSON.stringify(proofPackage()))).toBeLessThan(MAXIMUM_BODY_BYTES);
    const jobId = createProvingJob(fixture);
    expect((await send(fixture, jobId, proofPackage())).status).toBe(202);
  });

  it("refuses a body over the limit with 413", async () => {
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage({ route: "x".repeat(MAXIMUM_BODY_BYTES) }));
    expect(answer.status).toBe(413);
    expect(storedCount(fixture)).toBe(0);
  });

  it.each([["not json"], [{ schemaVersion: 2 }], [[]]])("refuses a body that is not a proof package with 400: %j", async (body) => {
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    expect((await send(fixture, jobId, body)).status).toBe(400);
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
  });
});

describe("a replay", () => {
  it("answers stored and keeps the stored proof when the prover sends again after the head moved", async () => {
    const fixture = setup();
    fixture.state.boardFailure = new Error("down");
    const jobId = createProvingJob(fixture);
    expect((await send(fixture, jobId, proofPackage())).status).toBe(202);
    await settled(fixture.context);
    expect(storedCount(fixture)).toBe(1);
    fixture.state.head = { ...HEAD, headSlot: 200n };
    const replay = await send(fixture, jobId, proofPackage());
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ status: "stored" });
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
    expect(storedCount(fixture)).toBe(1);
  });
});

describe("the job", () => {
  it("refuses a package for a job that is not proving", async () => {
    const fixture = setup();
    insertJob(fixture.storage, { id: "queued-job", direction: "first-to-second", now: 1 });
    const queued = await send(fixture, "queued-job", proofPackage());
    expect(queued.status).toBe(409);
    expect(await queued.json()).toEqual({ error: "the job is queued, not proving" });
    updateJob(fixture.storage, "queued-job", { status: "failed", error: "x" }, 2, ["queued"]);
    expect((await send(fixture, "queued-job", proofPackage())).status).toBe(409);
    expect(storedCount(fixture)).toBe(0);
    expect(fixture.verifications).toHaveLength(0);
  });

  it("refuses a package for a job that does not exist with 404", async () => {
    const fixture = setup();
    expect((await send(fixture, "nothing", proofPackage())).status).toBe(404);
  });
});

describe("the check", () => {
  it("refuses a proof that does not verify and marks the job failed with the reason", async () => {
    const fixture = setup({
      verify: async () => {
        throw new Error("the verifier said no, see /private/path");
      },
    });
    const jobId = createProvingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage());
    expect(answer.status).toBe(422);
    expect(await answer.json()).toEqual({ error: "the proof was refused", reason: "proof-does-not-verify" });
    const job = getJob(fixture.storage, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("the proof was refused: proof-does-not-verify");
    expect(job?.error).not.toContain("/private/path");
    expect(storedCount(fixture)).toBe(0);
    expect(fixture.posts).toHaveLength(0);
  });

  it("refuses a proof that starts away from the stored head, and a proof the head already passed", async () => {
    const moved = setup({ head: { ...HEAD, headSlot: 150n } });
    const movedJob = createProvingJob(moved);
    await send(moved, movedJob, proofPackage({ startHeadSlot: 100 }));
    expect(getJob(moved.storage, movedJob)?.error).toBe("the proof was refused: start-slot-differs-from-head");
    const passed = setup({ head: { ...HEAD, headSlot: 200n } });
    const passedJob = createProvingJob(passed);
    await send(passed, passedJob, proofPackage());
    expect(getJob(passed.storage, passedJob)?.error).toBe("the proof was refused: already-stored");
  });

  it("refuses a package for another program key", async () => {
    const fixture = setup({ head: { ...HEAD, programKey: word(0x01) } });
    const jobId = createProvingJob(fixture);
    expect((await send(fixture, jobId, proofPackage())).status).toBe(422);
    expect(getJob(fixture.storage, jobId)?.error).toBe("the proof was refused: program-key-mismatch");
  });

  it("fails a job whose package does not fit the proof message", async () => {
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage({ proof: "0x00" }));
    expect(answer.status).toBe(422);
    expect(getJob(fixture.storage, jobId)?.error).toBe("the proof was refused: the package does not fit the proof message");
    expect(fixture.verifications).toHaveLength(0);
  });

  it("does not blame the proof when the light client cannot be read: the job stays proving", async () => {
    const fixture = setup();
    fixture.state.headFailure = new Error("rpc down");
    const jobId = createProvingJob(fixture);
    expect((await send(fixture, jobId, proofPackage())).status).toBe(503);
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
    expect(storedCount(fixture)).toBe(0);
  });

  it("reads the light client of the destination chain of the direction", async () => {
    const forward = setup();
    await send(forward, createProvingJob(forward, "first-to-second"), proofPackage());
    expect(forward.reads[0]).toEqual({ rpcUrl: "http://rpc-369.invalid", lightClient: `0x${"2".repeat(40)}` });
    const backward = setup();
    await send(backward, createProvingJob(backward, "second-to-first"), proofPackage());
    expect(backward.reads[0]).toEqual({ rpcUrl: "http://rpc-1.invalid", lightClient: `0x${"1".repeat(40)}` });
  });
});

describe("the publisher", () => {
  it("posts a verified proof to the job's category and marks the job published", async () => {
    const fixture = setup();
    const jobId = createProvingJob(fixture, "second-to-first");
    const answer = await send(fixture, jobId, proofPackage());
    expect(answer.status).toBe(202);
    expect(await answer.json()).toEqual({ status: "stored" });
    await settled(fixture.context);
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.posts[0]?.category).toBe(proofCategory("eth-pls", "second-to-first"));
    const message = decodeProofMessage(fixture.posts[0]?.payload as Hex);
    expect(message).toMatchObject({ pair: "eth-pls", direction: "second-to-first", startSlot: 100n, newSlot: 200n });
    expect(getJob(fixture.storage, jobId)).toMatchObject({ status: "published", startSlot: "100", newSlot: "200", error: null });
    expect(storedRow(fixture)).toMatchObject({ message_hash: word(0x99), attempts: 0 });
  });

  it("verifies with the prover before it posts", async () => {
    const fixture = setup();
    await send(fixture, createProvingJob(fixture), proofPackage());
    await settled(fixture.context);
    expect(fixture.verifications).toEqual([{ programKey: PROGRAM_KEY, publicValues: proofPackage().publicValues, proof: proofPackage().proof }]);
  });

  it("a board error leaves the proof stored and retries on the next tick", async () => {
    const fixture = setup();
    fixture.state.boardFailure = new TypeError("board at http://board.invalid refused");
    const jobId = createProvingJob(fixture);
    expect((await send(fixture, jobId, proofPackage())).status).toBe(202);
    await settled(fixture.context);
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
    expect(storedRow(fixture)).toMatchObject({ posted_at: null, attempts: 1, last_error: "TypeError" });
    fixture.state.boardFailure = null;
    fixture.clock.advance(RETRY_BASE_MILLISECONDS);
    const stop = await start(fixture.context);
    await stop();
    expect(getJob(fixture.storage, jobId)?.status).toBe("published");
    expect(fixture.posts).toHaveLength(1);
    expect(storedRow(fixture)).toMatchObject({ last_error: null });
  });

  it("posts a package that arrives twice once", async () => {
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    const answers = await Promise.all([send(fixture, jobId, proofPackage()), send(fixture, jobId, proofPackage())]);
    expect(answers.map((answer) => answer.status)).toEqual([202, 202]);
    await settled(fixture.context);
    expect(fixture.posts).toHaveLength(1);
    expect(storedCount(fixture)).toBe(1);
    expect((await send(fixture, jobId, proofPackage())).status).toBe(409);
  });

  it("does not post the proof of a job that failed while the proof waited", async () => {
    const fixture = setup();
    fixture.state.boardFailure = new Error("down");
    const jobId = createProvingJob(fixture);
    await send(fixture, jobId, proofPackage());
    await settled(fixture.context);
    updateJob(fixture.storage, jobId, { status: "failed", error: "the prover ran longer than its limit" }, 5, ["proving"]);
    fixture.state.boardFailure = null;
    await (await start(fixture.context))();
    expect(fixture.posts).toHaveLength(0);
    expect(storedCount(fixture)).toBe(0);
    expect(getJob(fixture.storage, jobId)?.status).toBe("failed");
  });

  it("drops the proof of an ended job when asked to publish it directly", async () => {
    const fixture = setup();
    ensureProofTable(fixture.storage);
    const jobId = createProvingJob(fixture);
    fixture.storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at) VALUES (?, 'first-to-second', '0x00', '1', '2', 0)").run(jobId);
    updateJob(fixture.storage, jobId, { status: "failed", error: "late" }, 5, ["proving"]);
    const publisher = createProofPublisher({
      storage: fixture.storage,
      board: { post: async () => { throw new Error("must not post"); } },
      categoryFor: () => word(0x01),
      heads: { headSlot: async () => 0n },
      now: fixture.clock.now,
      logger: fixture.context.logger,
    });
    await publisher.publish(jobId);
    expect(storedCount(fixture)).toBe(0);
  });

  it("keeps the post when the job ends during it, and does not bring the job back", async () => {
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    fixture.state.beforePost = () => updateJob(fixture.storage, jobId, { status: "failed", error: "late" }, 5, ["proving"]);
    await send(fixture, jobId, proofPackage());
    await settled(fixture.context);
    expect(getJob(fixture.storage, jobId)?.status).toBe("failed");
    expect(storedRow(fixture).posted_at).not.toBeNull();
  });

  it("settled waits for a post that is still running", async () => {
    const fixture = setup();
    let release!: () => void;
    fixture.state.gate = new Promise<void>((resolve) => (release = resolve));
    const jobId = createProvingJob(fixture);
    await send(fixture, jobId, proofPackage());
    let finished = false;
    const waiting = settled(fixture.context).then(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    release();
    await waiting;
    expect(getJob(fixture.storage, jobId)?.status).toBe("published");
  });

  it("keeps a board error that is not an Error object, and names no text of it", async () => {
    const fixture = setup();
    fixture.state.beforePost = () => {
      throw "plain text http://board.invalid";
    };
    await send(fixture, createProvingJob(fixture), proofPackage());
    await settled(fixture.context);
    expect(storedRow(fixture)).toMatchObject({ attempts: 1, last_error: "unknown error" });
  });

  it("publishes nothing for a job with no stored proof", async () => {
    const fixture = setup();
    ensureProofTable(fixture.storage);
    const publisher = createProofPublisher({
      storage: fixture.storage,
      board: { post: async () => { throw new Error("must not post"); } },
      categoryFor: () => word(0x01),
      heads: { headSlot: async () => 0n },
      now: fixture.clock.now,
      logger: fixture.context.logger,
    });
    await expect(publisher.publish("nothing")).resolves.toBeUndefined();
  });

  it("waits longer after each failed post, up to a ceiling, and posts again when the wait is over", async () => {
    expect([1, 2, 3].map(retryDelayMilliseconds)).toEqual([RETRY_BASE_MILLISECONDS, RETRY_BASE_MILLISECONDS * 2, RETRY_BASE_MILLISECONDS * 4]);
    expect(retryDelayMilliseconds(MAXIMUM_POST_ATTEMPTS)).toBe(RETRY_CEILING_MILLISECONDS);
    const fixture = setup();
    fixture.state.boardFailure = new Error("down");
    const jobId = createProvingJob(fixture);
    await send(fixture, jobId, proofPackage());
    await settled(fixture.context);
    expect(storedRow(fixture).attempts).toBe(1);
    await (await start(fixture.context))();
    expect(storedRow(fixture).attempts).toBe(1);
    fixture.clock.advance(RETRY_BASE_MILLISECONDS - 1);
    await (await start(fixture.context))();
    expect(storedRow(fixture).attempts).toBe(1);
    fixture.clock.advance(1);
    await (await start(fixture.context))();
    expect(storedRow(fixture).attempts).toBe(2);
    fixture.clock.advance(RETRY_BASE_MILLISECONDS * 2 - 1);
    await (await start(fixture.context))();
    expect(storedRow(fixture).attempts).toBe(2);
    fixture.clock.advance(1);
    fixture.state.boardFailure = null;
    await (await start(fixture.context))();
    expect(getJob(fixture.storage, jobId)?.status).toBe("published");
  });

  it("fails the job with a fixed reason after the maximum number of attempts", async () => {
    const fixture = setup();
    fixture.state.boardFailure = new TypeError("board at http://board.invalid refused");
    const jobId = createProvingJob(fixture);
    await send(fixture, jobId, proofPackage());
    await settled(fixture.context);
    for (let attempt = 1; attempt < MAXIMUM_POST_ATTEMPTS; attempt += 1) {
      expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
      fixture.clock.advance(RETRY_CEILING_MILLISECONDS);
      await (await start(fixture.context))();
    }
    const job = getJob(fixture.storage, jobId);
    expect(job).toMatchObject({ status: "failed", error: POST_FAILED_REASON });
    expect(job?.error).not.toContain("board.invalid");
    expect(storedCount(fixture)).toBe(0);
    expect(fixture.posts).toHaveLength(0);
  });

  it("holds no wallet: the context offers none", () => {
    const fixture = setup();
    expect(Object.keys(fixture.context).sort()).toEqual(["config", "logger", "now", "pair", "prover", "proverForJob", "readProofNeed", "storage"]);
  });
});

describe("on-chain", () => {
  async function publishedFixture() {
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    await send(fixture, jobId, proofPackage());
    await settled(fixture.context);
    expect(getJob(fixture.storage, jobId)?.status).toBe("published");
    return { fixture, jobId };
  }

  it("marks the job on-chain when the head reaches newSlot", async () => {
    const { fixture, jobId } = await publishedFixture();
    fixture.state.head = { ...HEAD, headSlot: 199n };
    await (await start(fixture.context))();
    expect(getJob(fixture.storage, jobId)?.status).toBe("published");
    fixture.state.head = { ...HEAD, headSlot: 200n };
    await (await start(fixture.context))();
    expect(getJob(fixture.storage, jobId)?.status).toBe("on-chain");
  });

  it("also takes a head that passed newSlot", async () => {
    const { fixture, jobId } = await publishedFixture();
    fixture.state.head = { ...HEAD, headSlot: 900n };
    await (await start(fixture.context))();
    expect(getJob(fixture.storage, jobId)?.status).toBe("on-chain");
  });

  it("keeps the job published when the head cannot be read", async () => {
    const { fixture, jobId } = await publishedFixture();
    fixture.state.headFailure = new Error("rpc down");
    await (await start(fixture.context))();
    expect(getJob(fixture.storage, jobId)?.status).toBe("published");
    expect(fixture.log.lines.join("\n")).toContain("webhook_head_unreadable");
  });
});

describe("the timer", () => {
  it("ticks every interval, skips a tick while one runs, and stops cleanly", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const jobId = createProvingJob(fixture);
    await send(fixture, jobId, proofPackage());
    await settled(fixture.context);
    const releases: Array<() => void> = [];
    configureWebhook(fixture.context, {
      readLightClient: () => new Promise((resolve) => releases.push(() => resolve({ ...HEAD, headSlot: 50n }))),
    });
    const stop = await start(fixture.context);
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MILLISECONDS * 3);
    expect(releases).toHaveLength(1);
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MILLISECONDS);
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await stop();
  });

  it("logs a tick that fails and keeps running", async () => {
    const fixture = setup();
    createProvingJob(fixture);
    await send(fixture, "job-1", proofPackage());
    await settled(fixture.context);
    fixture.storage.database.exec("DROP TABLE webhook_proofs");
    await (await start(fixture.context))();
    expect(fixture.log.lines.join("\n")).toContain("webhook_tick_failed");
  });

  it("does nothing on a tick while the settings are unusable", async () => {
    const fixture = setup({ source: { environment: {} } });
    await (await start(fixture.context))();
    expect(fixture.posts).toHaveLength(0);
  });

  it("settled resolves at once before the settings are built", async () => {
    const fixture = setup({ source: { environment: {} } });
    await expect(settled(fixture.context)).resolves.toBeUndefined();
  });
});

describe("settings and health", () => {
  it("reports running when the settings are usable", async () => {
    const fixture = setup();
    const report = (await (await fixture.app.request("/health")).json()) as { modules: Record<string, unknown> };
    expect(report.modules.webhook).toEqual({ state: "running" });
  });

  it("answers 503 and reports degraded when msgboardUrl is missing from the configuration, and shows no value", async () => {
    const reason = "set msgboardUrl in the configuration file";
    const fixture = setup({ config: { msgboardUrl: undefined } });
    const jobId = createProvingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage());
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: reason });
    const report = (await (await fixture.app.request("/health")).json()) as { modules: Record<string, unknown> };
    expect(report.modules.webhook).toEqual({ state: "degraded", detail: reason });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(fixture.log.lines.join("\n")).not.toContain(TOKEN);
  });

  it.each([[{ ...SETTINGS, BACKEND_WEBHOOK_BEARER: "" }], [{ ...SETTINGS, BACKEND_WEBHOOK_BEARER: undefined }]])(
    "answers 503 with a fixed body when the bearer variable is not set, and health names the variable",
    async (environment) => {
      const fixture = setup({ source: { environment } });
      const jobId = createProvingJob(fixture);
      for (const headers of [{ authorization: "Bearer " }, { authorization: "Bearer anything" }, {}]) {
        const answer = await send(fixture, jobId, proofPackage(), headers);
        expect(answer.status).toBe(503);
        expect(await answer.json()).toEqual({ error: NOT_CONFIGURED_TEXT });
      }
      const report = (await (await fixture.app.request("/health")).json()) as { modules: Record<string, unknown> };
      expect(report.modules.webhook).toEqual({ state: "degraded", detail: "set the environment variable BACKEND_WEBHOOK_BEARER" });
    },
  );

  it("logs a settings failure once for each distinct reason, not on every tick", async () => {
    const fixture = setup({ source: { environment: {} } });
    const board: BoardPublisher = { post: async () => ({ messageHash: word(0x99), grindMilliseconds: 1 }) };
    const unusable = () => fixture.log.lines.filter((line) => line.includes("webhook_unusable")).length;
    // Reason one: the bearer variable is not set. The first start logs it; more ticks do not.
    await (await start(fixture.context))();
    const first = unusable();
    for (let round = 0; round < 3; round += 1) await (await start(fixture.context))();
    await fixture.app.request("/health");
    expect(unusable()).toBe(first);
    // Reason two: the settings cannot be built for another cause.
    configureWebhook(fixture.context, {
      environment: SETTINGS,
      makeBoard: () => {
        throw new Error("no board");
      },
    });
    for (let round = 0; round < 3; round += 1) await (await start(fixture.context))();
    expect(unusable()).toBe(first + 1);
    // A success resets the memory, so the same reason logs again.
    configureWebhook(fixture.context, { environment: SETTINGS, makeBoard: () => board });
    await (await start(fixture.context))();
    configureWebhook(fixture.context, { environment: {} });
    await (await start(fixture.context))();
    expect(unusable()).toBe(first + 2);
  });

  it("adds the column of the last attempt to a table from an earlier version", () => {
    const fixture = setup();
    fixture.storage.database.exec(`CREATE TABLE webhook_proofs (job_id TEXT PRIMARY KEY, direction TEXT NOT NULL, payload TEXT NOT NULL, start_slot TEXT NOT NULL, new_slot TEXT NOT NULL, stored_at INTEGER NOT NULL, posted_at INTEGER, message_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
    ensureProofTable(fixture.storage);
    ensureProofTable(fixture.storage);
    const names = (fixture.storage.database.prepare("PRAGMA table_info(webhook_proofs)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(names.filter((name) => name === "last_attempt_at")).toHaveLength(1);
  });

  it("a caller without a valid token causes no light client read and no log line", async () => {
    const fixture = setup();
    const readsAtStart = fixture.reads.length;
    const linesAtStart = fixture.log.lines.length;
    for (let call = 0; call < 3; call += 1) expect((await send(fixture, "job-1", proofPackage(), { authorization: "Bearer wrong" })).status).toBe(401);
    expect(fixture.reads.length).toBe(readsAtStart);
    expect(fixture.log.lines).toHaveLength(linesAtStart);
  });

  it("never logs the bearer token", async () => {
    const fixture = setup();
    await send(fixture, createProvingJob(fixture), proofPackage());
    await settled(fixture.context);
    await send(fixture, "job-1", proofPackage(), { authorization: "Bearer other" });
    expect(fixture.log.lines.join("\n")).not.toContain(TOKEN);
  });

  it("is the module that the backend runs under the name webhook", () => {
    expect(MODULES.webhook.health).toBeTypeOf("function");
  });
});

describe("the oracle setting", () => {
  const oracleProof = `0x${"ab".repeat(65)}`;

  it("stores an oracle proof as version 2 when acceptOracleProof is on", async () => {
    const fixture = setup({ config: { acceptOracleProof: true } });
    const jobId = createProvingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage({ proof: oracleProof }));
    await settled(fixture.context);
    expect(answer.status).toBe(202);
    const payload = storedRow(fixture).payload as Hex;
    expect(decodeProofMessage(payload, { acceptOracleProof: true }).version).toBe(2);
    expect(fixture.verifications).toHaveLength(0);
  });

  it("refuses an oracle proof by default, and keeps the strict form for a full proof when it is on", async () => {
    const strict = setup();
    expect((await send(strict, createProvingJob(strict), proofPackage({ proof: oracleProof }))).status).toBe(422);
    const lenient = setup({ config: { acceptOracleProof: true } });
    const answer = await send(lenient, createProvingJob(lenient), proofPackage());
    await settled(lenient.context);
    expect(answer.status).toBe(202);
    expect(decodeProofMessage(storedRow(lenient).payload as Hex).version).toBe(1);
  });
});

describe("the real outside world", () => {
  let server: Server | null = null;
  afterEach(async () => {
    const open = server;
    server = null;
    if (open !== null) await new Promise<void>((resolve) => open.close(() => resolve()));
  });

  it("builds a board publisher without opening a connection", () => {
    expect(REAL_SOURCE.makeBoard("http://board.invalid", memoryLogger().logger).post).toBeTypeOf("function");
    expect(REAL_SOURCE.environment).toBe(process.env);
  });

  it("reads the head, its root and the program key of a light client over JSON-RPC", async () => {
    const answers: Record<string, unknown> = { head: 123n, programVKey: PROGRAM_KEY, headers: START_ROOT };
    const listening = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        const call = JSON.parse(text) as { id: number; method: string; params: [{ data: Hex }, string?] };
        response.setHeader("content-type", "application/json");
        if (call.method === "eth_blockNumber") return response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x10" }));
        // Every read names the block of eth_blockNumber, so the three answers come from one state.
        if (call.params[1] !== "0x10") return response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "unpinned read" } }));
        const { functionName } = decodeFunctionData({ abi: beaconLightClientAbi, data: call.params[0].data });
        const result = encodeFunctionResult({ abi: beaconLightClientAbi, functionName: functionName as "head", result: answers[functionName] as never });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      });
    });
    server = listening;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const { port } = listening.address() as { port: number };
    const head = await REAL_SOURCE.readLightClient({ rpcUrl: `http://127.0.0.1:${port}`, lightClient: `0x${"b".repeat(40)}` });
    expect(head).toEqual({ headSlot: 123n, headRoot: START_ROOT, programKey: PROGRAM_KEY });
  });
});
