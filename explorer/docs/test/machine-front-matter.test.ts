// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseFrontMatterBlock, readFrontMatter, splitFrontMatter, validateFrontMatter } from "../machine/front-matter";

const page = (block: string, body = "# T\n\ntext") => `---\n${block}\n---\n\n${body}`;
const valid = 'title: T\nsummary: "One line: with a colon."\naudience: [user, operator]\nchains: all\nverified_release: 0.1.0';

describe("front matter", () => {
  it("splits the block from the body, and leaves a file without one whole", () => {
    expect(splitFrontMatter(page("a: 1"))).toEqual({ raw: "a: 1", body: "# T\n\ntext" });
    expect(splitFrontMatter("# T\n\ntext")).toEqual({ raw: null, body: "# T\n\ntext" });
    expect(splitFrontMatter("---\nnever closed")).toEqual({ raw: null, body: "---\nnever closed" });
  });

  it("reads quoted text, numbers, bare words and inline lists", () => {
    expect(parseFrontMatterBlock("a: \"x: y\"\nb: 'it''s'\nc: 12\nd: word\ne: [1, 2]\nf: []\n# note\n")).toEqual({ a: "x: y", b: "it's", c: 12, d: "word", e: [1, 2], f: [] });
  });

  it("refuses nested YAML, repeated keys and lines that are not key: value", () => {
    expect(() => parseFrontMatterBlock("a:\n  - 1")).toThrow(/not supported/);
    expect(() => parseFrontMatterBlock("a: 1\na: 2")).toThrow(/twice/);
    expect(() => parseFrontMatterBlock("nonsense")).toThrow(/key: value/);
  });

  it("accepts a page and a skill", () => {
    const read = readFrontMatter(page(valid), "p.md");
    expect(read.meta).toMatchObject({ title: "T", audience: ["user", "operator"], chains: "all", kind: "page" });
    expect(read.body).toBe("# T\n\ntext");
    const skill = readFrontMatter(page(`${valid}\nkind: skill\nname: bridge-tokens\ndescription: Send tokens across the bridge.`), "s.md");
    expect(skill.meta).toMatchObject({ kind: "skill", name: "bridge-tokens" });
  });

  it("takes chain ids and a single audience word", () => {
    const result = validateFrontMatter({ title: "T", summary: "s", audience: "integrator", chains: [1, 369], verified_release: "1.2.3-rc.1" });
    expect(result).toMatchObject({ ok: true, value: { audience: ["integrator"], chains: [1, 369] } });
  });

  it.each([
    ["no block", "# T", /no front matter/],
    ["a missing title", valid.replace("title: T\n", ""), /"title" is required/],
    ["an unknown audience", valid.replace("[user, operator]", "[user, wizard]"), /"wizard"/],
    ["a bad chains value", valid.replace("chains: all", "chains: some"), /"chains"/],
    ["a bad version", valid.replace("0.1.0", "latest"), /verified_release/],
    ["an unknown key", `${valid}\nowner: me`, /unknown key "owner"/],
    ["a skill without a name", `${valid}\nkind: skill\ndescription: d`, /kebab-case/],
    ["a skill without a description", `${valid}\nkind: skill\nname: bridge-tokens`, /needs "description"/],
    ["a page with a description", `${valid}\ndescription: d`, /only for skills/],
    ["a skill with a bad name", `${valid}\nkind: skill\nname: Bridge_Tokens\ndescription: d`, /kebab-case/],
    ["a name on a page", `${valid}\nname: x`, /only for skills/],
    ["a long summary", valid.replace('"One line: with a colon."', `"${"x".repeat(300)}"`), /summary/],
  ])("refuses %s", (_label, block, message) => {
    const source = block === "# T" ? block : page(block);
    expect(() => readFrontMatter(source, "p.md")).toThrow(message);
  });
});
