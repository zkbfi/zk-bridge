import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { openStore } from "../src/store.ts";
import type { CheckDefinition, CheckResult } from "../src/types.ts";

const NOW = 2 * 86_400_000;
const defs: CheckDefinition[] = [
  { id: "a", name: "Alpha", section: "services", run: async () => ({ state: "ok", detail: "" }) },
  { id: "b", name: "Beta", section: "chains", run: async () => ({ state: "ok", detail: "" }) },
  { id: "c", name: "Gamma", section: "chains", run: async () => ({ state: "ok", detail: "" }) },
];
const info = Object.fromEntries(defs.map((def) => [def.id, { name: def.name, section: def.section }]));
const result = (id: string, at: number, state: CheckResult["state"], detail = "d"): CheckResult => ({ id, at, state, latencyMs: 7, detail });

function setup(results: CheckResult[] = []) {
  const store = openStore(":memory:");
  store.record(results, info);
  const app = createServer({ store, checks: defs, now: () => NOW, intervalSeconds: 60 });
  return { app, store };
}
const get = async (app: ReturnType<typeof setup>["app"], path: string, init?: RequestInit) => {
  const response = await app.request(path, init);
  return { response, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
};

describe("GET /api/status", () => {
  it("lists the sections in order with the current state and the uptime of every check", async () => {
    const { app } = setup([result("a", NOW - 1000, "ok", "fine"), result("b", NOW - 1000, "down", "broken")]);
    const { response, body } = await get(app, "/api/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.summary.status).toBe("down");
    expect(body.generatedAt).toBe(NOW);
    expect(body.sections.map((section: { id: string }) => section.id)).toEqual(["services", "chains"]);
    expect(body.sections[0]).toMatchObject({ title: "Services" });
    expect(body.sections[0].checks[0]).toEqual({
      id: "a", name: "Alpha", state: "ok", detail: "fine", latencyMs: 7, checkedAt: NOW - 1000, since: NOW - 1000,
      uptime: { "24h": { runs: 1, uptime: 100, ok: 100 }, "7d": { runs: 1, uptime: 100, ok: 100 }, "30d": { runs: 1, uptime: 100, ok: 100 } },
    });
    expect(body.sections[1].checks[1]).toMatchObject({ id: "c", state: "pending", detail: "No result yet.", latencyMs: null, checkedAt: null, since: null, uptime: { "24h": null, "7d": null, "30d": null } });
  });
});

describe("GET /api/summary", () => {
  it("answers 200 while operational or degraded and 503 when down", async () => {
    const ok = await get(setup([result("a", NOW - 10, "ok"), result("b", NOW - 10, "ok"), result("c", NOW - 10, "ok")]).app, "/api/summary");
    expect(ok.response.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "operational", checks: 3 });
    const degraded = setup([result("a", NOW - 10, "degraded", "slow")]);
    expect((await get(degraded.app, "/api/summary")).response.status).toBe(200);
    expect((await get(degraded.app, "/api/summary?strict=1")).response.status).toBe(503);
    const down = await get(setup([result("a", NOW - 10, "down", "gone")]).app, "/api/summary");
    expect(down.response.status).toBe(503);
    expect(down.body.message).toBe("Down: Alpha: gone.");
  });

  it("is down when the checks stopped running", async () => {
    const { response, body } = await get(setup([result("a", NOW - 10 * 60_000, "ok")]).app, "/api/summary");
    expect(response.status).toBe(503);
    expect(body.status).toBe("down");
  });
});

describe("GET /api/history", () => {
  const rows = () => setup([result("a", NOW - 1, "ok"), result("a", NOW - 2_000_000, "down", "x"), result("b", NOW - 1, "degraded", "y")]);

  it("gives the bars of one check, with its problems", async () => {
    const { body, response } = await get(rows().app, "/api/history?check=a&window=24h");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ window: "24h", buckets: 48, from: NOW - 86_400_000, to: NOW });
    expect(Object.keys(body.checks)).toEqual(["a"]);
    expect(body.checks.a).toHaveLength(48);
    expect(body.problems).toEqual([{ at: NOW - 2_000_000, state: "down", detail: "x" }]);
  });

  it("gives all checks when none is named, and defaults to 24 h", async () => {
    const { body } = await get(rows().app, "/api/history");
    expect(Object.keys(body.checks).sort()).toEqual(["a", "b"]);
    expect(body.window).toBe("24h");
    expect(body.problems).toBeUndefined();
  });

  it("refuses an unknown window or check", async () => {
    const { app } = rows();
    expect((await get(app, "/api/history?window=1y")).response.status).toBe(400);
    const unknown = await get(app, "/api/history?check=zzz");
    expect(unknown.response.status).toBe(404);
    expect(unknown.body).toEqual({ error: "unknown check" });
  });
});

describe("the page and the rest", () => {
  it("serves the page with a tight content policy", async () => {
    const { response, body } = await get(setup().app, "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toContain("<title>zkb.fi status</title>");
    expect(body).toContain("/api/status");
    expect(body).not.toMatch(/https?:\/\//);
  });

  it("allows only reads: CORS preflight and no writes", async () => {
    const { app } = setup();
    const preflight = await app.request("/api/status", { method: "OPTIONS", headers: { origin: "https://zkb.fi", "access-control-request-method": "GET" } });
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET,HEAD,OPTIONS");
    expect((await app.request("/api/status", { method: "POST" })).status).toBe(404);
  });

  it("answers 404 in JSON for any other path", async () => {
    const { response, body } = await get(setup().app, "/nope");
    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "not found" });
  });
});
