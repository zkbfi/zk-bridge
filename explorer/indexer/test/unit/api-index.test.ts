import { describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";

const mounted = vi.hoisted(() => ({ graphql: vi.fn(), client: vi.fn() }));

// The real middleware refuses to start outside a Ponder project, so the test replaces both with markers.
vi.mock("ponder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ponder")>()),
  graphql: (options: unknown): MiddlewareHandler => {
    mounted.graphql(options);
    return async (context) => context.text("graphql marker");
  },
  client: (options: unknown): MiddlewareHandler => {
    mounted.client(options);
    return async (context) => context.text("sql marker");
  },
}));

const { default: app } = await import("../../src/api/index");
const { db } = await import("./support/fake-api");

describe("the API application", () => {
  it("mounts the GraphQL interface on /graphql and the SQL interface under /sql with the read only database", async () => {
    expect(await (await app.request("/graphql")).text()).toBe("graphql marker");
    expect(await (await app.request("/sql/db")).text()).toBe("sql marker");
    expect(mounted.graphql).toHaveBeenCalledWith(expect.objectContaining({ db }));
    expect(mounted.client).toHaveBeenCalledWith(expect.objectContaining({ db }));
  });

  it("serves the routes of the explorer next to them", async () => {
    for (const path of ["/api/pair", "/api/heads", "/api/summary?now=1000", "/api/feed", "/api/undelivered", "/api/history", "/api/delivery-cost?chainId=1", "/api/counts", "/api/browse/messages", "/api/browse/proofs", "/api/browse/tokens", "/api/browse/addresses"]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });

  it("lets a page from any origin read it, as a dapp from an IPFS gateway does", async () => {
    const origin = "https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link";
    for (const path of ["/api/summary?now=1000", "/graphql"]) {
      const answer = await app.request(path, { headers: { Origin: origin } });
      expect(answer.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
    }
    const preflight = await app.request("/graphql", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("content-type");
  });
});
