import { describe, expect, it } from "vitest";
import { MODULES } from "../src/main.ts";
import { postFrom, makeBackend } from "./support.ts";

const ALL = ["requests", "webhook", "msgboard-indexer", "archive"] as const;

describe("cross-origin access", () => {
  it("answers GET and POST /requests from another origin with Access-Control-Allow-Origin *, and OPTIONS with the allowed methods", async () => {
    const backend = makeBackend();
    const origin = "https://bafybeigdyrzt.ipfs.dweb.link";
    const posted = postFrom("10.0.0.1");
    const post = await backend.app.request("/requests", { ...posted.init, headers: { ...posted.init.headers, origin } }, posted.env);
    expect(post.status).toBe(202);
    expect(post.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const requestId = ((await post.json()) as { requestId: string }).requestId;

    const get = await backend.app.request(`/requests/${requestId}`, { headers: { origin } });
    expect(get.status).toBe(200);
    expect(get.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const preflight = await backend.app.request("/requests", {
      method: "OPTIONS",
      headers: { origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const methods = preflight.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("content-type");
  });

  it("lets a page read Retry-After on an answer from another origin", async () => {
    const backend = makeBackend();
    const answer = await backend.app.request("/health", { headers: { origin: "https://x.example" } });
    expect(answer.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(answer.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  });
});

describe("health and stub modules", () => {
  it("GET /health reports each module, the queue length and the last job per direction", async () => {
    const backend = makeBackend({ enabled: ["requests", "webhook"] });
    const first = postFrom("10.0.0.1");
    await backend.app.request("/requests", first.init, first.env);
    const report = (await (await backend.app.request("/health")).json()) as {
      status: string;
      modules: Record<string, { state: string }>;
      queue: { length: number };
      lastJobs: Record<string, { status: string } | null>;
    };
    expect(report.status).toBe("ok");
    expect(report.modules).toEqual({ requests: { state: "running" }, webhook: { state: "not built" } });
    expect(report.queue.length).toBe(0);
    expect(report.lastJobs["first-to-second"]?.status).toBe("proving");
    expect(report.lastJobs["second-to-first"]).toBeNull();
  });

  it("reports every stub module as not built", async () => {
    const backend = makeBackend({ enabled: ALL });
    const report = (await (await backend.app.request("/health")).json()) as { modules: Record<string, { state: string }> };
    expect(Object.values(report.modules).map((module) => module.state)).toEqual(["running", "not built", "not built", "not built"]);
  });

  it("counts jobs that wait for the prover in the queue", async () => {
    const backend = makeBackend();
    backend.storage.database.prepare("INSERT INTO jobs (id, direction, status, created_at, updated_at) VALUES ('q', 'first-to-second', 'queued', 1, 1)").run();
    const report = (await (await backend.app.request("/health")).json()) as { queue: { length: number } };
    expect(report.queue.length).toBe(1);
  });

  it.each([
    ["/webhook/jobs/abc", "POST"],
    ["/proofs/latest/first-to-second", "GET"],
    ["/evidence/0x00", "GET"],
  ])("a stub module answers 503: %s", async (path, method) => {
    const backend = makeBackend({ enabled: ALL });
    const answer = await backend.app.request(path, { method });
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: "module not built" });
  });

  it("a stub starts and stops without work", async () => {
    const backend = makeBackend();
    for (const name of ["webhook", "msgboard-indexer", "archive"] as const) {
      const stop = await MODULES[name].start(backend.context);
      await expect(stop()).resolves.toBeUndefined();
    }
  });

  it("does not register a module that is not enabled", async () => {
    const backend = makeBackend({ enabled: ["requests"] });
    expect((await backend.app.request("/webhook/jobs/abc", { method: "POST" })).status).toBe(404);
  });
});
