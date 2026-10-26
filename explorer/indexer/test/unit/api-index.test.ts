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
    for (const path of ["/api/pair", "/api/heads", "/api/summary?now=1000", "/api/feed", "/api/delivery-cost?chainId=1"]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });
});
