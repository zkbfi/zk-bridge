import { describe, expect, it } from "vitest";
import { MODULES } from "../src/main.ts";
import { NOT_CONFIGURED_TEXT, configureWebhook } from "../src/webhook/module.ts";
import { SECRETS, makeBackend, makeConfig, postFrom } from "./support.ts";

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

describe("health of the real modules", () => {
  type Report = {
    status: string;
    modules: Record<string, { state: string; detail?: string }>;
    queue: { length: number };
    lastJobs: Record<string, { status: string } | null>;
  };
  const healthOf = async (backend: ReturnType<typeof makeBackend>) => (await (await backend.app.request("/health")).json()) as Report;

  it("GET /health reports each module, the queue length and the last job per direction", async () => {
    const backend = makeBackend({ enabled: ["requests", "archive"] });
    const first = postFrom("10.0.0.1");
    await backend.app.request("/requests", first.init, first.env);
    const report = await healthOf(backend);
    expect(report.status).toBe("ok");
    expect(report.modules.requests).toEqual({ state: "running" });
    expect(report.modules.archive).toEqual({ state: "degraded", detail: "indexerUrl is not set; handoff capture off; fork proof capture off" });
    expect(report.queue.length).toBe(0);
    expect(report.lastJobs["first-to-second"]?.status).toBe("proving");
    expect(report.lastJobs["second-to-first"]).toBeNull();
  });

  it("names the bearer variable for the webhook when it is not set, and answers 503", async () => {
    const backend = makeBackend({ enabled: ALL, config: makeConfig({ msgboardUrl: "http://board.invalid" }) });
    configureWebhook(backend.context, { environment: {} });
    const report = await healthOf(backend);
    expect(report.modules.webhook).toEqual({ state: "degraded", detail: "set the environment variable BACKEND_WEBHOOK_BEARER" });
    const answer = await backend.app.request("/webhook/jobs/abc", { method: "POST" });
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: NOT_CONFIGURED_TEXT });
  });

  it("reports the webhook as running when its settings are usable", async () => {
    const backend = makeBackend({ enabled: ["webhook"], config: makeConfig({ msgboardUrl: "http://board.invalid" }) });
    configureWebhook(backend.context, { environment: { BACKEND_WEBHOOK_BEARER: SECRETS.webhookBearer }, makeBoard: () => ({ post: async () => ({ messageHash: `0x${"99".repeat(32)}`, grindMilliseconds: 1, difficulty: 367_772n, threads: 4 }) }) });
    expect((await healthOf(backend)).modules.webhook).toEqual({ state: "running" });
  });

  it("reports the msgboard indexer as degraded until it starts, and the archive counts once it has an indexer", async () => {
    const backend = makeBackend({ enabled: ALL, config: makeConfig({ indexerUrl: "http://127.0.0.1:1" }) });
    const report = await healthOf(backend);
    expect(report.modules["msgboard-indexer"]).toEqual({ state: "degraded", detail: "not started" });
    expect(report.modules.archive?.state).toBe("running");
    expect(report.modules.archive?.detail).toContain("0 entries");
  });

  it("counts jobs that wait for the prover in the queue", async () => {
    const backend = makeBackend();
    backend.storage.database.prepare("INSERT INTO jobs (id, direction, status, created_at, updated_at) VALUES ('q', 'first-to-second', 'queued', 1, 1)").run();
    expect((await healthOf(backend)).queue.length).toBe(1);
  });

  it("the msgboard indexer route answers 503 while it is not running, and the archive route checks the id", async () => {
    const backend = makeBackend({ enabled: ALL });
    const proofs = await backend.app.request("/proofs/latest/first-to-second");
    expect(proofs.status).toBe(503);
    expect(await proofs.json()).toEqual({ error: "the msgboard indexer is not running" });
    expect((await backend.app.request("/evidence/0x00")).status).toBe(400);
  });

  it("the msgboard indexer refuses to start without msgboardUrl, and the archive starts without work when it has no indexer", async () => {
    const backend = makeBackend();
    await expect(MODULES["msgboard-indexer"].start(backend.context)).rejects.toThrow("msgboardUrl");
    const stop = await MODULES.archive.start(backend.context);
    await expect(stop()).resolves.toBeUndefined();
  });

  it("does not register a module that is not enabled", async () => {
    const backend = makeBackend({ enabled: ["requests"] });
    expect((await backend.app.request("/webhook/jobs/abc", { method: "POST" })).status).toBe(404);
  });
});
