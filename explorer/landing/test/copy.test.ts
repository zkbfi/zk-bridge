import assert from "node:assert/strict";
import { test } from "vitest";
import { COPIED_TEXT, SELECTED_TEXT, copyValue, copyable, wireCopy } from "../src/copy.ts";
import type { CopyEnv, CopyTarget } from "../src/copy.ts";
import { renderDownloads } from "../src/downloads.ts";
import { renderLanding } from "../src/page.ts";
import { sampleManifest } from "./helpers.ts";

function fixture(overrides: Partial<CopyEnv> = {}) {
  const written: string[] = [];
  const timers: Array<() => void> = [];
  const status = { textContent: "" as string | null };
  const element: CopyTarget & { closest: (selector: string) => unknown } = {
    dataset: { copy: "abc123" },
    nextElementSibling: status,
    closest(selector: string) {
      return selector === ".copyable" ? element : null;
    },
  };
  const env: CopyEnv = {
    writeText: async (text) => void written.push(text),
    selectAndCopy: () => false,
    later: (action) => void timers.push(action),
    ...overrides,
  };
  return { written, timers, status, element, env };
}

test("clicking copies the full value and confirms in place, then clears", async () => {
  const f = fixture();
  const handlers: Record<string, (event: any) => void> = {};
  wireCopy({ addEventListener: (type, listener) => void (handlers[type] = listener) }, f.env);
  handlers.click?.({ target: f.element });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.written, ["abc123"]);
  assert.equal(f.status.textContent, COPIED_TEXT);
  f.timers[0]?.();
  assert.equal(f.status.textContent, "");
});

test("Enter and Space copy, other keys do not", async () => {
  const f = fixture();
  const handlers: Record<string, (event: any) => void> = {};
  wireCopy({ addEventListener: (type, listener) => void (handlers[type] = listener) }, f.env);
  let prevented = 0;
  for (const key of ["Enter", " ", "a", "Tab"]) handlers.keydown?.({ target: f.element, key, preventDefault: () => void prevented++ });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.written.length, 2);
  assert.equal(prevented, 2);
});

test("a click outside a copyable does nothing", async () => {
  const f = fixture();
  const handlers: Record<string, (event: any) => void> = {};
  wireCopy({ addEventListener: (type, listener) => void (handlers[type] = listener) }, f.env);
  handlers.click?.({ target: { closest: () => null } });
  handlers.click?.({ target: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.written.length, 0);
});

test("when writeText is refused, the selection fallback copies", async () => {
  const f = fixture({ writeText: async () => Promise.reject(new Error("denied")), selectAndCopy: () => true });
  assert.equal(await copyValue(f.element, f.env), true);
  assert.equal(f.status.textContent, COPIED_TEXT);
});

test("with no clipboard and a refused command, the value is left selected and the visitor is told", async () => {
  let selected = 0;
  const f = fixture({ writeText: null, selectAndCopy: () => (selected++, false) });
  assert.equal(await copyValue(f.element, f.env), false);
  assert.equal(selected, 1);
  assert.equal(f.status.textContent, SELECTED_TEXT);
});

test("the markup is a focusable button with a label, the full escaped value and a polite status", () => {
  const html = copyable('a"<b>', "Copy SHA-256");
  assert.ok(html.includes('role="button"') && html.includes('tabindex="0"'));
  assert.ok(html.includes('title="Copy SHA-256"') && html.includes('aria-label="Copy SHA-256"'));
  assert.ok(html.includes('data-copy="a&quot;&lt;b&gt;"') && html.includes(">a&quot;&lt;b&gt;</code>"));
  assert.ok(html.includes('role="status"') && html.includes('aria-live="polite"'));
});

test("every hash on the page is copyable and no separate Copy button remains", () => {
  const manifest = {
    ...sampleManifest,
    downloads: [
      { name: "terminal", platform: "linux-x64", file: "t-linux-x64", sha256: "c".repeat(64) },
      { name: "checksums", platform: "any", file: "SHA256SUMS", sha256: "e".repeat(64) },
    ],
  };
  const html = renderLanding({ kind: "verified", title: "t", manifest, gateways: ["https://{cid}.ipfs.dweb.link/"], downloadBaseUrl: "https://example.org/v1", sequenceNote: null, snapshot: null, platform: { key: "linux-x64", assumed: false } } as never);
  const dapp = sampleManifest.releases[0]!;
  const copyables = [...html.matchAll(/class="copyable"[^>]*data-copy="([^"]*)"[^>]*aria-label="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  for (const [value, label] of [[dapp.commit, "Copy commit hash"], [dapp.cid, "Copy content address"], [dapp.archiveSha256, "Copy SHA-256"], ["c".repeat(64), "Copy SHA-256"], ["e".repeat(64), "Copy SHA-256"]]) {
    assert.ok(copyables.some(([v, l]) => v === value && l === label), `${label} ${value}`);
  }
  assert.ok(!/<button[^>]*>\s*Copy\s*</.test(html) && !html.includes("dl-copy"));
  assert.ok(!/<code>[0-9a-f]{40,}<\/code>/.test(html), "no hash is left as plain text");
  assert.ok(!/SHA-256: <code>/.test(renderDownloads(manifest.downloads as never, "https://x", null)));
});
