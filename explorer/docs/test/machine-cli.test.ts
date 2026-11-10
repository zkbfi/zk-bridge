// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheckMachineDocs } from "../machine/check-cli";
import { runBuildLandingLlms } from "../machine/landing-llms-cli";
import { buildLandingLlmsTxt } from "../machine/landing-llms";
import { defaultSources, filesOfContent, readMachineContent, buildMachineFiles } from "../machine/site-files";
import { deployment, pageText, writeTree } from "./machine-tree";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const examplesFile = fileURLToPath(new URL("../machine/example-addresses.json", import.meta.url));
const cid = "bafybeiggwi27xqoo5wu4wnzepydbqr5ipgqc7mbcntmbl3ymqyqdupkohe";

const collect = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, output: { log: (line: string) => logs.push(line), error: (line: string) => errors.push(line) } };
};
const releaseOf = (manifest: unknown): string => writeTree({ "version.json": JSON.stringify(manifest) });
const siteOf = (): string => mkdtempSync(join(tmpdir(), "site-"));
/** A repository root made of one help page, so a test controls what the checks read. */
const madeRoot = (page: string): string => writeTree({ "explorer/web/docs/pages/01-a.md": page, "explorer/docs/public-pages.json": '{"operator":[]}', "deploy/deployments/demo.json": deployment() });

describe("runBuildLandingLlms", () => {
  it("writes the three files and says which release", () => {
    const { logs, errors, output } = collect();
    const release = releaseOf({ releases: [{ name: "indexer", version: "9", cid: "x" }, { name: "dapp", version: "0.1.2-next.16", cid: cid.toUpperCase() }] });
    const site = siteOf();
    expect(runBuildLandingLlms([release, "next", site], repositoryRoot, output)).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual(["build-landing-llms: wrote llms.txt, llm.txt and llms-full.txt for 0.1.2-next.16"]);
    const content = readMachineContent(defaultSources(repositoryRoot));
    const expected = buildLandingLlmsTxt(content, { channel: "next", version: "0.1.2-next.16", dappCid: cid });
    expect(readFileSync(join(site, "llms.txt"), "utf8")).toBe(expected);
    expect(readFileSync(join(site, "llm.txt"), "utf8")).toBe(expected);
    expect(readFileSync(join(site, "llms-full.txt"), "utf8").startsWith(expected)).toBe(true);
  });

  it.each([[[]], [["a", "next"]], [["a", "beta", "b"]]])("prints the usage and returns 2 for the arguments %j", (argv) => {
    const { errors, output } = collect();
    expect(runBuildLandingLlms(argv, repositoryRoot, output)).toBe(2);
    expect(errors).toEqual(["usage: build-landing-llms.ts <release-directory> <stable|next> <site-directory>"]);
  });

  it("returns 1 when version.json lists no dapp, and writes nothing", () => {
    const { errors, output } = collect();
    const site = siteOf();
    expect(runBuildLandingLlms([releaseOf({ releases: [] }), "stable", site], repositoryRoot, output)).toBe(1);
    expect(errors).toEqual(["build-landing-llms: version.json lists no dapp"]);
    expect(() => readFileSync(join(site, "llms.txt"))).toThrow();
  });

  it("returns 1 with every problem of the text, and writes nothing", () => {
    const { errors, output } = collect();
    const site = siteOf();
    const root = madeRoot(pageText("A page").replace('summary: "One line."', 'summary: "A key vk_abc inside."'));
    expect(runBuildLandingLlms([releaseOf({ releases: [{ name: "dapp", version: "1.0.0", cid }] }), "stable", site], root, output)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.split("\n").every((line) => line.startsWith("build-landing-llms: "))).toBe(true);
    expect(errors[0]).toContain("build-landing-llms: the text holds something key-shaped");
    expect(() => readFileSync(join(site, "llms.txt"))).toThrow();
  });
});

describe("runCheckMachineDocs", () => {
  it("says ok for the real repository", () => {
    const { logs, errors, output } = collect();
    expect(runCheckMachineDocs([], repositoryRoot, examplesFile, output)).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual(["check-machine-docs: ok"]);
  });

  it("checks a built dapp with --dist and says so", () => {
    const { logs, output } = collect();
    const dist = writeTree(Object.fromEntries(filesOfContent(readMachineContent(defaultSources(repositoryRoot)))));
    expect(runCheckMachineDocs(["--dist", dist], repositoryRoot, examplesFile, output)).toBe(0);
    expect(logs).toEqual(["check-machine-docs: ok (dist checked)"]);
  });

  it("returns 1 with a line per problem of a dist that differs", () => {
    const { logs, errors, output } = collect();
    const dist = writeTree({ "index.html": "x" });
    expect(runCheckMachineDocs(["--dist", dist], repositoryRoot, examplesFile, output)).toBe(1);
    expect(logs).toEqual([]);
    expect(errors[0]).toMatch(/^check-machine-docs: the build is missing /);
    expect(errors[0]?.split("\n").every((line) => line.startsWith("check-machine-docs: "))).toBe(true);
  });

  it("returns 1 when --dist has no folder", () => {
    const { errors, output } = collect();
    expect(runCheckMachineDocs(["--dist"], repositoryRoot, examplesFile, output)).toBe(1);
    expect(errors).toEqual(["check-machine-docs: --dist needs a folder"]);
  });

  it("returns 1 with the problems of the sources, and does not look at the dist then", () => {
    const { errors, output } = collect();
    const root = madeRoot(pageText().replace("Body.", "Send to 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef."));
    expect(runCheckMachineDocs(["--dist"], root, examplesFile, output)).toBe(1);
    expect(errors).toEqual(["check-machine-docs: 01-a.md:11: 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef is not in contracts.json and is not a listed example address"]);
  });
});

describe("the script entries", () => {
  const argvBefore = process.argv;
  afterEach(() => {
    process.argv = argvBefore;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("check-machine-docs.ts runs the check on the real repository from its arguments", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = ["node", "check-machine-docs.ts"];
    await import("../scripts/check-machine-docs.ts");
    expect(log).toHaveBeenCalledWith("check-machine-docs: ok");
    expect(process.exitCode).toBe(0);
  });

  it("build-landing-llms.ts writes the files and sets the exit code from its arguments", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const site = siteOf();
    writeFileSync(join(site, "keep"), "");
    process.argv = ["node", "build-landing-llms.ts", releaseOf({ releases: [{ name: "dapp", version: "1.0.0", cid }] }), "stable", site];
    await import("../scripts/build-landing-llms.ts");
    expect(log).toHaveBeenCalledWith("build-landing-llms: wrote llms.txt, llm.txt and llms-full.txt for 1.0.0");
    expect(process.exitCode).toBe(0);
    expect(readFileSync(join(site, "llms.txt"), "utf8")).toContain("https://zkb.fi/version.json");
  });

  it("build-landing-llms.ts sets exit code 2 and prints the usage without arguments", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = ["node", "build-landing-llms.ts"];
    await import("../scripts/build-landing-llms.ts");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: build-landing-llms.ts"));
    expect(process.exitCode).toBe(2);
  });
});
