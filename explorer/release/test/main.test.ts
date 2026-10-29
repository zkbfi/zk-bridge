import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../landing/src/manifest.ts";
import { run, type Io } from "../src/main.ts";
import { sampleSite, streamOf, temporaryDirectory, throwawayKey, writeTree } from "./helpers.ts";

function io(stdin: AsyncIterable<Uint8Array> = streamOf(), env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { stdin, env, out: (line) => out.push(line), err: (line) => err.push(line) };
  return { value, out, err };
}

async function packedRelease(withDownload = true): Promise<string> {
  const site = await temporaryDirectory();
  const release = await temporaryDirectory();
  await writeTree(site, sampleSite);
  for (const name of ["dapp", "docs", "landing"]) {
    const result = io();
    expect(await run(["pack", site, join(release, "archives", `${name}.car`)], result.value)).toBe(0);
    expect(result.out[0]).toMatch(/^bafy/);
  }
  if (withDownload) await writeTree(release, { "downloads/light-client.elf": "elf" });
  return release;
}

const manifestArguments = ["--version", "1.0.0", "--commit", "abc1234", "--published-at", "2026-10-28T00:00:00Z"];

describe("run", () => {
  it("packs, writes, signs and verifies a release", async () => {
    const release = await packedRelease();
    const written = io();
    expect(await run(["manifest", release, ...manifestArguments], written.value)).toBe(0);
    expect(written.out).toEqual(["version.json: sequence 1, 3 sites, 1 downloads"]);

    const { privateKey } = await throwawayKey();
    const signed = io(streamOf(JSON.stringify(privateKey)));
    expect(await run(["sign", release], signed.value)).toBe(0);
    const publicKeys = JSON.parse(await readFile(join(release, "public-keys.json"), "utf8")) as JsonWebKey[];
    expect(publicKeys).toHaveLength(1);
    expect(publicKeys[0]).not.toHaveProperty("d");

    const verified = io();
    expect(await run(["verify", release, "--public-keys", join(release, "public-keys.json")], verified.value)).toBe(0);
    expect(verified.out).toEqual(["release verified"]);

    const landingConfig = join(await temporaryDirectory(), "landing.config.json");
    await writeFile(landingConfig, JSON.stringify({ title: "x", publicKeys }));
    expect(await run(["verify", release, "--public-keys", landingConfig], io().value)).toBe(0);

    const next = io();
    const previous = join(await temporaryDirectory(), "previous.json");
    await writeFile(previous, await readFile(join(release, "version.json")));
    expect(await run(["manifest", release, ...manifestArguments, "--previous", previous], next.value)).toBe(0);
    expect(parseManifest(await readFile(join(release, "version.json"), "utf8")).sequence).toBe(2);

    const unpacked = await temporaryDirectory();
    const unpack = io();
    expect(await run(["unpack", join(release, "archives/landing.car"), unpacked], unpack.value)).toBe(0);
    expect(await readFile(join(unpacked, "index.html"), "utf8")).toBe(sampleSite["index.html"]);
  });

  it("sign refuses when no key arrives on standard input, and writes nothing", async () => {
    const release = await packedRelease(false);
    expect(await run(["manifest", release, ...manifestArguments], io().value)).toBe(0);
    const before = (await readdir(release)).sort();
    const refused = io(streamOf());
    expect(await run(["sign", release], refused.value)).toBe(1);
    expect(refused.err).toEqual(["no signing key arrived on standard input"]);
    expect((await readdir(release)).sort()).toEqual(before);
    expect(before).not.toContain("version.json.sig");
    expect(parseManifest(await readFile(join(release, "version.json"), "utf8")).downloads).toEqual([]);
  });

  it("prints every problem and exits 1 when the release does not verify", async () => {
    const release = await packedRelease();
    expect(await run(["manifest", release, ...manifestArguments], io().value)).toBe(0);
    const keys = join(release, "keys.json");
    await writeFile(keys, "[]");
    const failed = io();
    expect(await run(["verify", release, "--public-keys", keys], failed.value)).toBe(1);
    expect(failed.err).toEqual(["no release public key was given", "version.json.sig: missing", "release NOT verified"]);
    await writeFile(keys, "{}");
    const shapeless = io();
    expect(await run(["verify", release, "--public-keys", keys], shapeless.value)).toBe(1);
    expect(shapeless.err).toEqual([`${keys} holds neither a list of keys nor a publicKeys field`]);
  });

  it("refuses a release without all three sites", async () => {
    const release = await temporaryDirectory();
    const failed = io();
    expect(await run(["manifest", release, ...manifestArguments], failed.value)).toBe(1);
    expect(failed.err[0]).toMatch(/^archives\/dapp\.car is missing/);
  });

  it("pins every archive through the chosen adapter and stops when no adapter is chosen", async () => {
    const release = await packedRelease();
    const none = io();
    expect(await run(["pin", release, "--prefix", "1.0.0"], none.value)).toBe(1);
    expect(none.err).toEqual(["no pinning account is configured (set RELEASE_PIN_PROVIDER)"]);

    const keys: string[] = [];
    const server = createServer((request, response) => {
      keys.push(request.url!);
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "x-amz-meta-cid": "bafkreiwrong" });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const env = {
        RELEASE_PIN_PROVIDER: "filebase",
        FILEBASE_ACCESS_KEY: "a",
        FILEBASE_SECRET_KEY: "b",
        FILEBASE_BUCKET: "c",
        FILEBASE_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      };
      const failed = io(streamOf(), env);
      expect(await run(["pin", release, "--prefix", "1.0.0"], failed.value)).toBe(1);
      expect(failed.err[0]).toMatch(/^Filebase reports bafkreiwrong for 1\.0\.0\/dapp\.car, but the archive is bafy/);
      expect(keys).toEqual(["/c/1.0.0/dapp.car"]);
    } finally {
      server.close();
    }
  });

  it("pins and prints each CID when Filebase agrees", async () => {
    const release = await packedRelease();
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        // The fake reports the CID that the archive name stands for, read from the archive the test packed.
        response.writeHead(200, { "x-amz-meta-cid": expected });
        response.end();
      });
    });
    const unpacked = io();
    await run(["unpack", join(release, "archives/dapp.car"), await temporaryDirectory()], unpacked.value);
    const expected = unpacked.out[0]!;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const env = {
        RELEASE_PIN_PROVIDER: "filebase",
        FILEBASE_ACCESS_KEY: "a",
        FILEBASE_SECRET_KEY: "b",
        FILEBASE_BUCKET: "c",
        FILEBASE_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      };
      const pinned = io(streamOf(), env);
      expect(await run(["pin", release], pinned.value)).toBe(0);
      expect(pinned.out).toEqual([`pinned dapp.car ${expected}`, `pinned docs.car ${expected}`, `pinned landing.car ${expected}`]);
    } finally {
      server.close();
    }
  });

  it("prints usage for an unknown command or missing arguments", async () => {
    for (const argv of [[], ["nope"], ["pack", "x"], ["manifest", "x"], ["sign"], ["verify"], ["verify", "x"],["unpack", "x"], ["pin"], ["manifest", "x", "--version"]]) {
      const result = io();
      expect(await run(argv, result.value)).toBe(2);
      expect(result.err[0]).toMatch(/^usage:/);
    }
  });
});
