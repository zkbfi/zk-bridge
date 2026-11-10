import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSize, renderDownloads } from "../src/downloads.ts";
import { renderLanding } from "../src/page.ts";
import type { LandingState, SnapshotConfig } from "../src/page.ts";
import { sampleManifest } from "./helpers.ts";

const terminals = [
  ["darwin-arm64", "a"], ["darwin-x64", "b"], ["linux-arm64", "c"], ["linux-x64", "d"], ["windows-x64", "e"],
].map(([platform, digit]) => ({ name: "zk-bridge-terminal", platform: platform!, file: `zk-bridge-terminal-${platform}`, sha256: digit!.repeat(64) }));
const base = "https://example.org/v1";

test("the menu lists every platform and never uses a select", () => {
  const html = renderDownloads(terminals, base, { key: "linux-x64", assumed: false });
  assert.ok(!/<select|<option/.test(html));
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 5);
  assert.ok(html.includes('role="menu"') && html.includes('aria-haspopup="menu"'));
  for (const label of ["macOS · Apple silicon", "macOS · Intel", "Linux · x64", "Linux · Arm64", "Windows · x64"]) assert.ok(html.includes(label), label);
});

test("the detected platform is the primary download, with its file, size and SHA-256, and the menu is closed", () => {
  const sized = terminals.map((entry) => ({ ...entry, size: 54_321_000 }));
  const html = renderDownloads(sized, base, { key: "linux-x64", assumed: false });
  assert.ok(html.includes('href="https://example.org/v1/zk-bridge-terminal-linux-x64"'));
  assert.ok(html.includes("Download for Linux · x64"));
  assert.ok(html.includes("54.3 MB"));
  assert.ok(html.includes("d".repeat(64)));
  assert.ok(html.includes('data-copy="' + "d".repeat(64) + '"'));
  assert.ok(html.includes("Compare the SHA-256"));
  assert.ok(html.includes('aria-expanded="false"') && html.includes(" hidden>"));
  assert.ok(!html.includes("e".repeat(64)), "only the chosen file's checksum is shown");
});

test("a Mac with no readable chip gets Apple silicon and the note about Intel", () => {
  const html = renderDownloads(terminals, base, { key: "darwin-arm64", assumed: true });
  assert.ok(html.includes("Download for macOS · Apple silicon"));
  assert.ok(html.includes("Apple silicon build") && html.includes("Intel"));
  const sure = renderDownloads(terminals, base, { key: "darwin-arm64", assumed: false });
  assert.ok(!sure.includes("does not say which chip"));
});

test("an unknown platform has no download button and shows the menu open", () => {
  for (const detection of [null, { key: null, assumed: false }, { key: "linux-riscv", assumed: false }]) {
    const html = renderDownloads(terminals, base, detection);
    assert.ok(!html.includes("dl-button"));
    assert.ok(html.includes('aria-expanded="true"'));
    assert.ok(!/ hidden>/.test(html));
    assert.ok(html.includes("Choose your system"));
  }
});

test("a visitor's choice wins over detection", () => {
  const html = renderDownloads(terminals, base, { key: "linux-x64", assumed: false }, { "zk-bridge-terminal": { selected: "darwin-x64", open: true } });
  assert.ok(html.includes("Download for macOS · Intel"));
  assert.ok(html.includes('aria-checked="true"'));
  assert.ok(html.includes("your device"));
});

test("a program with one build shows it without a menu; files for every system are listed with checksums", () => {
  const html = renderDownloads([...terminals.slice(0, 1), { name: "guest", platform: "any", file: "guest.elf", sha256: "f".repeat(64) }], base, null);
  assert.ok(html.includes("Download for macOS · Apple silicon"));
  assert.ok(!html.includes("dl-trigger"));
  assert.ok(html.includes("f".repeat(64)) && html.includes("guest.elf"));
});

test("sizes read plainly", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1_500), "1.5 kB");
  assert.equal(formatSize(54_321_000), "54.3 MB");
  assert.equal(formatSize(1_200_000_000), "1.2 GB");
});

const snapshot: SnapshotConfig = { light: "./snapshot-light.webp", dark: "./snapshot-dark.webp", width: 1280, height: 800 };
function verified(withSnapshot: SnapshotConfig | null): LandingState {
  return { kind: "verified", title: "T", manifest: sampleManifest, gateways: ["https://{cid}.ipfs.example/"], downloadBaseUrl: "./d", sequenceNote: null, snapshot: withSnapshot };
}

test("the snapshot shows light and dark by colour scheme and links to the app", () => {
  const html = renderLanding(verified(snapshot));
  assert.ok(html.includes('<source media="(prefers-color-scheme: dark)" srcset="./snapshot-dark.webp">'));
  assert.ok(html.includes('<img src="./snapshot-light.webp" width="1280" height="800"'));
  assert.ok(html.includes(`href="https://${sampleManifest.releases[0]!.cid}.ipfs.example/"`));
  assert.ok(html.includes("after the loader"));
});

test("without a snapshot the page has no snapshot block", () => {
  for (const state of [verified(null), { ...verified(null), snapshot: undefined } as LandingState]) {
    const html = renderLanding(state);
    assert.ok(!html.includes("<picture") && !html.includes("snapshot"));
    assert.ok(html.includes("Downloads"));
  }
});

const landing = fileURLToPath(new URL("..", import.meta.url));

async function build(snapshotDirectory: string | null): Promise<{ out: string; main: string }> {
  const out = await mkdtemp(join(tmpdir(), "landing-out-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", LANDING_OUT: out };
  if (snapshotDirectory !== null) env.LANDING_SNAPSHOT_DIR = snapshotDirectory;
  const result = spawnSync(process.execPath, [join(landing, "scripts/build.ts")], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { out, main: await readFile(join(out, "main.js"), "utf8") };
}

test("the build ships the snapshot files when present and records their size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "landing-snap-"));
  await writeFile(join(directory, "snapshot-light.webp"), "light");
  await writeFile(join(directory, "snapshot-dark.webp"), "dark");
  await writeFile(join(directory, "snapshot.json"), JSON.stringify({ width: 1280, height: 800 }));
  const { out, main } = await build(directory);
  assert.equal(await readFile(join(out, "snapshot-light.webp"), "utf8"), "light");
  assert.equal(await readFile(join(out, "snapshot-dark.webp"), "utf8"), "dark");
  assert.ok(main.includes('"snapshot":{"light":"./snapshot-light.webp"'));
  await rm(directory, { recursive: true });
  await rm(out, { recursive: true });
});

test("the build without snapshot files, or with an incomplete set, still works and ships none", async () => {
  const partial = await mkdtemp(join(tmpdir(), "landing-snap-"));
  await writeFile(join(partial, "snapshot.json"), JSON.stringify({ width: 1280, height: 800 }));
  await writeFile(join(partial, "snapshot-light.webp"), "light");
  for (const directory of [null, partial, "/nonexistent/dir"]) {
    const { out, main } = await build(directory);
    assert.ok(!main.includes("snapshot"));
    await assert.rejects(stat(join(out, "snapshot-dark.webp")));
    await rm(out, { recursive: true });
  }
  await rm(partial, { recursive: true });
});

test("the app links and the snapshot come before the docs, the terminal downloads and the signed list", () => {
  const html = renderLanding(verified(snapshot));
  const at = (marker: string): number => {
    const index = html.indexOf(marker);
    assert.ok(index >= 0, `${marker} is missing`);
    return index;
  };
  const order = [at('id="app-links"'), at('id="snapshot"'), at(`${sampleManifest.releases[0]!.cid}`), at('id="docs"'), at('id="downloads"'), at('id="verification"')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(html.indexOf("<h1>") < html.indexOf('id="app-links"'));
  assert.ok(html.includes("the contracts have no owner"));
  assert.ok(html.includes('href="./llms.txt"') && html.includes('href="./version.json.sig"'));
});

test("the build sets og:image and twitter:image from the preview image, and omits them without it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "landing-snap-"));
  await writeFile(join(directory, "snapshot-light.webp"), "light");
  await writeFile(join(directory, "snapshot-dark.webp"), "dark");
  await writeFile(join(directory, "snapshot.json"), JSON.stringify({ width: 1280, height: 800 }));
  const without = await build(directory);
  const bare = await readFile(join(without.out, "index.html"), "utf8");
  assert.ok(!bare.includes("og:image") && !bare.includes("twitter:image") && !bare.includes("{{meta}}"));
  await writeFile(join(directory, "snapshot-og.jpg"), "og");
  const withPreview = await build(directory);
  const html = await readFile(join(withPreview.out, "index.html"), "utf8");
  assert.ok(/<meta property="og:image" content="https:\/\/[^"]+\/snapshot-og\.jpg"/.test(html));
  assert.ok(/<meta name="twitter:image" content="https:\/\/[^"]+\/snapshot-og\.jpg"/.test(html));
  assert.equal(await readFile(join(withPreview.out, "snapshot-og.jpg"), "utf8"), "og");
  const none = await build(null);
  assert.ok(!(await readFile(join(none.out, "index.html"), "utf8")).includes("og:image"));
  for (const out of [without.out, withPreview.out, none.out]) await rm(out, { recursive: true });
  await rm(directory, { recursive: true });
});
