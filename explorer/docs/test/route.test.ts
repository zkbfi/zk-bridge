import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/route";

describe("parseRoute", () => {
  it("reads a page and a heading", () => {
    expect(parseRoute("#/help/safety#keys")).toEqual({ id: "help/safety", anchor: "keys" });
    expect(parseRoute("#/audit/known-issues")).toEqual({ id: "audit/known-issues", anchor: "" });
  });

  it("reads an empty or odd hash as the front page", () => {
    for (const hash of ["", "#", "#top", "/x"]) expect(parseRoute(hash)).toEqual({ id: "", anchor: "" });
  });
});
