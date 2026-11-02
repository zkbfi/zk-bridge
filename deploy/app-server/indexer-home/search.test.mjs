// The search, the tabs and the cross-links of the indexer's live page (index.html + zkb-search.js).
// Run: node --test deploy/app-server/indexer-home
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInContext, runInNewContext } from "node:vm";

const here = (path) => new URL(path, import.meta.url);
const html = readFileSync(here("./index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const bundle = readFileSync(here("./zkb-search.js"), "utf8");

const ID = `0x${"ab".repeat(32)}`;
const LC = `0x${"13".repeat(20)}`;
const PAIR = {
  name: "sepolia-pls943",
  sides: [
    { name: "sepolia", chainId: 11155111, contracts: { bridge: `0x${"11".repeat(20)}`, gate: `0x${"14".repeat(20)}`, lightClient: LC } },
    { name: "pulsechain-testnet", chainId: 943, contracts: { bridge: `0x${"21".repeat(20)}`, gate: `0x${"24".repeat(20)}`, lightClient: `0x${"23".repeat(20)}` } },
  ],
};

/** The page on a host, with elements that remember what the page did to them, and a fetch the test answers. */
function load(hostname = "indexer.zkb.fi", answers = {}, platform = "MacIntel") {
  const elements = {};
  const requests = [];
  const handlers = {};
  const globalHandlers = {};
  const element = (id) => (elements[id] ??= {
    id, value: "", hidden: false, innerHTML: "", textContent: "", className: "", attrs: {}, focused: false,
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
    addEventListener(type, handler) { (handlers[id] ??= {})[type] = handler; },
    focus() { this.focused = true; },
  });
  const page = {
    location: { hostname, hash: "" },
    navigator: { platform },
    history: { pushState: (_state, _title, url) => { page.location.hash = url; }, replaceState: (_state, _title, url) => { page.location.hash = url; } },
    URLSearchParams,
    setInterval: () => 0,
    setTimeout: (fn) => { page.timers.push(fn); return page.timers.length; },
    clearTimeout: () => {},
    timers: [],
    addEventListener: (type, handler) => { globalHandlers[type] = handler; },
    document: { getElementById: element },
    fetch: async (url) => {
      requests.push(url);
      const answer = answers[url] ?? Object.entries(answers).find(([key]) => url.startsWith(key))?.[1];
      if (answer === undefined) return new Promise(() => {});
      return { ok: answer.status === 200, status: answer.status, headers: { get: () => null }, json: async () => answer.body };
    },
  };
  runInNewContext(bundle, page);
  runInNewContext(script, page);
  const run = (code) => runInContext(code, page);
  const key = (event) => { let prevented = false; globalHandlers.keydown({ preventDefault: () => { prevented = true; }, ...event }); return prevented; };
  const type = (id, event) => { let prevented = false; handlers[id][event.type]({ preventDefault: () => { prevented = true; }, ...event }); return prevented; };
  const settle = async () => { for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return { page, elements, requests, handlers, run, key, type, settle };
}

const searchBody = (results, extra = {}) => ({ query: "q", candidates: [], unsupported: null, problems: [], results, ...extra });
const messageResult = { id: `message:${ID}`, kind: "message", title: "0xabababab…ababab", subtitle: "Transfer of USDC · sent · Sepolia to PulseChain testnet v4 · found by identifier", target: { type: "message", messageId: ID, direction: "first-to-second" }, links: [] };

test("the shared search bundle is the one built from the current sources", () => {
  const sources = ["../core/src/search-query.ts", "../data/src/chain-metadata.ts", "../data/src/search.ts", "indexer-search/entry.ts"];
  const hash = createHash("sha256");
  for (const source of sources) hash.update(source).update("\0").update(readFileSync(new URL(`../../../explorer/web/${source}`, import.meta.url)));
  assert.match(bundle, new RegExp(`sources sha256: ${hash.digest("hex")}`), "run: pnpm --filter @zk-bridge/web run build:indexer-search");
});

test("the page takes the shared code before its own script and keeps its look", () => {
  assert.ok(html.indexOf('<script src="zkb-search.js"></script>') > 0 && html.indexOf('<script src="zkb-search.js"></script>') < html.indexOf("<script>"));
  assert.match(html, /--accent:#eb6834/);
});

test("the overview is short and the rest sits behind tabs", () => {
  for (const heading of ["Light clients", "Bridges", "Proving"]) assert.match(html, new RegExp(`<h2>${heading}</h2>`));
  const tabs = [...html.matchAll(/<a href="#tab=(\w+)" id="tab-\w+"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["transfers", "pipeline", "timings", "lookup", "api"]);
  const before = html.slice(html.indexOf("<main"), html.indexOf('<nav class="tabs"'));
  assert.doesNotMatch(before, /Recent proof timings|Look up a transfer|Read it yourself/);
  assert.match(html, /\/api\/search\?q=/);
});

test("the hosts of the links come from the page's own host", () => {
  const { run } = load("indexer.staging.example");
  assert.deepEqual(JSON.parse(JSON.stringify(run("sitesFor(location)"))), { dapp: "https://next.staging.example", indexer: "", status: "https://status.staging.example", backend: "https://prove.staging.example", gateway: "https://gateway.staging.example" });
  const local = load("localhost").run("sitesFor(location)");
  assert.equal(local.indexer, "");
  assert.equal(local.status, "https://status.zkb.fi");
});

test("a light client, a bridge and a transfer link through the same builder as the dapp", async () => {
  const { page, run, settle } = load("indexer.zkb.fi", { "/api/pair": { status: 200, body: PAIR } });
  await run("getPair()"); await settle();
  const head = page.headRow({ chainId: 943, trackedChainId: 11155111, initialized: true, storedHeadSlot: 100, updateCount: 0, lagSeconds: 10 }, null, 1000);
  assert.match(head, /<a href="https:\/\/next\.zkb\.fi\/#\/explore\/contract\/943\/0x2323232323232323232323232323232323232323">Open in Explore<\/a>/);
  assert.doesNotMatch(head, /href="#lookup=|>Indexer</); // this page does not link to itself
  assert.match(head, /href="https:\/\/status\.zkb\.fi\/#check=lightclient-first-to-second" target="_blank" rel="noreferrer">Status<\/a>/);
  assert.match(head, /PulseChain testnet scan/);
  const message = run(`xlinks({ type: "message", messageId: "${ID}", direction: "first-to-second" })`);
  assert.match(message, new RegExp(`https://next\\.zkb\\.fi/#/message/${ID}`));
  assert.match(message, new RegExp(`https://prove\\.zkb\\.fi/progress/${ID}`));
  assert.match(message, /check=pipeline-first-to-second/);
  assert.equal(run('directionFrom(11155111)'), "first-to-second");
  assert.equal(run("directionFrom(943)"), "second-to-first");
  assert.equal(run("directionFrom(5)"), null);
  assert.match(page.headRow({ chainId: 943, trackedChainId: 11155111, initialized: false, updateCount: 0 }, null, 1000), /not started/);
});

test("a transaction hash in a row links to its Explore page", async () => {
  const { run } = load("indexer.zkb.fi");
  assert.equal(run(`tx(943, "${ID}")`), `<a class="mono" href="https://next.zkb.fi/#/explore/tx/943/${ID}">0xabababab…</a>`);
});

test("without the shared code the page still shows its data, with no links", () => {
  const elements = {};
  const page = { location: { hostname: "indexer.zkb.fi", hash: "" }, setInterval: () => 0, document: { getElementById: (id) => (elements[id] ??= { value: "" }) }, fetch: () => new Promise(() => {}) };
  runInNewContext(script, page);
  const head = page.headRow({ chainId: 943, trackedChainId: 11155111, initialized: true, storedHeadSlot: 100, updateCount: 0, lagSeconds: 10 }, null, 1000);
  assert.doesNotMatch(head, /Open in Explore/);
  assert.match(head, /chain 943 trusts chain 11155111/);
  assert.match(runInContext('tx(1, "0x1234567890abcdef")', page), /^<span class="mono">/);
});

test("anchors choose the tab and the lookup", () => {
  const { run, elements } = load("indexer.zkb.fi");
  const route = (hash) => JSON.parse(JSON.stringify(run(`routeOf(${JSON.stringify(hash)})`)));
  assert.deepEqual(route(""), { tab: "transfers", q: null });
  assert.deepEqual(route("#tab=pipeline"), { tab: "pipeline", q: null });
  assert.deepEqual(route("#tab=nonsense"), { tab: "transfers", q: null });
  assert.deepEqual(route(`#lookup=${ID}`), { tab: "lookup", q: ID });
  assert.deepEqual(route("#lookup=wrapped%20ether"), { tab: "lookup", q: "wrapped ether" });
  assert.deepEqual(route("#lookup=%E0%A4%A"), { tab: "lookup", q: "%E0%A4%A" });
  assert.deepEqual(route(`#progress=${ID}`), { tab: "lookup", q: ID });
  assert.equal(run('showTab("timings")'), "timings");
  assert.equal(elements["panel-timings"].hidden, false);
  assert.equal(elements["panel-pipeline"].hidden, true);
  assert.equal(elements["tab-timings"].className, "on");
  assert.equal(elements["tab-timings"].attrs["aria-selected"], "true");
  assert.equal(run('showTab("bogus")'), "transfers");
  assert.equal(elements["panel-transfers"].hidden, false);
});

test("an anchor to a lookup opens the tab, fills the field and shows each result with its links", async () => {
  const { page, elements, requests, run, settle } = load("indexer.zkb.fi", {
    "/api/pair": { status: 200, body: PAIR },
    [`/api/search?q=${ID}&limit=20`]: { status: 200, body: searchBody([messageResult]) },
    [`https://prove.zkb.fi/progress/${ID}`]: { status: 200, body: { stages: [{ key: "sent", status: "current" }], waitingOn: { service: "source-chain-finality", since: 1 } } },
  });
  page.location.hash = `#lookup=${ID}`;
  run("fromHash()");
  await settle();
  assert.equal(elements["panel-lookup"].hidden, false);
  assert.equal(elements["lookup-id"].value, ID);
  assert.match(elements.results.innerHTML, /<b>0xabababab…ababab<\/b><span class="sub">Transfer of USDC/);
  assert.match(elements.results.innerHTML, new RegExp(`https://next\\.zkb\\.fi/#/message/${ID}`));
  assert.ok(requests.includes(`https://prove.zkb.fi/progress/${ID}`));
  assert.match(elements.progress.innerHTML, /Waiting on <b>source chain finality<\/b>/);
});

test("a lookup that finds nothing, a name, a failing search and an empty field each say so", async () => {
  const { elements, run, settle } = load("indexer.zkb.fi", {
    "/api/pair": { status: 200, body: PAIR },
    "/api/search?q=nothing&limit=20": { status: 200, body: searchBody([], { problems: ["indexer: db down"] }) },
    "/api/search?q=vitalik.eth&limit=20": { status: 200, body: searchBody([], { unsupported: "name" }) },
    "/api/search?q=broken&limit=20": { status: 503, body: {} },
    "/api/search?q=%3Cb%3E&limit=20": { status: 200, body: searchBody([{ ...messageResult, target: { type: "slot", slot: "1" }, title: "<i>x</i>", links: [{ surface: "dapp", label: "Open", url: "u" }] }]) },
  });
  await run("runSearch('nothing')"); await settle();
  assert.match(elements.results.innerHTML, /Nothing found for nothing/);
  assert.match(elements.results.innerHTML, /indexer: db down/);
  await run("runSearch('vitalik.eth')"); await settle();
  assert.match(elements.results.innerHTML, /Names are not searched/);
  await run("runSearch('broken')"); await settle();
  assert.match(elements.results.innerHTML, /The search did not answer/);
  await run("runSearch('   ')");
  assert.match(elements.results.innerHTML, /Type something to look up/);
  await run("runSearch('<b>')"); await settle();
  assert.match(elements.results.innerHTML, /&lt;i&gt;x&lt;\/i&gt;/);
});

test("a slow search never overwrites a newer one", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const { page, elements, run, settle } = load("indexer.zkb.fi", { "/api/search?q=fast&limit=20": { status: 200, body: searchBody([]) } });
  const realFetch = page.fetch;
  page.fetch = (url) => (url.includes("q=slow") ? slow.then(() => ({ ok: true, status: 200, json: async () => searchBody([messageResult]) })) : realFetch(url));
  const first = run("runSearch('slow')");
  const second = run("runSearch('fast')");
  await second; await settle();
  release(); await first; await settle();
  assert.match(elements.results.innerHTML, /Nothing found for fast/);
});

test("the form looks the text up and writes it in the address", async () => {
  const { page, handlers, elements, settle } = load("indexer.zkb.fi", { "/api/search?q=usdc&limit=20": { status: 200, body: searchBody([]) } });
  page.document.getElementById("lookup-id").value = " usdc ";
  let prevented = false;
  handlers.lookup.submit({ preventDefault: () => { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.equal(page.location.hash, "#lookup=usdc");
  assert.match(elements.results.innerHTML, /Nothing found for usdc/);
});

// ---- The palette
const OPEN = { ctrlKey: true, key: "k" };

test("Ctrl+K, Command+K and the slash key open the palette; the slash does nothing in a field", () => {
  const { elements, key, run } = load();
  assert.equal(key({ ...OPEN }), true);
  assert.equal(elements.palette.hidden, false);
  assert.equal(elements["pal-input"].focused, true);
  run("palClose()");
  assert.equal(key({ metaKey: true, key: "K" }), true);
  assert.equal(elements.palette.hidden, false);
  run("palClose()");
  assert.equal(key({ key: "/", target: { tagName: "INPUT" } }), false);
  assert.equal(key({ key: "/", target: { tagName: "A", isContentEditable: true } }), false);
  assert.equal(key({ key: "/", ctrlKey: true }), false);
  assert.equal(key({ key: "/", altKey: true }), false);
  assert.equal(elements.palette.hidden, true);
  assert.equal(key({ key: "/", target: { tagName: "BODY" } }), true);
  assert.equal(elements.palette.hidden, false);
  assert.equal(key({ key: "/" }), true);
  assert.equal(key({ key: "x" }), false);
});

test("the open button opens it, Escape and the close button and the backdrop close it", () => {
  const { elements, handlers, key } = load();
  handlers["open-search"].click();
  assert.equal(elements.palette.hidden, false);
  key({ key: "Escape" });
  assert.equal(elements.palette.hidden, true);
  key({ key: "Escape" });
  assert.equal(elements.palette.hidden, true);
  handlers["open-search"].click();
  handlers["pal-close"].click();
  assert.equal(elements.palette.hidden, true);
  handlers["open-search"].click();
  handlers.palette.click({ target: { id: "inner" } });
  assert.equal(elements.palette.hidden, false);
  handlers.palette.click({ target: { id: "palette" } });
  assert.equal(elements.palette.hidden, true);
  handlers["open-search"].click();
  handlers.palette.click({});
  assert.equal(elements.palette.hidden, false);
});

test("the key hint reads Command K on a Mac and Ctrl K elsewhere", () => {
  assert.equal(load("indexer.zkb.fi", {}, "MacIntel").elements.hint.textContent, "⌘K");
  assert.equal(load("indexer.zkb.fi", {}, "Win32").elements.hint.textContent, "");
});

test("an empty palette lists the views; typing filters them and asks /api/search", async () => {
  const { elements, run, settle, requests, handlers, page } = load("indexer.zkb.fi", {
    "/api/pair": { status: 200, body: PAIR },
    "/api/search?q=usdc&limit=12": { status: 200, body: searchBody([{ id: "token:943:0x1", kind: "token", title: "USDC", subtitle: "Sepolia · 0x1", target: { type: "token", side: "first", chainId: 11155111, address: `0x${"31".repeat(20)}` }, links: [] }]) },
  });
  run("palOpen()");
  assert.match(elements["pal-list"].innerHTML, /Views<\/div>/);
  assert.equal([...elements["pal-list"].innerHTML.matchAll(/role="option"/g)].length, 5);
  assert.equal(elements["pal-input"].attrs["aria-activedescendant"], "pal-opt-0");
  elements["pal-input"].value = "usdc";
  handlers["pal-input"].input({ target: elements["pal-input"] });
  page.timers.shift()();
  assert.match(elements["pal-list"].innerHTML, /Searching…/);
  await settle();
  assert.ok(requests.includes("/api/search?q=usdc&limit=12"));
  assert.match(elements["pal-list"].innerHTML, /Tokens<\/div><div class="pal-row" id="pal-opt-0"[^>]*aria-selected="true"><span class="t">USDC<\/span>/);
  assert.match(elements["pal-list"].innerHTML, /Open in Explore<\/a>/);
  assert.doesNotMatch(elements["pal-list"].innerHTML, /role="presentation">Views/);
});

test("a view matches its name and its words", async () => {
  const { elements, run, settle } = load("indexer.zkb.fi", { "/api/search?q=gpu&limit=12": { status: 200, body: searchBody([]) } });
  run("palOpen()");
  await run("palSearch('gpu')"); await settle();
  assert.match(elements["pal-list"].innerHTML, />Pipeline<\/span>/);
  assert.doesNotMatch(elements["pal-list"].innerHTML, />Timings<\/span>/);
});

test("arrow keys move with wrapping, Home and End jump, Enter opens the highlighted result", async () => {
  const { elements, handlers, run, page, settle } = load("indexer.zkb.fi", {
    "/api/search?q=0xabababab&limit=12": { status: 200, body: searchBody([]) },
  });
  run("palOpen()");
  const press = (name) => handlers["pal-input"].keydown({ key: name, preventDefault: () => {} });
  const active = () => run("pal.active");
  assert.equal(active(), 0);
  press("ArrowUp"); assert.equal(active(), 4);
  press("ArrowDown"); assert.equal(active(), 0);
  press("ArrowDown"); press("ArrowDown"); assert.equal(active(), 2);
  assert.equal(elements["pal-opt-2"].attrs["aria-selected"], "true");
  assert.equal(elements["pal-opt-0"].attrs["aria-selected"], "false");
  press("End"); assert.equal(active(), 4);
  press("Home"); assert.equal(active(), 0);
  press("ArrowDown");
  press("Enter");
  assert.equal(elements.palette.hidden, true);
  assert.equal(page.location.hash, "#tab=pipeline");
  assert.equal(elements["panel-pipeline"].hidden, false);
  // Enter with nothing highlighted does nothing.
  run("palOpen()");
  run("palSet([], '')");
  press("Enter");
  assert.equal(elements.palette.hidden, false);
  assert.equal(elements["pal-input"].attrs["aria-activedescendant"], undefined);
  press("Escape");
  assert.equal(elements.palette.hidden, true);
  assert.equal(run("moveHighlight(-1, 0, 'ArrowDown')"), -1);
  assert.equal(run("moveHighlight(-1, 3, 'ArrowDown')"), 0);
  assert.equal(run("moveHighlight(0, 3, 'ArrowUp')"), 2);
});

test("Enter on a result opens it in the Look up tab, and a click on a row does the same", async () => {
  const { elements, handlers, run, page, settle } = load("indexer.zkb.fi", {
    "/api/pair": { status: 200, body: PAIR },
    [`/api/search?q=${ID}&limit=12`]: { status: 200, body: searchBody([messageResult]) },
    [`/api/search?q=${ID}&limit=20`]: { status: 200, body: searchBody([messageResult]) },
  });
  run("palOpen()");
  await run(`palSearch('${ID}')`); await settle();
  assert.match(elements["pal-list"].innerHTML, /Transfers and messages<\/div>/);
  handlers["pal-input"].keydown({ key: "Enter", preventDefault: () => {} });
  await settle();
  assert.equal(page.location.hash, `#lookup=${ID}`);
  assert.equal(elements["panel-lookup"].hidden, false);
  assert.match(elements.results.innerHTML, /Transfer of USDC/);
  run("palOpen()");
  await run(`palSearch('${ID}')`); await settle();
  const row = { dataset: { i: "0" } };
  const target = (match) => ({ target: { closest: (selector) => (selector === match ? row : null) } });
  handlers["pal-list"].mousemove(target("[data-i]"));
  handlers["pal-list"].mousemove({ target: {} });
  handlers["pal-list"].mousemove({});
  handlers["pal-list"].click({ target: { closest: (selector) => (selector === "a" ? {} : null) } });
  assert.equal(elements.palette.hidden, true);
  run("palOpen()");
  await run(`palSearch('${ID}')`); await settle();
  handlers["pal-list"].click(target("[data-i]"));
  assert.equal(elements.palette.hidden, true);
  run("palOpen()");
  handlers["pal-list"].click({ target: { closest: () => null } });
  handlers["pal-list"].click({});
  assert.equal(elements.palette.hidden, false);
});

test("the palette says when nothing matches, when a name is typed, when the search fails and when a reader failed", async () => {
  const { elements, run, settle } = load("indexer.zkb.fi", {
    "/api/search?q=zzzz&limit=12": { status: 200, body: searchBody([]) },
    "/api/search?q=vitalik.eth&limit=12": { status: 200, body: searchBody([], { unsupported: "name" }) },
    "/api/search?q=err&limit=12": { status: 502, body: {} },
    "/api/search?q=0xabcdef&limit=12": { status: 200, body: searchBody([], { problems: ["indexer: db down"] }) },
  });
  run("palOpen()");
  for (const [query, expected] of [["zzzz", /Nothing matches/], ["vitalik.eth", /Names such as ENS names are not searched/], ["err", /The indexer search did not answer/], ["0xabcdef", /indexer: db down/]]) {
    await run(`palSearch(${JSON.stringify(query)})`); await settle();
    assert.match(elements["pal-list"].innerHTML, expected, query);
  }
});

test("an older palette answer never replaces a newer one, and closing drops what is in flight", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const { page, elements, run, settle } = load("indexer.zkb.fi", { "/api/search?q=fast&limit=12": { status: 200, body: searchBody([{ ...messageResult, kind: "message" }]) } });
  const realFetch = page.fetch;
  page.fetch = (url) => (url.includes("q=slow") ? slow.then(() => ({ ok: true, status: 200, json: async () => searchBody([]) })) : realFetch(url));
  run("palOpen()");
  const first = run("palSearch('slow')");
  await run("palSearch('fast')"); await settle();
  release(); await first; await settle();
  assert.match(elements["pal-list"].innerHTML, /Transfers and messages/);
  const closing = run("palSearch('slow')");
  run("palClose()");
  release(); await closing; await settle();
  assert.doesNotMatch(elements["pal-list"].innerHTML, /Nothing matches/);
});

test("a failing search after the answer arrived is dropped when a newer one has started", async () => {
  const { page, elements, run, settle } = load("indexer.zkb.fi", { "/api/search?q=fast&limit=12": { status: 200, body: searchBody([]) } });
  const realFetch = page.fetch;
  page.fetch = (url) => (url.includes("q=bad") ? Promise.reject(new Error("offline")) : realFetch(url));
  run("palOpen()");
  const bad = run("palSearch('bad')");
  await run("palSearch('fast')");
  await bad; await settle();
  assert.match(elements["pal-list"].innerHTML, /Nothing matches/);
});

test("the API tab lists the search route first", () => {
  const api = html.slice(html.indexOf('id="panel-api"'));
  assert.ok(api.indexOf("/api/search?q=") < api.indexOf("/api/summary"));
});
