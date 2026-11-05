import { describe, expect, it } from "vitest";
import { docsRouteOf, pageIdMatchesSlug, slugOfPageId } from "../../src/docs/slug";

describe("the slug of a docs page", () => {
  it("drops the help folder, so a help page keeps the short address the dapp always had", () => {
    expect(slugOfPageId("help/fees-explained")).toBe("fees-explained");
  });

  it("keeps the whole identifier of an operator page", () => {
    expect(slugOfPageId("audit/known-issues")).toBe("audit/known-issues");
    expect(slugOfPageId("tools")).toBe("tools");
  });

  it("matches a slug to the page it names", () => {
    expect(pageIdMatchesSlug("help/safety", "safety")).toBe(true);
    expect(pageIdMatchesSlug("audit/known-issues", "audit/known-issues")).toBe(true);
    expect(pageIdMatchesSlug("help/safety", "help/safety")).toBe(false);
    expect(pageIdMatchesSlug("help/safety", "other")).toBe(false);
  });
});

describe("docsRouteOf", () => {
  it("builds the route of a page and of a heading", () => {
    expect(docsRouteOf("", "")).toEqual({ name: "docs", slug: null, heading: null });
    expect(docsRouteOf("help/safety", "")).toEqual({ name: "docs", slug: "safety", heading: null });
    expect(docsRouteOf("help/safety", "keys")).toEqual({ name: "docs", slug: "safety", heading: "keys" });
  });
});
