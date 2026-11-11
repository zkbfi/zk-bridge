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

describe("front matter values and fields", () => {
  it("refuses a double-quoted value that is not a JSON string, and a single-quoted one that never closes", () => {
    expect(() => parseFrontMatterBlock('a: "broken')).toThrow(/double-quoted value must be a valid JSON string/);
    expect(() => parseFrontMatterBlock("a: 12 \nb: \"1\"")).not.toThrow();
    expect(() => parseFrontMatterBlock('a: "12"\nb: "x\\"')).toThrow(/line 2/);
    expect(() => parseFrontMatterBlock("a: 'open")).toThrow(/single-quoted value must end with a quote/);
    expect(() => parseFrontMatterBlock("a: '")).toThrow(/single-quoted value must end with a quote/);
  });

  it("refuses a list that does not close", () => {
    expect(() => parseFrontMatterBlock("a: [1, 2")).toThrow(/must close with \]/);
  });

  it("reads a key with no value as an empty text", () => {
    expect(parseFrontMatterBlock("a:")).toEqual({ a: "" });
  });

  it("reads a double-quoted number-looking JSON value that is not a string as an error", () => {
    expect(() => parseFrontMatterBlock("a: \"x\"\nb: \"\\u00\"")).toThrow(/line 2/);
  });

  const base = { title: "T", summary: "s", audience: ["user"], chains: "all", verified_release: "0.1.0" };
  it.each([
    ["no audience", { ...base, audience: undefined }, /"audience" is required/],
    ["an empty audience", { ...base, audience: [] }, /"audience" is required/],
    ["a repeated audience", { ...base, audience: ["user", "user"] }, /repeats a value/],
    ["an empty chain list", { ...base, chains: [] }, /"chains" is required/],
    ["a negative chain id", { ...base, chains: [-1] }, /"chains" is required/],
    ["a negative single chain", { ...base, chains: -1 }, /"chains" is required/],
    ["an unknown kind", { ...base, kind: "essay" }, /"kind" must be/],
    ["a skill with a blank description", { ...base, kind: "skill", name: "a-b", description: " " }, /needs "description"/],
  ])("validates %s", (_label, data, message) => {
    const result = validateFrontMatter(data as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.join("\n")).toMatch(message);
  });

  it("names the file when the block cannot be parsed", () => {
    expect(() => readFrontMatter(page("nonsense"), "p.md")).toThrow('p.md: front matter line 1: expected "key: value"');
  });

  it("takes a single chain id and a skill with its description", () => {
    expect(validateFrontMatter({ ...base, chains: 943 })).toMatchObject({ ok: true, value: { chains: [943] } });
    expect(validateFrontMatter({ ...base, kind: "skill", name: "a-b", description: "d" })).toMatchObject({ ok: true, value: { name: "a-b", description: "d" } });
  });
});
