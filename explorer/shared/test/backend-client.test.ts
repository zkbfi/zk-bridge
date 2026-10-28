import { describe, expect, it } from "vitest";
import { BackendClientError, createBackendClient } from "../src/backend-client.js";
import type { JsonResponse } from "../src/connection.js";

const BASE = "https://backend.example.org/";

function clientAnswering(responses: Record<string, JsonResponse>) {
  const seen: Array<{ url: string; init?: unknown }> = [];
  const answer = (url: string, init?: unknown): JsonResponse => {
    seen.push({ url, init });
    return responses[url.replace("https://backend.example.org", "")] ?? { status: 599, body: null };
  };
  const client = createBackendClient({ baseUrl: BASE, fetchJson: async (url) => answer(url), postJson: async (url, init) => answer(url, init) });
  return { client, seen };
}

const proof = {
  pair: "eth-pls",
  direction: "first-to-second",
  programKey: `0x${"11".repeat(32)}`,
  startSlot: "10",
  startRoot: `0x${"22".repeat(32)}`,
  newSlot: "42",
  newRoot: `0x${"33".repeat(32)}`,
  publicValues: "0x00",
  proof: "0x00",
};

const job = { jobId: "j1", direction: "first-to-second", status: "proving", createdAt: 1, updatedAt: 2, startSlot: null, newSlot: null, error: null };

describe("backend client", () => {
  it("latestProof parses the proof answer and refuses a malformed one", async () => {
    const good = clientAnswering({ "/proofs/latest/first-to-second": { status: 200, body: proof } });
    expect(await good.client.latestProof("first-to-second")).toMatchObject({ startSlot: "10", newSlot: "42" });
    const bad = clientAnswering({ "/proofs/latest/first-to-second": { status: 200, body: { ...proof, newSlot: 42 } } });
    await expect(bad.client.latestProof("first-to-second")).rejects.toThrow(BackendClientError);
    const missing = clientAnswering({});
    await expect(missing.client.latestProof("first-to-second")).rejects.toThrow(/status 599/);
    const none = clientAnswering({ "/proofs/latest/second-to-first": { status: 404, body: { error: "none" } } });
    expect(await none.client.latestProof("second-to-first")).toBeNull();
  });

  it("requestProof posts the body, returns the ids, and returns a rate limit as a value", async () => {
    const accepted = clientAnswering({ "/requests": { status: 202, body: { requestId: "r1", jobId: "j1" } } });
    const request = { pair: "eth-pls", direction: "first-to-second", reason: "user" } as const;
    expect(await accepted.client.requestProof(request)).toEqual({ requestId: "r1", jobId: "j1" });
    expect(accepted.seen[0]).toMatchObject({ url: "https://backend.example.org/requests", init: { method: "POST", body: JSON.stringify(request) } });
    const limited = clientAnswering({ "/requests": { status: 429, body: { error: "rate-limited", retryAfterSeconds: 30 } } });
    expect(await limited.client.requestProof(request)).toEqual({ refused: "rate-limited", retryAfterSeconds: 30 });
    const broken = clientAnswering({ "/requests": { status: 202, body: { requestId: 5 } } });
    await expect(broken.client.requestProof(request)).rejects.toThrow(/unknown shape/);
    const refused = clientAnswering({ "/requests": { status: 400, body: {} } });
    await expect(refused.client.requestProof(request)).rejects.toThrow(/status 400/);
  });

  it("reads request and direction status", async () => {
    const status = { ...job, requestId: "r1", reason: "user", messageId: null, requestedAt: 1 };
    const { client } = clientAnswering({
      "/requests/r1": { status: 200, body: status },
      "/directions/first-to-second": { status: 200, body: { direction: "first-to-second", job } },
      "/directions/second-to-first": { status: 200, body: { direction: "second-to-first", job: null } },
    });
    expect((await client.requestStatus("r1")).status).toBe("proving");
    expect((await client.directionStatus("first-to-second")).job?.jobId).toBe("j1");
    expect((await client.directionStatus("second-to-first")).job).toBeNull();
  });

  it("refuses an unknown status word in a job", async () => {
    const { client } = clientAnswering({ "/directions/first-to-second": { status: 200, body: { direction: "first-to-second", job: { ...job, status: "done" } } } });
    await expect(client.directionStatus("first-to-second")).rejects.toThrow(BackendClientError);
    await expect(client.requestStatus("x")).rejects.toThrow(/status 599/);
    await expect(clientAnswering({}).client.directionStatus("second-to-first")).rejects.toThrow(/status 599/);
  });

  it("reads the health report", async () => {
    const report = { status: "ok", time: 1, modules: { requests: { state: "running" } }, queue: { length: 0 }, lastJobs: { "first-to-second": null } };
    const { client } = clientAnswering({ "/health": { status: 200, body: report } });
    expect((await client.health()).queue.length).toBe(0);
    await expect(clientAnswering({}).client.health()).rejects.toThrow(/status 599/);
  });

  it("returns evidence or null, and refuses a wrong shape", async () => {
    const id = `0x${"ab".repeat(32)}` as const;
    const { client } = clientAnswering({ [`/evidence/${id}`]: { status: 200, body: { schemaVersion: 1 } } });
    await expect(client.evidence(id)).rejects.toThrow(/unknown shape/);
    expect(await clientAnswering({ [`/evidence/${id}`]: { status: 404, body: null } }).client.evidence(id)).toBeNull();
    await expect(clientAnswering({}).client.evidence(id)).rejects.toThrow(/status 599/);
  });
});
