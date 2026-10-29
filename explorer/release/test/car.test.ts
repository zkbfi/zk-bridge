import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CarReader, CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { identity } from "multiformats/hashes/identity";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";
import { ArchiveError, packDirectory, readArchive, unpackCar } from "../src/car.ts";
import { sampleSite, temporaryDirectory, writeTree } from "./helpers.ts";

async function carOf(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create(roots);
  const parts: Uint8Array[] = [];
  const collect = (async () => {
    for await (const part of out) parts.push(part);
  })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await collect;
  return new Uint8Array(Buffer.concat(parts));
}

describe("packDirectory", () => {
  it("the same directory packs to the same CID twice", async () => {
    const site = await temporaryDirectory();
    await writeTree(site, sampleSite);
    const first = await packDirectory(site);
    const second = await packDirectory(site);
    expect(first.cid).toMatch(/^bafy/);
    expect(second.cid).toBe(first.cid);
    expect(Buffer.from(second.carBytes).equals(Buffer.from(first.carBytes))).toBe(true);
  });

  it("a changed byte changes the CID", async () => {
    const site = await temporaryDirectory();
    await writeTree(site, sampleSite);
    const before = await packDirectory(site);
    await writeTree(site, { "assets/main.js": "console.log('hellp');\n" });
    const after = await packDirectory(site);
    expect(after.cid).not.toBe(before.cid);
  });

  it("splits a large file into fixed chunks and still gives one root", async () => {
    const site = await temporaryDirectory();
    await writeTree(site, { "big.bin": new Uint8Array(600_000).fill(7) });
    const packed = await packDirectory(site);
    const archive = await readArchive(packed.carBytes);
    expect(archive.root.toString()).toBe(packed.cid);
    expect(archive.blockCount).toBeGreaterThan(3);
  });

  it("refuses an empty directory", async () => {
    const site = await temporaryDirectory();
    await expect(packDirectory(site)).rejects.toThrow(ArchiveError);
  });
});

describe("unpackCar", () => {
  it("the archive unpacks to the same files", async () => {
    const site = await temporaryDirectory();
    await writeTree(site, { ...sampleSite, "empty/.keep": "" });
    const packed = await packDirectory(site);
    const out = await temporaryDirectory();
    const root = await unpackCar(packed.carBytes, out);
    expect(root).toBe(packed.cid);
    for (const [path, content] of Object.entries(sampleSite)) {
      expect(await readFile(join(out, path), "utf8")).toBe(content);
    }
    expect(await readFile(join(out, "empty/.keep"), "utf8")).toBe("");
  });
});

describe("readArchive", () => {
  it("reports a block whose bytes do not match its CID", async () => {
    const good = new TextEncoder().encode("good");
    const cid = CID.create(1, raw.code, await sha256.digest(good));
    const car = await carOf([cid], [{ cid, bytes: new TextEncoder().encode("evil") }]);
    await expect(readArchive(car)).rejects.toThrow(/does not match its content address/);
  });

  it("refuses an archive with no root or two roots", async () => {
    const bytes = new TextEncoder().encode("x");
    const cid = CID.create(1, raw.code, await sha256.digest(bytes));
    await expect(readArchive(await carOf([], [{ cid, bytes }]))).rejects.toThrow(/exactly one root/);
    await expect(readArchive(await carOf([cid, cid], [{ cid, bytes }]))).rejects.toThrow(/exactly one root/);
  });

  it("refuses a block hashed with anything but SHA-256", async () => {
    const bytes = new TextEncoder().encode("x");
    const cid = CID.create(1, raw.code, identity.digest(bytes));
    await expect(readArchive(await carOf([cid], [{ cid, bytes }]))).rejects.toThrow(/not SHA-256/);
  });

  it("refuses bytes that are not an archive", async () => {
    await expect(readArchive(new Uint8Array([1, 2, 3]))).rejects.toThrow(ArchiveError);
  });

  it("refuses an archive whose root is not a directory", async () => {
    const bytes = new TextEncoder().encode("x");
    const cid = CID.create(1, raw.code, await sha256.digest(bytes));
    const car = await carOf([cid], [{ cid, bytes }]);
    const out = await temporaryDirectory();
    await expect(unpackCar(car, out)).rejects.toThrow(/not a directory/);
    expect((await CarReader.fromBytes(car)).version).toBe(1);
  });
});
