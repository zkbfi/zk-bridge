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

test("a light client with only the head of its deployment shows that head and no updates", () => {
  const html = headRow({ ...base, initialized: true, storedHeadSlot: 11_463_040, storedHeadSource: "deployment", updateCount: 0, initializedAtSlot: 11_463_040, lagSeconds: 177_696 }, null, now);
  assert.match(html, /PulseChain testnet v4 trusts Sepolia from slot 11,463,040 \(set at deployment\)/);
  assert.match(html, /no updates since/);
  assert.match(html, /<span class="ok">no update since deployment<\/span>/);
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
  assert.match(html, /slot 11,470,000 · 2 updates · started at slot 11,463,040 · last update 10 min ago \(tx <a class="mono" href="[^"]+">0xabab…<\/a>\)/);
  assert.match(html, /<span class="ok">last update 10 min ago<\/span>/);
  assert.doesNotMatch(html, /behind/);
});

test("an unknown lag reads as unknown, not as zero", () => {
  const html = headRow({ ...base, initialized: true, storedHeadSlot: 11_463_040, storedHeadSource: "update", storedHeadExecutionBlock: 1, updateCount: 1, initializedAtSlot: 11_463_040, lagSeconds: null }, null, now);
  assert.match(html, /<span class="warn">lag unknown<\/span>/);
});

const updated = { ...base, initialized: true, storedHeadSlot: 11_470_000, storedHeadExecutionBlock: 9_000_000, updateCount: 2, initializedAtSlot: 11_463_040, lagSeconds: 28_800 };
const last = { timestamp: now - 28_800, transactionHash: "0x" + "29".repeat(32) };

test("when nothing waits, an old update is not an outage: it is not orange", () => {
  const html = headRow(updated, last, now, 0);
  assert.match(html, /<span class="ok">nothing waiting · last update 8 h ago<\/span>/);
  assert.doesNotMatch(html, /warn/);
});

test("transfers that wait for an update are counted, in orange", () => {
  assert.match(headRow(updated, last, now, 3), /<span class="warn">3 transfers waiting for an update<\/span>/);
  assert.match(headRow(updated, last, now, 1), /<span class="warn">1 transfer waiting for an update<\/span>/);
});

test("when the proving service is unreachable, the row says when the last update was and claims nothing about waiting", () => {
  const html = headRow(updated, last, now, null);
  assert.match(html, /<span class="ok">last update 8 h ago<\/span>/);
  assert.doesNotMatch(html, /waiting|warn/);
});

const NOWMS = 1_793_500_000_000;
function loaded(answers) {
  const elements = {};
  const p = { location: { hostname: "indexer.zkb.fi", hash: "" }, setInterval: () => 0, document: { getElementById: (id) => (elements[id] ??= { value: "" }) },
    fetch: async (url) => { const a = answers[url]; if (a === undefined) throw new Error("down"); return { ok: a.status === 200, status: a.status, json: async () => a.body }; } };
  runInNewContext(bundle, p); runInNewContext(script, p);
  return { p, elements };
}
const PAIR = { sides: [{ name: "sepolia", chainId: 11155111, contracts: {} }, { name: "pulsechain-testnet", chainId: 943, contracts: {} }] };
const SUMMARY = (gates) => ({ now, heads: [{ ...updated, chainId: 943 }], lastHeadUpdates: [{ chainId: 943, update: last }], gates, inFlight: { total: 0, byStatus: {} } });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

test("the light client row reads the batch of its own direction on the prove host", async () => {
  const pipeline = (count) => ({ status: 200, body: { direction: "first-to-second", now: NOWMS, batch: count === null ? null : { count }, job: null, latestJob: null, latestProof: null, head: null, decision: null } });
  for (const [answer, expected] of [[pipeline(2), /<span class="warn">2 transfers waiting for an update<\/span>/], [pipeline(null), /nothing waiting · last update 8 h ago/], [undefined, /<span class="ok">last update 8 h ago<\/span>/]]) {
    const { p, elements } = loaded({ "/api/pair": { status: 200, body: PAIR }, "/api/summary": { status: 200, body: SUMMARY([]) }, "/api/feed": { status: 200, body: { items: [] } },
      ...(answer ? { "https://prove.zkb.fi/directions/first-to-second/pipeline": answer } : {}) });
    await settle();
    assert.match(elements.heads.innerHTML, expected);
  }
});

test("the light client row has no link to the indexer itself, and keeps Open in Explore", async () => {
  const { elements } = loaded({ "/api/pair": { status: 200, body: { sides: [{ name: "sepolia", chainId: 11155111, contracts: {} }, { name: "pulsechain-testnet", chainId: 943, contracts: { lightClient: "0x" + "23".repeat(20) } }] } },
    "/api/summary": { status: 200, body: SUMMARY([]) }, "/api/feed": { status: 200, body: { items: [] } } });
  await settle();
  assert.match(elements.heads.innerHTML, /Open in Explore/);
  assert.doesNotMatch(elements.heads.innerHTML, />Indexer</);
});

test("the bridge lines say what the fork check does", () => {
  const g = (o) => page.gateText({ chainId: 943, enforcing: true, confirmations: 3, lastConfirmedTimestamp: now - 14_400, ...o }, now);
  assert.equal(g({}), "fork check on · confirmed 3 times, last 4 h ago");
  assert.equal(g({ confirmations: 1 }), "fork check on · confirmed once, last 4 h ago");
  assert.equal(g({ confirmations: 0, lastConfirmedTimestamp: null }), "fork check on · not confirmed yet");
  assert.equal(g({ enforcing: false, confirmations: 0, lastConfirmedTimestamp: null }), "fork check in detection mode: deposits pass until this chain gains beacon roots or a newer opcode, then the check turns on for good");
});

test("closed deposits give their reason", async () => {
  const gate = (open) => ({ chainId: 943, enforcing: true, confirmations: 0, lastConfirmedTimestamp: null, depositsOpen: open });
  const { elements } = loaded({ "/api/pair": { status: 200, body: PAIR }, "/api/summary": { status: 200, body: SUMMARY([gate(false), { ...gate(true), chainId: 11155111 }]) }, "/api/feed": { status: 200, body: { items: [] } } });
  await settle();
  assert.match(elements.gates.innerHTML, /<span class="warn">deposits closed: waiting for the opening proof<\/span>/);
  assert.match(elements.gates.innerHTML, /<span class="ok">deposits open<\/span>/);
});
