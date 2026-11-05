import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalManifestBytes, parseManifest } from "../../landing/src/manifest.ts";
import { packDirectory } from "../src/car.ts";
import { assembleRelease } from "../src/main.ts";
import { sha256Bytes } from "../src/checksums.ts";
import { signManifest } from "../src/sign.ts";
import { verifyRelease } from "../src/verify.ts";
import { sampleSite, temporaryDirectory, throwawayKey, writeTree } from "./helpers.ts";

/** Builds a complete signed release directory from the sample site. */
async function sampleRelease() {
  const release = await temporaryDirectory();
  const site = await temporaryDirectory();
  await writeTree(site, sampleSite);
  for (const name of ["dapp", "landing"]) {
    const { carBytes } = await packDirectory(site);
    await writeTree(release, { [`archives/${name}.car`]: carBytes });
  }
  await writeTree(release, { "downloads/zk-bridge-terminal-linux-x64": "program bytes" });
  const manifest = await assembleRelease({ directory: release, version: "1.0.0", commit: "abc1234", publishedAt: "2026-10-28T00:00:00Z", previous: null });
  const { privateKey, publicKey } = await throwawayKey();
  await writeFile(join(release, "version.json.sig"), await signManifest({ manifest, privateKey }));
  return { release, publicKey, manifest };
}

describe("verifyRelease", () => {
  it("accepts a complete release signed by a listed key", async () => {
    const { release, publicKey, manifest } = await sampleRelease();
    expect(manifest.releases.map((entry) => entry.name)).toEqual(["dapp", "landing"]);
    expect(manifest.downloads).toHaveLength(1);
    expect(await verifyRelease(release, [publicKey])).toEqual({ ok: true });
  });

  it("still verifies a release list signed before the docs moved into the dapp, which names a docs archive", async () => {
    const { release, manifest } = await sampleRelease();
    const site = await temporaryDirectory();
    await writeTree(site, sampleSite);
    const { carBytes, cid } = await packDirectory(site);
    await writeTree(release, { "archives/docs.car": carBytes });
    const docs = { name: "docs" as const, version: "1.0.0", commit: "abc1234", cid, archiveSha256: sha256Bytes(carBytes), publishedAt: "2026-10-28T00:00:00Z" };
    const legacy = { ...manifest, releases: [manifest.releases[0]!, docs, manifest.releases[1]!] };
    await writeFile(join(release, "version.json"), canonicalManifestBytes(legacy));
    const sums = await readFile(join(release, "SHA256SUMS"), "utf8");
    await writeFile(join(release, "SHA256SUMS"), `${sums}${docs.archiveSha256}  archives/docs.car\n`);
    const { privateKey, publicKey } = await throwawayKey();
    await writeFile(join(release, "version.json.sig"), await signManifest({ manifest: legacy, privateKey }));
    expect(parseManifest(await readFile(join(release, "version.json"), "utf8")).releases.map((entry) => entry.name)).toEqual(["dapp", "docs", "landing"]);
    expect(await verifyRelease(release, [publicKey])).toEqual({ ok: true });
  });

  it("verifyRelease reports a tampered archive and a wrong checksum", async () => {
    const { release, publicKey } = await sampleRelease();
    const archive = join(release, "archives/landing.car");
    const bytes = await readFile(archive);
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0xff;
    await writeFile(archive, bytes);
    await writeFile(join(release, "downloads/zk-bridge-terminal-linux-x64"), "other bytes");
    const result = await verifyRelease(release, [publicKey]);
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems).toContain("archives/landing.car: the SHA-256 differs from version.json");
    expect(problems.some((line) => line.startsWith("archives/landing.car: the archive is damaged"))).toBe(true);
    expect(problems).toContain("downloads/zk-bridge-terminal-linux-x64: the SHA-256 differs from version.json");
    expect(problems).toContain("SHA256SUMS: downloads/zk-bridge-terminal-linux-x64 does not match");
  });

  it("reports a signature from a key that is not listed, and no keys at all", async () => {
    const { release } = await sampleRelease();
    const stranger = await throwawayKey();
    expect(await verifyRelease(release, [stranger.publicKey])).toEqual({
      ok: false,
      problems: ["version.json.sig: the signature does not match any listed release key"],
    });
    expect(await verifyRelease(release, [])).toMatchObject({ ok: false, problems: ["no release public key was given"] });
  });

  it("reports missing files, a missing site, and a manifest not written in canonical form", async () => {
    const { release, publicKey, manifest } = await sampleRelease();
    await rm(join(release, "archives/landing.car"));
    await rm(join(release, "SHA256SUMS"));
    const noLanding = { ...manifest, releases: manifest.releases.filter((entry) => entry.name !== "dapp") };
    const { privateKey, publicKey: second } = await throwawayKey();
    const pretty = new TextEncoder().encode(JSON.stringify(noLanding, null, 2));
    await writeFile(join(release, "version.json"), pretty);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        await crypto.subtle.importKey("jwk", privateKey, { name: "Ed25519" }, false, ["sign"]),
        pretty,
      ),
    );
    await writeFile(join(release, "version.json.sig"), signature);
    const result = await verifyRelease(release, [publicKey, second]);
    expect(result).toEqual({
      ok: false,
      problems: [
        "version.json: not written in canonical form",
        "version.json: the release dapp is missing",
        "archives/landing.car: missing",
        "SHA256SUMS: missing",
      ],
    });
  });

  it("reports an archive whose root is not the CID that version.json names", async () => {
    const { release, manifest } = await sampleRelease();
    const other = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const changed = { ...manifest, releases: manifest.releases.map((entry) => (entry.name === "landing" ? { ...entry, cid: other } : entry)) };
    await writeFile(join(release, "version.json"), canonicalManifestBytes(changed));
    const { privateKey, publicKey } = await throwawayKey();
    await writeFile(join(release, "version.json.sig"), await signManifest({ manifest: changed, privateKey }));
    const docs = manifest.releases.find((entry) => entry.name === "landing")!;
    expect(await verifyRelease(release, [publicKey])).toEqual({
      ok: false,
      problems: [`archives/landing.car: the root is ${docs.cid}, version.json says ${other}`],
    });
  });

  it("reports a missing or unreadable version.json, and a missing signature", async () => {
    const empty = await temporaryDirectory();
    const { publicKey } = await throwawayKey();
    expect(await verifyRelease(empty, [publicKey])).toEqual({ ok: false, problems: ["version.json: missing", "version.json.sig: missing"] });
    await writeTree(empty, { "version.json": "{}", "version.json.sig": "x" });
    const result = await verifyRelease(empty, [publicKey]);
    expect(result).toEqual({
      ok: false,
      problems: ["version.json.sig: the signature does not match any listed release key", "version.json: the manifest schema is not supported"],
    });
  });

  it("reports a download missing from SHA256SUMS, a missing download, a bad SHA256SUMS line, and a site that fails to load", async () => {
    const { release, publicKey, manifest } = await sampleRelease();
    await writeFile(join(release, "SHA256SUMS"), "not a line\n");
    let result = await verifyRelease(release, [publicKey]);
    expect(result).toMatchObject({ ok: false, problems: ["SHA256SUMS: line 1 is not a SHA-256 and a file name"] });

    const site = await temporaryDirectory();
    await writeTree(site, { "index.html": `<script src="/main.js"></script>` });
    const { carBytes } = await packDirectory(site);
    await writeFile(join(release, "archives/dapp.car"), carBytes);
    await rm(join(release, "downloads/zk-bridge-terminal-linux-x64"));
    await assembleRelease({ directory: release, version: "1.0.0", commit: "abc1234", publishedAt: "2026-10-28T00:00:00Z", previous: manifest });
    await writeTree(release, { "downloads/zk-bridge-terminal-linux-x64": "late" });
    await writeFile(join(release, "SHA256SUMS"), "");
    const reread = parseManifest(await readFile(join(release, "version.json"), "utf8"));
    const withDownload = { ...reread, downloads: manifest.downloads };
    await writeFile(join(release, "version.json"), canonicalManifestBytes(withDownload));
    const { privateKey, publicKey: key } = await throwawayKey();
    await writeFile(join(release, "version.json.sig"), await signManifest({ manifest: withDownload, privateKey }));
    await rm(join(release, "downloads/zk-bridge-terminal-linux-x64"));
    result = await verifyRelease(release, [key]);
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems).toContain("archives/dapp.car: the site does not load under /ipfs/<cid>/: /main.js gave 404");
    expect(problems).toContain("downloads/zk-bridge-terminal-linux-x64: missing");
    expect(problems).toContain("SHA256SUMS: archives/dapp.car is not listed");
    expect(reread.sequence).toBe(2);
  });
});
