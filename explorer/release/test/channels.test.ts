import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest, type ReleaseManifest } from "../../landing/src/manifest.ts";
import { run, type Io } from "../src/main.ts";
import { writeManifest } from "../src/manifest-writer.ts";
import { sampleSite, streamOf, temporaryDirectory, throwawayKey, writeTree } from "./helpers.ts";

const landingRoot = fileURLToPath(new URL("../../landing/", import.meta.url));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { stdin: streamOf(), env: {}, out: (line) => out.push(line), err: (line) => err.push(line) };
  return { value, out, err };
}

async function packSite(files: Record<string, string>, archive: string): Promise<void> {
  const site = await temporaryDirectory();
  await writeTree(site, files);
  expect(await run(["pack", site, archive], io().value)).toBe(0);
}

/** A complete, signed release on the next channel, as release.sh with RELEASE_CHANNEL=next writes it. */
async function stagingRelease(): Promise<string> {
  const release = await temporaryDirectory();
  for (const name of ["dapp", "landing"]) {
    await packSite({ ...sampleSite, "assets/main.js": `console.log(${JSON.stringify(name)});\n` }, join(release, "archives", `${name}.car`));
  }
  await writeTree(release, { "downloads/zk-bridge-terminal-linux-x64": "terminal" });
  const args = ["--version", "0.1.2-next.1", "--commit", "abc1234", "--published-at", "2026-10-30T00:00:00Z", "--channel", "next"];
  expect(await run(["manifest", release, ...args], io().value)).toBe(0);
  return release;
}

describe("channels", () => {
  it("writes the channel it is given, and stable by default", () => {
    const releases = [{ name: "dapp" as const, version: "0.1.2-next.1", commit: "a", cid: "bafy", archiveSha256: "0".repeat(64), publishedAt: "t" }];
    expect(writeManifest({ previous: null, releases, downloads: [] }).channels).toEqual({ stable: "0.1.2-next.1" });
    expect(writeManifest({ previous: null, releases, downloads: [], channel: "next" }).channels).toEqual({ next: "0.1.2-next.1" });
  });

  it("the manifest command takes --channel, and refuses a channel that is not a plain name", async () => {
    const release = await stagingRelease();
    const manifest = parseManifest(await readFile(join(release, "version.json"), "utf8"));
    expect(manifest.channels).toEqual({ next: "0.1.2-next.1" });
    const refused = io();
    const args = ["--version", "1", "--commit", "a", "--published-at", "t", "--channel", "Next Channel!"];
    expect(await run(["manifest", release, ...args], refused.value)).toBe(1);
    expect(refused.err[0]).toMatch(/channel/);
  });

  it("the staging and production landing configs share no key", async () => {
    const production = JSON.parse(await readFile(join(landingRoot, "landing.config.json"), "utf8")) as { publicKeys: JsonWebKey[] };
    const staging = JSON.parse(await readFile(join(landingRoot, "landing.next.config.json"), "utf8")) as { publicKeys: JsonWebKey[]; title: string };
    const xs = (keys: JsonWebKey[]) => new Set(keys.map((key) => key.x));
    expect(production.publicKeys.length).toBeGreaterThan(0);
    expect(staging.publicKeys.length).toBeGreaterThan(0);
    for (const x of xs(staging.publicKeys)) expect(xs(production.publicKeys).has(x)).toBe(false);
    expect(staging.title).toMatch(/next/);
  });

  it("the landing build embeds only the keys of the config it is given", async () => {
    const production = JSON.parse(await readFile(join(landingRoot, "landing.config.json"), "utf8")) as { publicKeys: JsonWebKey[] };
    const staging = JSON.parse(await readFile(join(landingRoot, "landing.next.config.json"), "utf8")) as { publicKeys: JsonWebKey[] };
    const build = (config: string, out: string) =>
      spawnSync(process.execPath, ["scripts/build.ts"], { cwd: landingRoot, env: { ...process.env, LANDING_CONFIG: config, LANDING_OUT: out }, encoding: "utf8" });
    const productionOut = await temporaryDirectory();
    const stagingOut = await temporaryDirectory();
    expect(build("landing.config.json", productionOut).status).toBe(0);
    expect(build("landing.next.config.json", stagingOut).status).toBe(0);
    const productionMain = await readFile(join(productionOut, "main.js"), "utf8");
    const stagingMain = await readFile(join(stagingOut, "main.js"), "utf8");
    for (const key of staging.publicKeys) expect(productionMain).not.toContain(key.x!);
    for (const key of production.publicKeys) expect(stagingMain).not.toContain(key.x!);
    expect(productionMain).toContain(production.publicKeys[0]!.x!);
    expect(stagingMain).toContain(staging.publicKeys[0]!.x!);
  });
});

describe("promote", () => {
  async function promotedFrom(staging: string, previous?: ReleaseManifest) {
    const landing = join(await temporaryDirectory(), "landing.car");
    await packSite({ ...sampleSite, "assets/main.js": "console.log('production landing');\n" }, landing);
    const out = await temporaryDirectory();
    const args = ["promote", staging, out, "--landing", landing, "--version", "0.1.2", "--published-at", "2026-10-31T00:00:00Z"];
    if (previous !== undefined) {
      const path = join(await temporaryDirectory(), "previous.json");
      await writeFile(path, JSON.stringify(previous));
      args.push("--previous", path);
    }
    const result = io();
    const code = await run(args, result.value);
    return { code, out, result };
  }

  it("keeps the dapp content address, swaps the landing, writes the stable channel, and counts on from production", async () => {
    const staging = await stagingRelease();
    const stagingManifest = parseManifest(await readFile(join(staging, "version.json"), "utf8"));
    const previous: ReleaseManifest = { ...stagingManifest, sequence: 7, channels: { stable: "0.1.1" } };
    const { code, out } = await promotedFrom(staging, previous);
    expect(code).toBe(0);
    const promoted = parseManifest(await readFile(join(out, "version.json"), "utf8"));
    expect(promoted.channels).toEqual({ stable: "0.1.2" });
    expect(promoted.sequence).toBe(8);
    const cid = (manifest: ReleaseManifest, name: string) => manifest.releases.find((entry) => entry.name === name)!.cid;
    expect(cid(promoted, "dapp")).toBe(cid(stagingManifest, "dapp"));
    expect(promoted.releases.map((entry) => entry.name)).toEqual(["dapp", "landing"]);
    expect(cid(promoted, "landing")).not.toBe(cid(stagingManifest, "landing"));
    expect(promoted.downloads).toEqual(stagingManifest.downloads);
    expect(promoted.releases.every((entry) => entry.version === "0.1.2")).toBe(true);

    const { privateKey } = await throwawayKey();
    const signer: Io = { stdin: streamOf(JSON.stringify(privateKey)), env: {}, out: () => {}, err: () => {} };
    expect(await run(["sign", out], signer)).toBe(0);
    expect(await run(["verify", out, "--public-keys", join(out, "public-keys.json")], io().value)).toBe(0);
  });

  it("refuses when the dapp archive differs from what the staging manifest names", async () => {
    const staging = await stagingRelease();
    await packSite({ ...sampleSite, "assets/main.js": "console.log('swapped');\n" }, join(staging, "archives", "dapp.car"));
    const { code, out, result } = await promotedFrom(staging);
    expect(code).toBe(1);
    expect(result.err.join("\n")).toMatch(/dapp/);
    const written = spawnSync("ls", [out], { encoding: "utf8" }).stdout.trim();
    expect(written).toBe("");
  });

  it("writes into a directory that does not exist yet", async () => {
    const staging = await stagingRelease();
    const landing = join(await temporaryDirectory(), "landing.car");
    await packSite({ ...sampleSite, "assets/main.js": "console.log('production landing');\n" }, landing);
    const out = join(await temporaryDirectory(), "not-yet");
    const args = ["promote", staging, out, "--landing", landing, "--version", "0.1.2", "--published-at", "2026-10-31T00:00:00Z"];
    expect(await run(args, io().value)).toBe(0);
    expect(parseManifest(await readFile(join(out, "version.json"), "utf8")).channels).toEqual({ stable: "0.1.2" });
  });

  it("refuses an output directory that is not empty, a staging release without a dapp, and a changed download", async () => {
    const landing = join(await temporaryDirectory(), "landing.car");
    await packSite(sampleSite, landing);
    const promote = async (staging: string, out: string) => {
      const result = io();
      const code = await run(["promote", staging, out, "--landing", landing, "--version", "0.1.2", "--published-at", "t"], result.value);
      return { code, err: result.err.join("\n") };
    };
    const busy = await temporaryDirectory();
    await writeTree(busy, { "old.txt": "x" });
    expect(await promote(await stagingRelease(), busy)).toEqual({ code: 1, err: `${busy} is not empty: a promotion starts from an empty directory` });

    const noDapp = await stagingRelease();
    const manifest = parseManifest(await readFile(join(noDapp, "version.json"), "utf8"));
    await writeFile(join(noDapp, "version.json"), JSON.stringify({ ...manifest, releases: manifest.releases.filter((entry) => entry.name !== "dapp") }));
    expect(await promote(noDapp, await temporaryDirectory())).toEqual({ code: 1, err: "the staging release has no dapp" });

    const changed = await stagingRelease();
    await writeTree(changed, { "downloads/zk-bridge-terminal-linux-x64": "another terminal" });
    expect(await promote(changed, await temporaryDirectory())).toEqual({ code: 1, err: "zk-bridge-terminal-linux-x64: the download differs from the staging manifest" });
  });

  it("promotes a staging release without downloads, and the promoted release appends to the stable release log", async () => {
    const staging = await stagingRelease();
    const manifest = parseManifest(await readFile(join(staging, "version.json"), "utf8"));
    await writeFile(join(staging, "version.json"), JSON.stringify({ ...manifest, downloads: [] }));
    const { code, out } = await promotedFrom(staging);
    expect(code).toBe(0);
    expect(spawnSync("ls", [out], { encoding: "utf8" }).stdout).not.toContain("downloads");
    const logged = io();
    expect(await run(["log", out], logged.value)).toBe(0);
    const log = JSON.parse(await readFile(join(out, "releases-log.json"), "utf8")) as { channel: string; entries: { name: string; channel: string }[] };
    expect(log.channel).toBe("stable");
    expect(log.entries.map((entry) => [entry.channel, entry.name])).toEqual([["stable", "dapp"], ["stable", "landing"]]);
  });

  it("refuses a staging release that is not on the next channel", async () => {
    const staging = await stagingRelease();
    const manifest = parseManifest(await readFile(join(staging, "version.json"), "utf8"));
    await writeFile(join(staging, "version.json"), JSON.stringify({ ...manifest, channels: { stable: "0.1.2-next.1" } }));
    const { code, result } = await promotedFrom(staging);
    expect(code).toBe(1);
    expect(result.err.join("\n")).toMatch(/next channel/);
  });
});
