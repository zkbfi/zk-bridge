/**
 * Red team: the webhook that receives proofs from the prover (bearer, job ids, replays, bad proofs, leaks).
 */
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import type { BoardPublisher } from "@zk-bridge/shared/msgboard";
import type { LightClientHead, ProverBinary } from "@zk-bridge/shared/prover";
import { PROGRAM_KEY, publicValuesFor, word } from "../../../shared/test/support/prover-builders.ts";
import { getJob, insertJob, updateJob } from "../../src/requests/jobs.ts";
import { configureWebhook, start as startWebhook } from "../../src/webhook/module.ts";
import { ensureProofTable } from "../../src/webhook/receive.ts";
import { SECRETS, controllableProver, makeBackend, makeConfig } from "../support.ts";

const TOKEN = SECRETS.webhookBearer;
const START_ROOT = word(0x21);
const NEW_ROOT = word(0x22);
const HEAD: LightClientHead = { headSlot: 100n, headRoot: START_ROOT, programKey: PROGRAM_KEY };

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
    createdAt: "2026-10-28T00:00:00Z",
    ...overrides,
  };
}

function setup(options: { environment?: Record<string, string>; verify?: ProverBinary["verify"]; config?: Record<string, unknown>; boardFailure?: Error } = {}) {
  const posts: Array<{ category: Hex; payload: Hex }> = [];
  const state = { head: HEAD, headFailure: null as Error | null };
  const verifications: unknown[] = [];
  const board: BoardPublisher = {
    async post(input) {
      if (options.boardFailure !== undefined) throw options.boardFailure;
      posts.push(input);
      return { messageHash: word(0x99), grindMilliseconds: 1 };
    },
  };
  const controllable = controllableProver();
  const prover = { ...controllable, binary: { ...controllable.binary, verify: options.verify ?? (async (input) => void verifications.push(input)) } satisfies ProverBinary };
  const backend = makeBackend({ prover, enabled: ["requests", "webhook"], config: makeConfig({ msgboardUrl: "http://board.invalid", ...options.config }) });
  configureWebhook(backend.context, {
    environment: options.environment ?? { BACKEND_WEBHOOK_BEARER: TOKEN },
    makeBoard: () => board,
    async readLightClient() {
      if (state.headFailure !== null) throw state.headFailure;
      return state.head;
    },
  });
  return { ...backend, posts, state, verifications };
}

type Fixture = ReturnType<typeof setup>;

function provingJob(fixture: Fixture, direction: ProofDirection = "first-to-second", id = "job-1") {
  insertJob(fixture.storage, { id, direction, now: fixture.clock.now() });
  updateJob(fixture.storage, id, { status: "proving" }, fixture.clock.now(), ["queued"]);
  return id;
}

const send = (fixture: Fixture, jobId: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  fixture.app.request(`/webhook/jobs/${jobId}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const stored = (fixture: Fixture) => {
  ensureProofTable(fixture.storage);
  return fixture.storage.database.prepare("SELECT * FROM webhook_proofs").all() as Array<Record<string, unknown>>;
};

describe("authentication", () => {
  it("ATTACK forged webhook posts without the bearer (missing, wrong case, lowercase scheme, prefix, padded, Basic) are refused before any check", async () => {
    const fixture = setup();
    const jobId = provingJob(fixture);
    for (const authorization of [undefined, `bearer ${TOKEN}`, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}x`, `Bearer  ${TOKEN}`, `Basic ${TOKEN}`, `Bearer ${TOKEN.toUpperCase()}`]) {
      const answer = await send(fixture, jobId, proofPackage(), authorization === undefined ? {} : { authorization });
      expect(answer.status).toBe(401);
    }
    expect(fixture.verifications).toHaveLength(0);
    expect(stored(fixture)).toHaveLength(0);
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
  });

  it("ATTACK an unset or empty bearer variable never opens the webhook (an empty Bearer header does not match an empty token)", async () => {
    for (const environment of [{}, { BACKEND_WEBHOOK_BEARER: "" }] as Array<Record<string, string>>) {
      const fixture = setup({ environment });
      const jobId = provingJob(fixture);
      for (const headers of [{}, { authorization: "Bearer " }, { authorization: "Bearer" }] as Array<Record<string, string>>) expect((await send(fixture, jobId, proofPackage(), headers)).status).toBe(503);
      expect(stored(fixture)).toHaveLength(0);
    }
  });

  it("ATTACK an unauthenticated 1 MB body is refused at the bearer check, before the body is read", async () => {
    const fixture = setup();
    const jobId = provingJob(fixture);
    expect((await send(fixture, jobId, { pad: "x".repeat(1_000_000) }, {})).status).toBe(401);
    expect((await send(fixture, jobId, { pad: "x".repeat(1_000_000) })).status).toBe(413);
  });

  it("ATTACK job ids are public (GET /directions shows them), so guessing gains nothing: the bearer is the only gate", async () => {
    const fixture = setup();
    const answer = await fixture.app.request("/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pair: "eth-pls", direction: "first-to-second", reason: "user" }) }, { incoming: { socket: { remoteAddress: "1.2.3.4" } } });
    const { jobId } = (await answer.json()) as { jobId: string };
    const shown = (await (await fixture.app.request("/directions/first-to-second")).json()) as { job: { jobId: string } };
    expect(shown.job.jobId).toBe(jobId);
    expect((await send(fixture, jobId, proofPackage(), { authorization: "Bearer guess" })).status).toBe(401);
  });
});

describe("replays and bad proofs with a valid bearer", () => {
  it("ATTACK a replay or a second, different package for a job that holds a proof changes nothing", async () => {
    const fixture = setup();
    const jobId = provingJob(fixture);
    expect((await send(fixture, jobId, proofPackage())).status).toBe(202);
    const first = stored(fixture)[0]!.payload;
    fixture.state.head = { ...HEAD, headSlot: 150n };
    const other = proofPackage({ newHeadSlot: 300, newHeadRoot: word(0x55), publicValues: publicValuesFor(100n, START_ROOT, 300n, word(0x55)) });
    // 202 while the proof waits for the board, 409 once it is posted: either way nothing changes.
    expect([202, 409]).toContain((await send(fixture, jobId, other)).status);
    expect([202, 409]).toContain((await send(fixture, jobId, proofPackage())).status);
    expect(stored(fixture)).toHaveLength(1);
    expect(stored(fixture)[0]!.payload).toBe(first);
    expect(fixture.verifications).toHaveLength(1);
  });

  it("ATTACK a replay after the job left proving (published, failed, on-chain) is refused with 409", async () => {
    const fixture = setup();
    for (const status of ["published", "failed", "on-chain"] as const) {
      const jobId = provingJob(fixture, "first-to-second", `job-${status}`);
      updateJob(fixture.storage, jobId, { status }, fixture.clock.now(), ["proving"]);
      expect((await send(fixture, jobId, proofPackage())).status).toBe(409);
    }
    expect(stored(fixture)).toHaveLength(0);
  });

  it("ATTACK a post to an unknown job id, or a path-traversal job id, finds no job", async () => {
    const fixture = setup();
    provingJob(fixture);
    for (const jobId of ["nope", "job-1'--", "..%2Fjob-1", "job-1%00"]) expect((await send(fixture, jobId, proofPackage())).status).toBe(404);
    expect(stored(fixture)).toHaveLength(0);
  });

  it("ATTACK an oracle proof (65 bytes) is refused when acceptOracleProof is false", async () => {
    const fixture = setup();
    const jobId = provingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage({ proof: `0x${"ab".repeat(65)}` }));
    expect(answer.status).toBe(422);
    expect(stored(fixture)).toHaveLength(0);
    expect(fixture.verifications).toHaveLength(0);
  });

  it("ATTACK a proof of the other direction (its start is the other light client's head) is refused", async () => {
    const fixture = setup();
    const jobId = provingJob(fixture, "second-to-first");
    const otherRoot = word(0x77);
    const answer = await send(fixture, jobId, proofPackage({ route: "pulsechain_to_ethereum", startHeadRoot: otherRoot, publicValues: publicValuesFor(100n, otherRoot, 200n, NEW_ROOT) }));
    expect(answer.status).toBe(422);
    expect(((await answer.json()) as { reason: string }).reason).toBe("start-root-differs-from-head");
    expect(stored(fixture)).toHaveLength(0);
  });

  it("ATTACK a stale proof (start below the head, or ending at the head) is refused and never stored", async () => {
    for (const [startSlot, newSlot, reason] of [[90, 200, "start-slot-differs-from-head"], [50, 100, "already-stored"]] as const) {
      const fixture = setup();
      const jobId = provingJob(fixture);
      const answer = await send(fixture, jobId, proofPackage({ startHeadSlot: startSlot, newHeadSlot: newSlot, publicValues: publicValuesFor(BigInt(startSlot), START_ROOT, BigInt(newSlot), NEW_ROOT) }));
      expect(((await answer.json()) as { reason: string }).reason).toBe(reason);
      expect(stored(fixture)).toHaveLength(0);
    }
  });

  it("ATTACK a package whose header disagrees with its public values is refused", async () => {
    const fixture = setup();
    const jobId = provingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage({ newHeadSlot: 999 }));
    expect(answer.status).toBe(422);
    expect(stored(fixture)).toHaveLength(0);
  });

  it("ATTACK a Groth16 proof that does not verify is refused, and the verifier error text (with an endpoint key) is not echoed", async () => {
    const fixture = setup({ verify: async () => { throw new Error(`verify failed at https://rpc.example/v3/${SECRETS.runpodApiKey}`); } });
    const jobId = provingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage());
    const text = await answer.text();
    expect(answer.status).toBe(422);
    expect(text).not.toContain(SECRETS.runpodApiKey);
    expect(text).not.toContain("rpc.example");
    expect(getJob(fixture.storage, jobId)?.error).not.toContain("rpc.example");
    for (const line of fixture.log.lines) expect(line).not.toContain(SECRETS.runpodApiKey);
  });

  it("ATTACK a light client read error that names the RPC endpoint is not echoed and keeps the job proving", async () => {
    const fixture = setup();
    fixture.state.headFailure = new Error("HTTP request failed. URL: https://rpc.example/v3/abcdefabcdefabcdefabcdef");
    const jobId = provingJob(fixture);
    const answer = await send(fixture, jobId, proofPackage());
    expect(answer.status).toBe(503);
    expect(await answer.text()).not.toContain("rpc.example");
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
  });
});

describe("posting to the board", () => {
  it("ATTACK a board that is slow or down for longer than prover.timeoutSeconds no longer loses a paid GPU proof (BLOCKED, was K-3)", async () => {
    const fixture = setup({ boardFailure: new Error("board down") });
    const request = (remoteAddress: string) =>
      fixture.app.request("/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pair: "eth-pls", direction: "first-to-second", reason: "user" }) }, { incoming: { socket: { remoteAddress } } });
    const { jobId } = (await (await request("1.2.3.4")).json()) as { jobId: string };
    expect((await send(fixture, jobId, proofPackage())).status).toBe(202);
    expect(stored(fixture)).toHaveLength(1);
    // The default prover timeout is 1800 s. The publisher retries with back-off (15 s doubling to 15 min, 10 tries),
    // and each attempt keeps the job alive.
    for (let tick = 0; tick < 3; tick += 1) {
      fixture.clock.advance(900_000);
      await (await startWebhook(fixture.context))();
    }
    // Any public request runs the lost-job check. The job is still being posted, so the request joins it.
    const again = await request("1.2.3.5");
    expect(((await again.json()) as { jobId: string }).jobId).toBe(jobId);
    expect(getJob(fixture.storage, jobId)?.status).toBe("proving");
    expect(stored(fixture)).toHaveLength(1);
    expect(fixture.prover.calls.length).toBe(1);
  });
});
