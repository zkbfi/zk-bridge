// The proving pipeline, the timings and the transfer lookup of the indexer's live page (index.html).
// Run: node --test deploy/app-server/indexer-home
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/** The page on a host, with elements by id and a fetch the test answers. */
function load(hostname, answers = {}) {
  const elements = {};
  const requests = [];
  const page = {
    location: { hostname, hash: "" },
    URLSearchParams,
    setInterval: () => 0,
    document: { getElementById: (id) => (elements[id] ??= { value: "" }) },
    fetch: async (url) => {
      requests.push(url);
      const answer = answers[url];
      if (answer === undefined) return new Promise(() => {});
      return { ok: answer.status === 200, status: answer.status, headers: { get: (name) => (answer.headers || {})[name] ?? null }, json: async () => answer.body };
    },
  };
  runInNewContext(script, page);
  return { page, elements, requests };
}

const NOW = 1_793_500_000_000;
const ID = `0x${"ab".repeat(32)}`;

test("the prove host follows the indexer host; any other host has none", () => {
  const { page } = load("indexer.zkb.fi");
  assert.equal(page.proveBase({ hostname: "indexer.zkb.fi" }), "https://prove.zkb.fi");
  assert.equal(page.proveBase({ hostname: "indexer.staging.example" }), "https://prove.staging.example");
  assert.equal(page.proveBase({ hostname: "localhost" }), null);
  assert.equal(page.proveBase(null), null);
});

test("a page without a prove host says so and asks nothing", async () => {
  const { elements, requests } = load("localhost");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.pipeline.innerHTML, /The proving service of this host is not known/);
  assert.ok(requests.every((url) => !url.includes("prove.")));
});

test("a direction with a batch that waits, a job on the GPU and a proof on the board", () => {
  const { page } = load("localhost");
  const out = page.pipelineRows({
    now: NOW,
    batch: { count: 3, oldestFinalAt: NOW - 600_000, trigger: "max-wait", eta: NOW + 3_000_000, fallbackAt: NOW + 3_000_000, feesUsd: "0.010000", costUsd: "0.085000", detail: "x" },
    job: { jobId: "12345678-aaaa", status: "proving", step: "gpu-proving", startedAt: NOW - 40_000, elapsedMs: 40_000, eta: NOW + 60_000, detail: "a warm-up made a worker ready before the job" },
    latestJob: null,
    latestProof: { startSlot: 100, newSlot: 1_200, where: "board", since: NOW - 120_000 },
    head: { slot: 100, finalizedSlot: 1_300, lastUpdateAt: null, lagSeconds: null },
    decision: null,
  }, "Sepolia → PulseChain testnet v4");
  assert.match(out, /<h3>Sepolia → PulseChain testnet v4<\/h3>.*Batch: 3 transfers wait for a proof/);
  assert.match(out, /the proof starts at the batch's set time · oldest final 10 min ago · fees \$0\.010000 against \$0\.085000/);
  assert.match(out, /<span class="warn">in 50 min<\/span>/);
  assert.match(out, /Proving: GPU proving/);
  assert.match(out, /job 12345678 · proving for 40 s · expected done in 60 s · a warm-up made a worker ready before the job/);
  assert.match(out, /Latest proof: slot 100 → 1,200/);
  assert.match(out, /on the message board, not on chain yet · since 2 min ago · light client at slot 100/);
});

test("an idle direction shows the last decision and the last job; nothing held shows none", () => {
  const { page } = load("localhost");
  const out = page.pipelineRows({
    now: NOW,
    batch: null,
    job: null,
    latestJob: { jobId: "j", status: "failed", createdAt: NOW - 90_000, updatedAt: NOW - 60_000, startSlot: null, newSlot: null, error: "the prover ran longer than its limit" },
    latestProof: null,
    head: null,
    decision: { at: NOW - 30_000, finalizedSlot: 1, due: false, why: "nothing-due", detail: "the head is <fresh>" },
  }, "A → B");
  assert.match(out, /<h3>A → B<\/h3>.*Batch: none waits/);
  assert.match(out, /last decision 30 s ago: the head is &lt;fresh&gt;/);
  assert.match(out, /last job failed 60 s ago · the prover ran longer than its limit/);
  assert.match(out, /Latest proof: none held/);
  const fresh = page.pipelineRows({ now: NOW, batch: null, job: null, latestJob: null, latestProof: { startSlot: 1, newSlot: 2, where: "applied", since: NOW }, head: null, decision: null }, "A → B");
  assert.match(fresh, /the watcher has decided nothing since the backend started/);
  assert.match(fresh, /no job yet/);
  assert.match(fresh, /<span class="ok">applied<\/span>/);
});

const stat = (medianMs, p90Ms, count) => ({ medianMs, p90Ms, count });

test("the timings table states median, p90 and count per step, then the newest proofs", () => {
  const { page } = load("localhost");
  const empty = stat(null, null, 0);
  const steps = { workerWait: stat(61_000, 95_000, 4), remote: empty, workerQueue: empty, workerProve: stat(33_400, 35_000, 4), total: stat(100_000, 130_000, 4), webhookToBoard: empty, boardPost: stat(7_900, 9_000, 4), proofToOnChain: stat(45_000, 80_000, 3), coveredToDelivered: empty, sentToDelivered: stat(1_500_000, 2_400_000, 9) };
  const out = page.timingsTable({
    window: "24h", to: NOW, indexer: "ok", steps,
    recent: [
      { provedAt: NOW - 300_000, newSlot: 1_200, coldWorker: true, waitWorkerMs: 61_000, workerProveMs: 33_400, totalMs: 100_000, grindMs: 850, onChainAt: NOW - 200_000, boardPostedAt: NOW - 260_000, workerGpu: "NVIDIA GeForce RTX 4090", endpoint: "serverless" },
      { provedAt: null, newSlot: null, coldWorker: false, waitWorkerMs: 0, workerProveMs: null, totalMs: null, grindMs: null, onChainAt: null, boardPostedAt: null, workerGpu: null, endpoint: "dedicated" },
      { provedAt: NOW, newSlot: 5, coldWorker: null, waitWorkerMs: null, workerProveMs: null, totalMs: null, grindMs: null, onChainAt: null, boardPostedAt: null, workerGpu: null, endpoint: null },
    ],
  });
  assert.match(out, /<tr><td>Wait for a GPU worker<\/td><td>61 s<\/td><td>95 s<\/td><td>4<\/td><\/tr>/);
  assert.match(out, /<tr><td>Proof on the GPU<\/td><td>33 s<\/td><td>35 s<\/td><td>4<\/td><\/tr>/);
  assert.match(out, /<tr><td>Message board proof of work<\/td><td>7\.9 s<\/td><td>9\.0 s<\/td><td>4<\/td><\/tr>/);
  assert.match(out, /<tr><td>Sent → delivered<\/td><td>25 min<\/td><td>40 min<\/td><td>9<\/td><\/tr>/);
  assert.match(out, /<tr><td>Whole prover run<\/td><td>100 s<\/td><td>2 min 10 s<\/td><td>4<\/td><\/tr>/);
  assert.match(out, /<tr><td>Remote request<\/td><td>—<\/td><td>—<\/td><td>0<\/td><\/tr>/);
  assert.match(out, /Step \(last 24h\)/);
  assert.match(out, /5 min ago<span class="sub">to slot 1,200<\/span><\/td><td>cold, 61 s<\/td><td>33 s<\/td><td>100 s<\/td><td>850 ms<\/td><td>60 s<\/td><td>NVIDIA GeForce RTX 4090<\/td>/);
  assert.match(out, /<td>—<\/td><td>warm<\/td>.*<td>dedicated<\/td>/);
  assert.doesNotMatch(out, /did not answer/);
});

test("without proofs or the indexer, the table says so", () => {
  const { page } = load("localhost");
  const out = page.timingsTable({ window: "7d", to: NOW, indexer: "unavailable", steps: {}, recent: [] });
  assert.match(out, /The indexer did not answer the proving service, so the on-chain and delivery steps are empty\./);
  assert.match(out, /No proof was made in the last 7d\./);
});

test("a transfer's timeline marks the stages done, the current one and what it waits on", () => {
  const { page } = load("localhost");
  const out = page.progressView({
    messageId: ID, direction: "first-to-second", status: "covered", slot: 10, proof: { startSlot: 1, newSlot: 20, where: "stored" },
    stages: [
      { key: "sent", status: "done", at: NOW - 1_800_000 },
      { key: "final", status: "done", at: NOW - 900_000, detail: "slot 10" },
      { key: "batched", status: "done", at: NOW - 100_000 },
      { key: "proving", status: "done", at: NOW - 20_000 },
      { key: "proof-ready", status: "current" },
      { key: "update-posted", status: "pending", detail: "the light client head is at slot 1" },
      { key: "delivered", status: "pending" },
    ],
    waitingOn: { service: "board-post", since: NOW - 20_000, eta: NOW + 10_000, detail: "the backend has the proof" },
  }, NOW);
  assert.match(out, /<div class="waiting">Waiting on <b>message board post<\/b> since 20 s ago · expected in 10 s<span class="sub">The proof is made and is being posted to the message board\.<\/span><\/div>/);
  const batch = page.progressView({ stages: [], waitingOn: { service: "batch-max-wait", since: NOW, detail: "2 messages wait" } }, NOW);
  assert.match(batch, /<span class="sub">The proof starts at the batch&#39;s set time, whatever the fees\.<\/span><span class="sub">2 messages wait<\/span>/);
  assert.match(out, /<li class="done">Sent on the source chain<span class="sub">30 min ago<\/span><\/li>/);
  assert.match(out, /<li class="done">Final on the source chain<span class="sub">15 min ago · slot 10<\/span><\/li>/);
  assert.match(out, /<li class="current">Proof on the message board · waiting on message board post<\/li>/);
  assert.match(out, /<li class="pending">Light client updated on the destination chain<span class="sub">the light client head is at slot 1<\/span><\/li>/);
  assert.match(out, /<li class="pending">Delivered<\/li>/);
  assert.match(out, /Proof slot 1 → 20.*made, not on the message board yet/);
  const done = page.progressView({ stages: [{ key: "delivered", status: "done", at: NOW }], waitingOn: { service: "none", since: NOW, detail: "delivered" } }, NOW);
  assert.match(done, /<b>Done\.<\/b> delivered/);
  assert.match(done, /<li class="done">Delivered<span class="sub">now<\/span><\/li>/);
  const applied = page.progressView({ stages: [], proof: { startSlot: 1, newSlot: 2, where: "applied" }, waitingOn: { service: "delivery", since: NOW } }, NOW);
  assert.match(applied, /<span class="ok">applied<\/span>/);
  assert.match(applied, /Waiting on <b>delivery<\/b> since now<span class="sub">The destination chain accepts the transfer; a runner delivers it\.<\/span>/);
});

test("the lookup asks the prove host and shows the timeline, a refusal or an unknown transfer", async () => {
  const progress = { stages: [{ key: "sent", status: "current" }], waitingOn: { service: "source-chain-finality", since: NOW } };
  const { page, elements, requests } = load("indexer.zkb.fi", {
    [`https://prove.zkb.fi/progress/${ID}`]: { status: 200, body: progress },
    [`https://prove.zkb.fi/progress/0x${"cd".repeat(32)}`]: { status: 404, body: {} },
    [`https://prove.zkb.fi/progress/0x${"ef".repeat(32)}`]: { status: 429, body: {}, headers: { "Retry-After": "12" } },
    [`https://prove.zkb.fi/progress/0x${"12".repeat(32)}`]: { status: 503, body: {} },
  });
  await page.lookup(ID);
  assert.ok(requests.includes(`https://prove.zkb.fi/progress/${ID}`));
  assert.match(elements.progress.innerHTML, /Waiting on <b>source chain finality<\/b>/);
  await page.lookup(`0x${"cd".repeat(32)}`);
  assert.match(elements.progress.innerHTML, /The indexer does not know this transfer/);
  await page.lookup(`0x${"ef".repeat(32)}`);
  assert.match(elements.progress.innerHTML, /Too many lookups.*Try again in 12 s\./);
  await page.lookup(`0x${"12".repeat(32)}`);
  assert.match(elements.progress.innerHTML, /The proving service did not answer/);
  await page.lookup("0x1234");
  assert.match(elements.progress.innerHTML, /Enter a message ID/);
});

test("the page reads both directions and the timings from the prove host, named by the pair's chains", async () => {
  const pipeline = (direction) => ({ direction, now: NOW, batch: null, job: null, latestJob: null, latestProof: null, head: null, decision: null });
  const empty = { medianMs: null, p90Ms: null, count: 0 };
  const { page, elements, requests } = load("indexer.zkb.fi", {
    "/api/pair": { status: 200, body: { sides: [{ chainId: 11155111 }, { chainId: 943 }] } },
    "https://prove.zkb.fi/directions/first-to-second/pipeline": { status: 200, body: pipeline("first-to-second") },
    "https://prove.zkb.fi/directions/second-to-first/pipeline": { status: 200, body: pipeline("second-to-first") },
    "https://prove.zkb.fi/benchmarks?window=24h": { status: 200, body: { window: "24h", to: NOW, indexer: "ok", steps: { workerWait: empty }, recent: [] } },
  });
  // The page loads on its own at start.
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.pipeline.innerHTML, /<h3>Sepolia → PulseChain testnet v4<\/h3>.*<h3>PulseChain testnet v4 → Sepolia<\/h3>/);
  assert.match(elements.timings.innerHTML, /Wait for a GPU worker/);
  // The pipeline is read every time, the timings once a minute, the pair once.
  requests.length = 0;
  await page.loadPipeline();
  assert.deepEqual(requests, ["https://prove.zkb.fi/directions/first-to-second/pipeline", "https://prove.zkb.fi/directions/second-to-first/pipeline"]);
});

test("a prove host that does not answer is shown as unreachable", async () => {
  const { page, elements } = load("indexer.zkb.fi", {
    "/api/pair": { status: 200, body: { sides: [{ chainId: 1 }, { chainId: 369 }] } },
    "https://prove.zkb.fi/directions/first-to-second/pipeline": { status: 502, body: {} },
    "https://prove.zkb.fi/directions/second-to-first/pipeline": { status: 502, body: {} },
  });
  await page.loadPipeline();
  assert.match(elements.pipeline.innerHTML, /The proving service did not answer.*This page asks again every 15 seconds\./);
});
