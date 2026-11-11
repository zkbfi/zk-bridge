import { describe, expect, it } from "vitest";
import { BackendClientError, createBackendClient } from "../src/backend-client.js";
import type { JsonResponse } from "../src/connection.js";
import {
  GPU_STEP_KINDS,
  REQUESTABLE_STEP_KINDS,
  ROUTE_STEP_KINDS,
  STEP_TITLES,
  blockingStepOf,
  isRequestableKind,
  routeBlockersOf,
  routeStepSchema,
  stepFlow,
  stepIdOf,
  stepProofSchema,
  usesGpu,
  type RouteStep,
  type StepJob,
} from "../src/route-steps.js";

const HASH = `0x${"ab".repeat(32)}`;
const ADDRESS = `0x${"12".repeat(20)}`;

/** A pending light client update of first-to-second, with every field set. */
export const lightClientStep = (overrides: Partial<RouteStep> = {}): RouteStep => ({
  id: "light-client-update:first-to-second",
  kind: "light-client-update",
  subject: "first-to-second",
  direction: "first-to-second",
  chainId: 943,
  target: ADDRESS,
  messageId: null,
  situation: { since: 1_000, behindSeconds: 3_600, waitingTransfers: 3, blocks: ["deliveries"], strandsAt: 50_000_000, layoutRows: null, activeVersion: null, recordedVersion: null },
  constraints: {
    finality: { finalizedSlot: 100, nextAt: 2_000 },
    gpu: { warmMs: 60_000, coldMs: 300_000, workerWarm: false, budgetUsd: 5, spentUsd: 1, leftUsd: 4 },
    job: null,
    proofReady: false,
    posting: { gas: "337000", gasSource: "fallback", gasPriceWei: "1000", costWei: "337000000" },
    after: null,
  },
  fallback: { by: "backend", at: 43_200_000 },
  ...overrides,
});

const job = (status: StepJob["status"], error: string | null = null): StepJob => ({ jobId: "job:1", kind: "light-client-update", subject: "first-to-second", status, startedAt: 10, updatedAt: 20, etaAt: 90, error });

describe("the step kinds", () => {
  it("name every kind, mark the GPU ones and the ones the backend makes", () => {
    expect(ROUTE_STEP_KINDS.every((kind) => STEP_TITLES[kind].length > 0)).toBe(true);
    expect(GPU_STEP_KINDS).toEqual(["light-client-update", "registry-light-client-update", "fork-observation"]);
    expect(usesGpu("deliver")).toBe(false);
    expect(usesGpu("fork-observation")).toBe(true);
    expect(REQUESTABLE_STEP_KINDS).not.toContain("seal");
    expect(isRequestableKind("open-deposits")).toBe(true);
    expect(isRequestableKind("seal")).toBe(false);
    expect(stepIdOf("deliver", HASH)).toBe(`deliver:${HASH}`);
  });

  it("parse a step and refuse one with a bad kind", () => {
    expect(routeStepSchema.parse(lightClientStep())).toMatchObject({ kind: "light-client-update" });
    expect(routeStepSchema.safeParse({ ...lightClientStep(), kind: "mint" }).success).toBe(false);
  });

  it("parse each kind of proof", () => {
    expect(stepProofSchema.parse({ kind: "light-client-update", subject: "first-to-second", chainId: 943, payload: "0x00", startSlot: 1, newSlot: 2, provedAt: 3, where: "stored" }).kind).toBe("light-client-update");
    expect(stepProofSchema.parse({ kind: "open-deposits", subject: "second-to-first", chainId: 1, bridge: ADDRESS, calldata: "0x00", remoteSlot: 1, storedSlot: 2, remoteBlockNumber: 3, provedAt: 4 }).kind).toBe("open-deposits");
    expect(stepProofSchema.safeParse({ kind: "seal", subject: "943" }).success).toBe(false);
  });
});

describe("stepFlow", () => {
  const base = { kind: "light-client-update" as const, pending: lightClientStep(), job: null, proofReady: false, transaction: null };

  it("ends at the visitor's own transaction, and stops when someone else posted", () => {
    expect(stepFlow({ ...base, transaction: HASH })).toEqual({ phase: "done", transaction: HASH });
    expect(stepFlow({ ...base, pending: null })).toEqual({ phase: "posted-elsewhere" });
  });

  it("offers the post once a proof is made, and at once for a seal", () => {
    expect(stepFlow({ ...base, proofReady: true })).toEqual({ phase: "post" });
    expect(stepFlow({ ...base, pending: lightClientStep({ constraints: { ...lightClientStep().constraints, proofReady: true } }) })).toEqual({ phase: "post" });
    expect(stepFlow({ ...base, kind: "seal" })).toEqual({ phase: "post" });
  });

  it("follows the job, its own or the one the list shows, and its failure", () => {
    expect(stepFlow({ ...base, job: job("queued") })).toEqual({ phase: "proving", jobId: "job:1", startedAt: 10, etaAt: 90 });
    expect(stepFlow({ ...base, job: job("running") })).toMatchObject({ phase: "proving" });
    const listed = lightClientStep({ constraints: { ...lightClientStep().constraints, job: { jobId: "job:9", status: "proving", startedAt: 5 } } });
    expect(stepFlow({ ...base, pending: listed })).toEqual({ phase: "proving", jobId: "job:9", startedAt: 5, etaAt: null });
    expect(stepFlow({ ...base, job: job("failed", "the prover stopped") })).toEqual({ phase: "failed", error: "the prover stopped" });
    expect(stepFlow({ ...base, job: job("failed") })).toEqual({ phase: "failed", error: "the proof could not be made" });
    // A done job whose proof is not read yet: make again (the request answers `ready`).
    expect(stepFlow({ ...base, job: job("done") })).toEqual({ phase: "make", retryAt: null, note: null });
  });

  it("keeps the refusal's words and wait", () => {
    expect(stepFlow({ ...base, refusal: { note: "budget spent", retryAt: 99 } })).toEqual({ phase: "make", retryAt: 99, note: "budget spent" });
  });
});

describe("blockingStepOf and routeBlockersOf", () => {
  const deliver = lightClientStep({ id: `deliver:${HASH}`, kind: "deliver", subject: HASH, messageId: HASH, direction: "first-to-second" });

  it("finds the transfer's own step first, then its direction's update unless covered", () => {
    expect(blockingStepOf([lightClientStep(), deliver], { messageId: HASH.toUpperCase().replace("0X", "0x"), direction: "first-to-second", covered: true })).toBe(deliver);
    expect(blockingStepOf([lightClientStep()], { messageId: HASH, direction: "first-to-second", covered: false })?.kind).toBe("light-client-update");
    expect(blockingStepOf([lightClientStep()], { messageId: HASH, direction: "first-to-second", covered: true })).toBeNull();
    expect(blockingStepOf([lightClientStep()], { messageId: HASH, direction: "second-to-first", covered: false })).toBeNull();
  });

  it("lists closed deposits, seals and light clients near stranding", () => {
    const open = lightClientStep({ kind: "open-deposits", id: "open-deposits:first-to-second" });
    const seal = lightClientStep({ kind: "seal", id: "seal:943" });
    const far = lightClientStep({ situation: { ...lightClientStep().situation, strandsAt: 100 * 3_600_000 } });
    const near = lightClientStep({ situation: { ...lightClientStep().situation, strandsAt: 5 * 3_600_000 } });
    const unknown = lightClientStep({ situation: { ...lightClientStep().situation, strandsAt: null } });
    expect(routeBlockersOf([open, seal, far, near, unknown, deliver], 0)).toEqual([open, seal, near]);
    expect(routeBlockersOf([far], 0, 200)).toEqual([far]);
  });
});

function clientAnswering(responses: Record<string, JsonResponse>) {
  const seen: Array<{ url: string; init?: unknown }> = [];
  const answer = (url: string, init?: unknown): JsonResponse => {
    seen.push({ url, init });
    return responses[url.replace("https://backend.example.org", "")] ?? { status: 599, body: null };
  };
  const client = createBackendClient({ baseUrl: "https://backend.example.org", fetchJson: async (url) => answer(url), postJson: async (url, init) => answer(url, init) });
  return { client, seen };
}

describe("the backend client's step reads", () => {
  it("reads the route steps and refuses another status", async () => {
    const good = clientAnswering({ "/route/steps": { status: 200, body: { now: 1, steps: [lightClientStep()], unread: [] } } });
    expect((await good.client.routeSteps()).steps).toHaveLength(1);
    await expect(clientAnswering({}).client.routeSteps()).rejects.toThrow(BackendClientError);
  });

  it("asks for a step and gives each refusal as a value", async () => {
    const at = (status: number, body: unknown) => clientAnswering({ "/steps/requests": { status, body } }).client.requestStep({ pair: "eth-pls", kind: "deliver", subject: HASH });
    expect(await at(202, { jobId: "step:1" })).toEqual({ jobId: "step:1" });
    expect(await at(202, { jobId: "step:1", joined: true, ready: true })).toEqual({ jobId: "step:1", joined: true, ready: true });
    expect(await at(409, { error: "nothing-to-prove", why: "no-need" })).toEqual({ refused: "nothing-to-prove", why: "no-need" });
    expect(await at(409, { error: "nothing-to-prove" })).toEqual({ refused: "nothing-to-prove" });
    expect(await at(429, { error: "rate-limited", retryAfterSeconds: 5, why: "gpu-budget", detail: "spent" })).toEqual({ refused: "rate-limited", retryAfterSeconds: 5, why: "gpu-budget", detail: "spent" });
    expect(await at(429, { error: "rate-limited", retryAfterSeconds: 5 })).toEqual({ refused: "rate-limited", retryAfterSeconds: 5 });
    expect(await at(503, { error: "cannot-check", retryAfterSeconds: 30 })).toEqual({ refused: "cannot-check", retryAfterSeconds: 30 });
    expect(await at(404, { error: "not-served", detail: "the seal module is off" })).toEqual({ refused: "not-served", detail: "the seal module is off" });
    expect(await at(404, { error: "not-served" })).toEqual({ refused: "not-served" });
    await expect(at(500, {})).rejects.toThrow(BackendClientError);
    const { client, seen } = clientAnswering({ "/steps/requests": { status: 202, body: { jobId: "x" } } });
    await client.requestStep({ pair: "eth-pls", kind: "light-client-update", subject: "first-to-second" });
    expect(JSON.parse((seen[0]?.init as { body: string }).body)).toEqual({ pair: "eth-pls", kind: "light-client-update", subject: "first-to-second" });
  });

  it("reads a job and a proof, null when unknown", async () => {
    const { client } = clientAnswering({
      "/steps/jobs/job%3A1": { status: 200, body: job("running") },
      "/steps/proofs/deliver/0x12": { status: 404, body: { error: "none" } },
    });
    expect(await client.stepJob("job:1")).toMatchObject({ status: "running" });
    expect(await clientAnswering({ "/steps/jobs/x": { status: 404, body: {} } }).client.stepJob("x")).toBeNull();
    await expect(clientAnswering({}).client.stepJob("x")).rejects.toThrow(BackendClientError);
    expect(await client.stepProof("deliver", "0x12")).toBeNull();
    const proof = { kind: "light-client-update", subject: "first-to-second", chainId: 943, payload: "0x00", startSlot: 1, newSlot: 2, provedAt: 3, where: "board" };
    expect(await clientAnswering({ "/steps/proofs/light-client-update/first-to-second": { status: 200, body: proof } }).client.stepProof("light-client-update", "first-to-second")).toEqual(proof);
    await expect(clientAnswering({}).client.stepProof("deliver", "0x12")).rejects.toThrow(BackendClientError);
  });
});
