import { describe, expect, it } from "vitest";
import { backendLocalCheck, backendPublicCheck, gatewayCheck, indexerReadyCheck, siteCheck, webhookCheck } from "../src/checks/services.ts";
import { fakeFetch, makeDeps } from "./support.ts";

const clock = () => ({ now: 1_800_000_000_000 });
const manifest = (sequence: number, cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi") => ({
  schema: 1,
  sequence,
  channels: { next: "0.9.0-abc" },
  releases: [{ name: "docs", cid: "docscid" }, { name: "dapp", cid }],
});

describe("indexer, webhook and public backend", () => {
  it("is ok on 200 and says what else it saw", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "http://127.0.0.1:42069/ready": { status: 200 } }, c) });
    expect(await indexerReadyCheck("http://127.0.0.1:42069").run(deps)).toEqual({ state: "ok", detail: "ready" });
  });

  it("is down on another status or no answer, degraded when slow", async () => {
    const c = clock();
    const down = makeDeps({ clock: c, fetch: fakeFetch({ "https://indexer.zkb.fi/ready": { status: 503 } }, c) });
    expect(await indexerReadyCheck("https://indexer.zkb.fi").run(down)).toEqual({ state: "down", detail: "answered 503, not ready" });
    const refused = makeDeps({ clock: c, fetch: fakeFetch({ "https://indexer.zkb.fi/ready": { throws: "connect ECONNREFUSED 1.2.3.4:443" } }, c) });
    await expect(indexerReadyCheck("https://indexer.zkb.fi").run(refused)).rejects.toThrow(/ECONNREFUSED/);
    const slow = makeDeps({ clock: c, fetch: fakeFetch({ "https://indexer.zkb.fi/ready": { status: 200, ms: 4000 } }, c) });
    expect(await indexerReadyCheck("https://indexer.zkb.fi").run(slow)).toEqual({ state: "degraded", detail: "ready, but it took 4.0 s" });
  });

  it("is degraded when the health route is slow", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://webhook.zkb.fi/health": { body: {}, ms: 5000 } }, c) });
    expect(await webhookCheck("https://webhook.zkb.fi").run(deps)).toEqual({ state: "degraded", detail: "healthy, but it took 5.0 s" });
  });

  it("checks the webhook and the public backend on /health", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://webhook.zkb.fi/health": { status: 200, body: { status: "ok" } }, "https://prove.zkb.fi/health": { status: 500 } }, c) });
    expect(await webhookCheck("https://webhook.zkb.fi").run(deps)).toEqual({ state: "ok", detail: "healthy" });
    expect(await backendPublicCheck("https://prove.zkb.fi").run(deps)).toEqual({ state: "down", detail: "answered 500 on /health" });
  });
});

describe("backend (local)", () => {
  const url = "http://127.0.0.1:8787";
  const report = (modules: Record<string, unknown>, queue = 0) => ({ status: "ok", time: 1, modules, queue: { length: queue }, lastJobs: {} });

  it("reads the module states", async () => {
    const c = clock();
    const ok = makeDeps({ clock: c, fetch: fakeFetch({ [`${url}/health`]: { body: report({ requests: { state: "running" }, archive: { state: "running" } }, 2) } }, c) });
    expect(await backendLocalCheck(url).run(ok)).toEqual({ state: "ok", detail: "2 modules running, 2 jobs queued" });
    const one = makeDeps({ clock: c, fetch: fakeFetch({ [`${url}/health`]: { body: report({ requests: { state: "running" } }, 1) } }, c) });
    expect(await backendLocalCheck(url).run(one)).toEqual({ state: "ok", detail: "1 module running, 1 job queued" });
  });

  it("names the modules that are not running", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ [`${url}/health`]: { body: report({ requests: { state: "running" }, archive: { state: "degraded", detail: "indexer unreachable" }, webhook: { state: "not built" } }) } }, c) });
    expect(await backendLocalCheck(url).run(deps)).toEqual({ state: "degraded", detail: "module archive is degraded (indexer unreachable); module webhook is not built" });
  });

  it("copes with a report that lacks the queue or holds an odd module", async () => {
    const c = clock();
    const noQueue = makeDeps({ clock: c, fetch: fakeFetch({ [`${url}/health`]: { body: { status: "ok", modules: { requests: { state: "running" } } } } }, c) });
    expect(await backendLocalCheck(url).run(noQueue)).toEqual({ state: "ok", detail: "1 module running, 0 jobs queued" });
    const odd = makeDeps({ clock: c, fetch: fakeFetch({ [`${url}/health`]: { body: { status: "ok", modules: { weird: "text" } } } }, c) });
    expect(await backendLocalCheck(url).run(odd)).toEqual({ state: "degraded", detail: "module weird is unknown" });
  });

  it("is down when the answer is not the report", async () => {
    const c = clock();
    const bad = makeDeps({ clock: c, fetch: fakeFetch({ [`${url}/health`]: { text: "<html>" } }, c) });
    expect(await backendLocalCheck(url).run(bad)).toEqual({ state: "down", detail: "answered something that is not the health report" });
    const status = makeDeps({ clock: c, fetch: fakeFetch({ [`${url}/health`]: { status: 502 } }, c) });
    expect(await backendLocalCheck(url).run(status)).toEqual({ state: "down", detail: "answered 502 on /health" });
  });
});

describe("sites", () => {
  const site = siteCheck("next", "https://next.zkb.fi");

  it("reads the page and the release sequence", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: manifest(14) }, "https://next.zkb.fi/": { status: 200 } }, c) });
    expect(await site.run(deps)).toEqual({ state: "ok", detail: "page 200, release sequence 14 (0.9.0-abc)" });
  });

  it("is down when the page does not answer 200", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: manifest(14) }, "https://next.zkb.fi/": { status: 404 } }, c) });
    expect(await site.run(deps)).toEqual({ state: "down", detail: "the page answered 404" });
  });

  it("is degraded when version.json is missing, malformed or goes back", async () => {
    const c = clock();
    const missing = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { status: 404 }, "https://next.zkb.fi/": { status: 200 } }, c) });
    expect(await site.run(missing)).toEqual({ state: "degraded", detail: "the page answers, but version.json answered 404" });
    const odd = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: { sequence: "x" } }, "https://next.zkb.fi/": { status: 200 } }, c) });
    expect(await site.run(odd)).toEqual({ state: "degraded", detail: "the page answers, but version.json has no release sequence" });
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": (_u) => ({ body: manifest(sequence) }), "https://next.zkb.fi/": { status: 200 } }, c) });
    let sequence = 14;
    await site.run(deps);
    sequence = 12;
    expect(await site.run(deps)).toEqual({ state: "degraded", detail: "release sequence went back from 14 to 12" });
  });

  it("lets a version.json request that fails outright reach the runner", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { throws: "connect ETIMEDOUT" }, "https://next.zkb.fi/": { status: 200 } }, c) });
    await expect(site.run(deps)).rejects.toThrow(/ETIMEDOUT/);
  });

  it("shows no version when the manifest names no channel", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: { sequence: 3 } }, "https://next.zkb.fi/": { status: 200 } }, c) });
    expect(await site.run(deps)).toEqual({ state: "ok", detail: "page 200, release sequence 3" });
  });
});

describe("gateway", () => {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const check = gatewayCheck("next", "https://next.zkb.fi", "https://gateway.zkb.fi");

  it("fetches the dapp of the release from the gateway", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: manifest(14, cid) }, [`https://gateway.zkb.fi/ipfs/${cid}`]: { status: 200 } }, c) });
    expect(await check.run(deps)).toEqual({ state: "ok", detail: "serves the dapp of the release (bafybeigdyrz...)" });
  });

  it("is down when the gateway does not have it", async () => {
    const c = clock();
    const deps = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: manifest(14, cid) }, [`https://gateway.zkb.fi/ipfs/${cid}`]: { status: 504 } }, c) });
    expect(await check.run(deps)).toEqual({ state: "down", detail: "the gateway answered 504 for the dapp of the release (bafybeigdyrz...)" });
  });

  it("is degraded when the gateway is slow, and lets a failed request reach the runner", async () => {
    const c = clock();
    const slow = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: manifest(14, cid) }, [`https://gateway.zkb.fi/ipfs/${cid}`]: { status: 200, ms: 9000 } }, c) });
    expect(await check.run(slow)).toEqual({ state: "degraded", detail: "serves the dapp of the release (bafybeigdyrz...), but it took 9.0 s" });
    const broken = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { throws: "connect ETIMEDOUT" } }, c) });
    await expect(check.run(broken)).rejects.toThrow(/ETIMEDOUT/);
  });

  it("says when the release cannot be read or names no dapp", async () => {
    const c = clock();
    const none = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { status: 500 } }, c) });
    expect(await check.run(none)).toEqual({ state: "degraded", detail: "cannot read the release: version.json answered 500" });
    const nodapp = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: { sequence: 1, releases: [{ name: "docs", cid: "x" }] } } }, c) });
    expect(await check.run(nodapp)).toEqual({ state: "degraded", detail: "cannot read the release: version.json lists no dapp" });
    const bad = makeDeps({ clock: c, fetch: fakeFetch({ "https://next.zkb.fi/version.json": { body: "nope" } }, c) });
    expect(await check.run(bad)).toEqual({ state: "degraded", detail: "cannot read the release: version.json lists no dapp" });
  });
});
