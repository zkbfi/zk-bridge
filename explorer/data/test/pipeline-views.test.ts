import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BackendClientError, createBackendClient } from "../src/backend-client.js";
import type { JsonResponse } from "../src/connection.js";
import { BENCHMARK_STEPS, PIPELINE_STAGES, WAITING_SERVICES, WAITING_SERVICE_TEXT, benchmarksSchema, directionPipelineSchema, transferProgressSchema } from "../src/pipeline-views.js";

/** Answers the backend gave in a test run (explorer/backend, progress routes), with the clock moved to 2026-11-01. */
const ANSWERS = JSON.parse(readFileSync(new URL("./fixtures/pipeline-answers.json", import.meta.url), "utf8")) as { progress: Record<string, unknown>; pipeline: Record<string, unknown>; benchmarks: Record<string, unknown> };
const ID = `0x${"ab".repeat(32)}` as const;

function clientAnswering(responses: Record<string, JsonResponse>) {
  const seen: string[] = [];
  const answer = (url: string): JsonResponse => {
    seen.push(url);
    return responses[url.replace("https://prove.example", "")] ?? { status: 599, body: null };
  };
  return { client: createBackendClient({ baseUrl: "https://prove.example", fetchJson: async (url) => answer(url), postJson: async (url) => answer(url) }), seen };
}

describe("the pipeline reads (2026-11-01)", () => {
  it("names every stage, service and step, and says what each service means", () => {
    expect(PIPELINE_STAGES).toEqual(["sent", "final", "batched", "proving", "proof-ready", "update-posted", "delivered"]);
    for (const service of WAITING_SERVICES) expect(WAITING_SERVICE_TEXT[service]).toMatch(/\.$/);
    expect(BENCHMARK_STEPS).toContain("proofToOnChain");
  });

  it("parses the backend's own answers", () => {
    expect(transferProgressSchema.parse(ANSWERS.progress).waitingOn.service).toBe("gpu-worker-start");
    expect(directionPipelineSchema.parse(ANSWERS.pipeline).job?.step).toBe("gpu-worker-start");
    expect(benchmarksSchema.parse(ANSWERS.benchmarks).steps.workerWait.medianMs).toBe(60_000);
  });

  it("pipeline: the rule that starts a proof is optional (an older backend omits it) and strict when given", () => {
    const rule = { minIntervalSeconds: 3600, lookaheadSeconds: 320, profitMargin: 1, proofCostUsd: "0.025000", priced: false };
    expect(directionPipelineSchema.parse({ ...ANSWERS.pipeline, rule }).rule).toEqual(rule);
    expect(directionPipelineSchema.parse(ANSWERS.pipeline).rule).toBeUndefined();
    expect(() => directionPipelineSchema.parse({ ...ANSWERS.pipeline, rule: { ...rule, priced: "no" } })).toThrow();
  });

  it("progress: the answer, null for an unknown message, an error for another status or shape", async () => {
    const { client, seen } = clientAnswering({ [`/progress/${ID}`]: { status: 200, body: ANSWERS.progress } });
    expect(await client.progress(ID)).toMatchObject({ messageId: ID, job: { jobId: "new" } });
    expect(seen).toEqual([`https://prove.example/progress/${ID}`]);
    expect(await clientAnswering({ [`/progress/${ID}`]: { status: 404, body: { error: "unknown message" } } }).client.progress(ID)).toBeNull();
    await expect(clientAnswering({ [`/progress/${ID}`]: { status: 429, body: { error: "rate-limited" } } }).client.progress(ID)).rejects.toThrow(/status 429/);
    const wrong = { ...ANSWERS.progress, waitingOn: { service: "somebody", since: 1 } };
    await expect(clientAnswering({ [`/progress/${ID}`]: { status: 200, body: wrong } }).client.progress(ID)).rejects.toThrow(BackendClientError);
  });

  it("pipeline and benchmarks: the answer, or an error", async () => {
    const { client, seen } = clientAnswering({
      "/directions/first-to-second/pipeline": { status: 200, body: ANSWERS.pipeline },
      "/benchmarks?window=24h": { status: 200, body: ANSWERS.benchmarks },
      "/benchmarks?window=7d": { status: 200, body: { ...ANSWERS.benchmarks, window: "7d" } },
    });
    expect((await client.pipeline("first-to-second")).latestJob?.jobId).toBe("new");
    expect((await client.benchmarks()).window).toBe("24h");
    expect((await client.benchmarks("7d")).window).toBe("7d");
    expect(seen.at(-1)).toBe("https://prove.example/benchmarks?window=7d");
    await expect(clientAnswering({}).client.pipeline("second-to-first")).rejects.toThrow(/status 599/);
    await expect(clientAnswering({}).client.benchmarks()).rejects.toThrow(/status 599/);
    const bad = clientAnswering({ "/benchmarks?window=24h": { status: 200, body: { ...ANSWERS.benchmarks, indexer: "maybe" } } });
    await expect(bad.client.benchmarks()).rejects.toThrow(/unknown shape/);
  });
});
