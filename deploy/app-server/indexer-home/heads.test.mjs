// The light client lines of the indexer's live page (index.html). Run: node --test deploy/app-server/indexer-home
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// The shared search code (zkb-search.js) runs first, as the browser loads it before the page script.
const bundle = readFileSync(new URL("./zkb-search.js", import.meta.url), "utf8");
const page = { fetch: () => new Promise(() => {}), setInterval: () => 0, document: { getElementById: () => ({}) } };
runInNewContext(bundle, page);
runInNewContext(script, page);
const { headRow } = page;

const now = 1_793_467_831;
const base = { chainId: 943, trackedChainId: 11155111, finalizedSlot: 11_477_760, trackedChainTipTimestamp: now };

test("a light client with only the head of its deployment shows that head, no updates, and the lag in orange", () => {
  const html = headRow({ ...base, initialized: true, storedHeadSlot: 11_463_040, storedHeadSource: "deployment", updateCount: 0, initializedAtSlot: 11_463_040, lagSeconds: 177_696 }, null, now);
  assert.match(html, /PulseChain testnet v4 trusts Sepolia from slot 11,463,040 \(set at deployment\)/);
  assert.match(html, /no updates since/);
  assert.match(html, /<span class="warn">2 days behind<\/span>/);
  assert.doesNotMatch(html, /not started/);
});

test("a light client with no head at all is not started", () => {
  const html = headRow({ ...base, initialized: false, storedHeadSlot: null, storedHeadSource: null, updateCount: 0, lagSeconds: null }, null, now);
  assert.match(html, /does not trust Sepolia yet/);
  assert.match(html, /not started/);
});

test("an answer from an older indexer, with no initialized field and no updates, is not started", () => {
  const html = headRow({ ...base, storedHeadSlot: null, updateCount: 0, lagSeconds: null }, null, now);
  assert.match(html, /not started/);
});

test("an updated light client shows the execution block, the update count and the slot it started from", () => {
  const html = headRow(
    { ...base, initialized: true, storedHeadSlot: 11_470_000, storedHeadSource: "update", storedHeadExecutionBlock: 9_000_000, updateCount: 2, initializedAtSlot: 11_463_040, lagSeconds: 600 },
    { timestamp: now - 600, transactionHash: "0x" + "ab".repeat(32) },
    now,
  );
  assert.match(html, /trusts Sepolia up to block 9,000,000/);
  assert.match(html, /slot 11,470,000 · 2 updates · started at slot 11,463,040/);
  assert.match(html, /<span class="ok">10 min behind<\/span>/);
});

test("an unknown lag reads as unknown, not as zero", () => {
  const html = headRow({ ...base, initialized: true, storedHeadSlot: 11_463_040, storedHeadSource: "deployment", updateCount: 0, initializedAtSlot: 11_463_040, lagSeconds: null }, null, now);
  assert.match(html, /<span class="warn">lag unknown<\/span>/);
});
