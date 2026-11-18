// Tests of apply.mjs. No call reaches RunPod: the HTTP client is a stub. Run: node --test deploy/runpod
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ApplyError,
  CREATE_FIELDS,
  GPU_FIELDS,
  PATCH_FIELDS,
  RUNPOD_REST_URL,
  WORKERS_FIELDS,
  applyPlan,
  describePlan,
  diffEndpoint,
  listAll,
  makeRestClient,
  parseArguments,
  parseConfig,
  planChanges,
  problemText,
  readLive,
  run,
  unusedTemplates,
  wantedBody,
} from "./apply.mjs";

const fileText = readFileSync(new URL("./endpoints.json", import.meta.url), "utf8");
const config = () => parseConfig(fileText);
/** The endpoints of the live testnet pair: the three tiers that exist at RunPod. */
const testnetTiers = () => config().endpoints.filter((tier) => tier.pair === "sepolia-pls943");
const edit = (change) => {
  const copy = JSON.parse(fileText);
  change(copy);
  return JSON.stringify(copy);
};

/** The account of 2026-11-16 as `GET /v2/serverless` lists it: the three tiers, with the one value that differs from the file (gpu-48gb minCudaVersion 12.0). */
const liveEndpoint = (over = {}) => ({
  id: "43nsvfb8svkosr",
  name: "zk-bridge-prover-gpu",
  type: "LOAD_BALANCER",
  image: config().container.image,
  env: { PORT: "8000", PORT_HEALTH: "8000" },
  disk: 40,
  ports: ["8000/http"],
  registry: "cmvts6161003dsycaos24r5wg",
  gpu: { pools: ["AMPERE_24", "ADA_24"], excludedTypes: ["NVIDIA RTX A5000"], minCudaVersion: "12.8", allowedCudaVersions: [], count: 1 },
  workers: { min: 0, max: 1, idleTimeout: 5 },
  scaling: { type: "REQUEST_COUNT", requestCount: 1 },
  dataCenterIds: ["EU-RO-1"],
  networkVolumes: [],
  mounts: [],
  timeout: 600000,
  flashboot: "FLASHBOOT",
  createdAt: "2026-11-01T00:00:00Z",
  ...over,
});
const LIVE = [
  liveEndpoint(),
  liveEndpoint({ id: "muecz9pudncily", name: "zk-bridge-prover-gpu-32gb", gpu: { pools: ["ADA_32_PRO"], excludedTypes: [], minCudaVersion: "12.8", allowedCudaVersions: [], count: 1 } }),
  liveEndpoint({ id: "nuax43o5zxyv9a", name: "zk-bridge-prover-gpu-48gb", gpu: { pools: ["ADA_48_PRO"], excludedTypes: ["NVIDIA L40"], minCudaVersion: "12.0", allowedCudaVersions: [], count: 1 }, workers: { min: 0, max: 0, idleTimeout: 5 } }),
];
const TEMPLATES = [
  { id: "hsj330cqpf", name: "zk-bridge-prover-gpu-template", serverless: true, public: false },
  { id: "10sn7k4j8q", name: "zk-bridge-prover-gpu-32gb-template", serverless: true, public: false },
  { id: "pubtemplate1", name: "runpod-public", serverless: true, public: true },
  { id: "podtemplate1", name: "a-pod", serverless: false, public: false },
];

/**
 * A stub of the REST client. It answers GET /serverless and GET /templates (two pages for the endpoints, to test the cursor),
 * records every request, and fails a path in `fail`.
 */
function fakeClient({ endpoints = LIVE, templates = TEMPLATES, fail = {} } = {}) {
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      const key = `${method} ${path.split("?")[0]}`;
      if (fail[key] !== undefined) throw new ApplyError(fail[key]);
      if (method === "GET" && path.startsWith("/serverless")) {
        const url = new URL(path, "https://x.test");
        const start = url.searchParams.get("cursor") === "page2" ? 1 : 0;
        const page = start === 0 ? endpoints.slice(0, 1) : endpoints.slice(1);
        return { endpoints: page, pagination: { nextCursor: start === 0 && endpoints.length > 1 ? "page2" : null, hasNextPage: start === 0 && endpoints.length > 1 } };
      }
      if (method === "GET" && path.startsWith("/templates")) return { templates, pagination: { nextCursor: null, hasNextPage: false } };
      if (method === "POST") return { id: "newid123456789", ...body };
      return null;
    },
  };
  return { client, calls, writes: () => calls.filter((call) => call.method !== "GET") };
}

test("the file in the repository is valid and holds the three tiers in order, one retired endpoint and no secret", () => {
  const { container, retired } = config();
  const endpoints = testnetTiers();
  assert.deepEqual(endpoints.map((tier) => tier.label), ["gpu-24gb", "gpu-32gb", "gpu-48gb"]);
  assert.deepEqual(endpoints.map((tier) => tier.id), ["43nsvfb8svkosr", "muecz9pudncily", "nuax43o5zxyv9a"]);
  assert.deepEqual(endpoints.map((tier) => tier.gpu.pools), [["ADA_24", "AMPERE_24"], ["ADA_32_PRO"], ["ADA_48_PRO"]]);
  assert.deepEqual(endpoints.map((tier) => tier.gpu.excludedTypes), [["NVIDIA RTX A5000"], [], ["NVIDIA L40"]]);
  assert.deepEqual(retired, ["zmp5owbxu73fc2"]);
  assert.match(container.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(container.registry, "cmvts6161003dsycaos24r5wg");
  assert.deepEqual(container.env, { PORT: "8000", PORT_HEALTH: "8000" });
  assert.deepEqual(container.ports, ["8000/http"]);
  assert.equal(container.disk, 40);
  assert.equal(JSON.parse(fileText).template, undefined, "there are no templates in REST v2");
  assert.doesNotMatch(fileText, /rpa_|api[_-]?key|secret|token/i);
});

test("every tier asks for CUDA 12.8, which the image needs (docker/Dockerfile: nvidia/cuda 12.8.2 runtime, driver 570 or newer)", () => {
  assert.deepEqual(config().endpoints.map((tier) => tier.gpu.minCudaVersion), Array(6).fill("12.8"));
  const dockerfile = readFileSync(new URL("../../docker/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /nvidia\/cuda:12\.8\.\d+-runtime/);
});

test("the three tiers declare the live values of 2026-11-16: workers 0 to 1 (0 to 0 for gpu-48gb since 2026-11-18), idle timeout 5, FLASHBOOT, 600000 ms, REQUEST_COUNT 1, LOAD_BALANCER", () => {
  for (const tier of config().endpoints) {
    assert.deepEqual(tier.workers, { min: 0, max: tier.label.startsWith("gpu-48gb") ? 0 : 1 });
    assert.equal(tier.idleTimeout, 5);
    assert.equal(tier.flashboot, "FLASHBOOT");
    assert.equal(tier.timeoutMs, 600000);
    assert.deepEqual(tier.scaling, { type: "REQUEST_COUNT", requestCount: 1 });
    assert.equal(tier.type, "LOAD_BALANCER");
  }
});

test("against the live account the file differs only in minCudaVersion of gpu-48gb (12.0 live, 12.8 wanted)", () => {
  const plan = planChanges(config(), { endpoints: LIVE, templates: [] });
  const differences = plan.endpoints.flatMap(({ tier, changes }) => changes.map((change) => `${tier.label} ${change.field} ${change.from} -> ${change.to}`));
  assert.deepEqual(differences, ["gpu-48gb gpu.minCudaVersion 12.0 -> 12.8"]);
  assert.deepEqual(plan.endpoints[2].patch, { gpu: { pools: ["ADA_48_PRO"], excludedTypes: ["NVIDIA L40"], minCudaVersion: "12.8" } });
  assert.equal(plan.endpoints[0].patch, null);
  assert.equal(plan.endpoints[1].patch, null);
  assert.deepEqual(plan.unmanaged, []);
});

test("parseConfig refuses a file that is not JSON or has the wrong shape", () => {
  assert.throws(() => parseConfig("{"), /not valid JSON/);
  assert.throws(() => parseConfig("[]"), /must be an object/);
  assert.throws(() => parseConfig(edit((c) => (c.template = {}))), /no per-tier templates/);
  assert.throws(() => parseConfig(edit((c) => delete c.container)), /"container"/);
  assert.throws(() => parseConfig(edit((c) => (c.container.image = ""))), /"image"/);
  assert.throws(() => parseConfig(edit((c) => (c.container.disk = 0))), /"disk"/);
  assert.throws(() => parseConfig(edit((c) => (c.container.ports = []))), /"ports"/);
  assert.throws(() => parseConfig(edit((c) => (c.container.ports = [8000]))), /"ports"/);
  assert.throws(() => parseConfig(edit((c) => (c.container.env = { PORT: 8000 }))), /"env"/);
  assert.throws(() => parseConfig(edit((c) => (c.container.registry = 5))), /"registry"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints = []))), /"endpoints"/);
  assert.throws(() => parseConfig(edit((c) => (c.retired = [1]))), /"retired"/);
  assert.throws(() => parseConfig(edit((c) => (c.keepTemplates = [1]))), /"keepTemplates"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0] = 5))), /not an object/);
  assert.throws(() => parseConfig(edit((c) => delete c.endpoints[0].name)), /"name"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].type = "LB"))), /"type"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].gpu.pools = []))), /"pools"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].gpu.excludedTypes = ["-NVIDIA L40"]))), /excludedTypes/);
  assert.throws(() => parseConfig(edit((c) => delete c.endpoints[0].gpu.excludedTypes)), /excludedTypes/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].gpu.minCudaVersion = "12"))), /minCudaVersion/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].gpu.minCudaVersion = 12.8))), /minCudaVersion/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].workers = { min: 2, max: 1 }))), /"workers"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].idleTimeout = "5"))), /"idleTimeout"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].idleTimeout = 0))), /"idleTimeout"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].flashboot = "FLASHBOOT_ON"))), /"flashboot"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].timeoutMs = "600000"))), /"timeoutMs"/);
  assert.throws(() => parseConfig(edit((c) => delete c.endpoints[0].scaling)), /"scaling"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].scaling = { type: "REQUEST_COUNT", requestCount: 0 }))), /requestCount/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].scaling = { type: "QUEUE_DELAY", queueDelay: 4 }))), /LOAD_BALANCER/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].scaling = { type: "SOMETHING" }))), /REQUEST_COUNT or QUEUE_DELAY/);
  assert.throws(() => parseConfig(edit((c) => ((c.endpoints[0].type = "QUEUE"), (c.endpoints[0].scaling = { type: "QUEUE_DELAY", queueDelay: 0.1 })))), /queueDelay/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].name = c.endpoints[0].name))), /twice/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].id = c.endpoints[0].id))), /used twice/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].id = 7))), /not text/);
  assert.throws(() => parseConfig(edit((c) => (c.retired = [c.endpoints[0].id]))), /both as an endpoint and as retired/);
  assert.deepEqual(parseConfig(edit((c) => delete c.retired)).retired, []);
  assert.deepEqual(parseConfig(edit((c) => delete c.container.registry)).container.registry, undefined);
  const queue = parseConfig(edit((c) => ((c.endpoints[0].type = "QUEUE"), (c.endpoints[0].scaling = { type: "QUEUE_DELAY", queueDelay: 4 }))));
  assert.equal(queue.endpoints[0].type, "QUEUE");
});

test("wantedBody holds the shared container settings and the tier's own, in the API's shape, with the idle timeout from the tier", () => {
  const { container, endpoints } = config();
  const body = wantedBody(container, endpoints[0]);
  assert.deepEqual(body, {
    name: "zk-bridge-prover-gpu",
    type: "LOAD_BALANCER",
    image: container.image,
    disk: 40,
    ports: ["8000/http"],
    env: { PORT: "8000", PORT_HEALTH: "8000" },
    registry: "cmvts6161003dsycaos24r5wg",
    gpu: { pools: ["ADA_24", "AMPERE_24"], excludedTypes: ["NVIDIA RTX A5000"], minCudaVersion: "12.8" },
    workers: { min: 0, max: 1, idleTimeout: 5 },
    flashboot: "FLASHBOOT",
    timeout: 600000,
    scaling: { type: "REQUEST_COUNT", requestCount: 1 },
  });
  assert.equal("registry" in wantedBody({ ...container, registry: undefined }, endpoints[0]), false);
});

test("diffEndpoint lists each field that differs with old and new values, masks environment values, ignores the order of lists", () => {
  const { container, endpoints } = config();
  const tier = endpoints[0];
  assert.deepEqual(diffEndpoint(container, tier, liveEndpoint()), { exists: true, changes: [], patch: null, create: null, warnings: [] });
  const changed = diffEndpoint(
    container,
    tier,
    liveEndpoint({
      image: "ghcr.io/x@sha256:old",
      disk: 20,
      ports: ["8000/tcp"],
      registry: null,
      env: { PORT: "9999", EXTRA: "hunter2" },
      gpu: { pools: ["ADA_24"], excludedTypes: [], minCudaVersion: null },
      workers: { min: 1, max: 2, idleTimeout: 60 },
      flashboot: "OFF",
      timeout: 300000,
      scaling: { type: "REQUEST_COUNT", requestCount: 4 },
      name: "old-name",
    }),
  );
  assert.deepEqual(
    changed.changes.map((change) => change.field),
    ["name", "image", "disk", "registry", "flashboot", "timeout", "ports", "env.EXTRA", "env.PORT", "env.PORT_HEALTH", "gpu.pools", "gpu.excludedTypes", "gpu.minCudaVersion", "workers.min", "workers.max", "workers.idleTimeout", "scaling.requestCount"],
  );
  assert.deepEqual(changed.changes[1], { field: "image", from: "ghcr.io/x@sha256:old", to: container.image });
  assert.deepEqual(changed.changes.slice(7, 10), [
    { field: "env.EXTRA", from: "(set)", to: "(removed)" },
    { field: "env.PORT", from: "(set)", to: "(set)" },
    { field: "env.PORT_HEALTH", from: undefined, to: "(set)" },
  ]);
  assert.equal(JSON.stringify(changed).includes("hunter2"), false);
  assert.equal(JSON.stringify(changed).includes('"9999"'), false);
});

test("the patch carries the fields that differ and nothing else; gpu goes whole, workers by field, and only schema fields are sent", () => {
  const { container, endpoints } = config();
  const tier = endpoints[0];
  assert.deepEqual(diffEndpoint(container, tier, liveEndpoint({ workers: { min: 0, max: 3, idleTimeout: 5 } })).patch, { workers: { max: 1 } });
  assert.deepEqual(diffEndpoint(container, tier, liveEndpoint({ workers: { min: 0, max: 1, idleTimeout: 60 } })).patch, { workers: { idleTimeout: 5 } });
  assert.deepEqual(diffEndpoint(container, tier, liveEndpoint({ image: "other" })).patch, { image: container.image });
  assert.deepEqual(diffEndpoint(container, tier, liveEndpoint({ env: {} })).patch, { env: { PORT: "8000", PORT_HEALTH: "8000" } });
  assert.deepEqual(diffEndpoint(container, tier, liveEndpoint({ scaling: { type: "QUEUE_DELAY", queueDelay: 4 } })).patch, { scaling: { type: "REQUEST_COUNT", requestCount: 1 } });
  assert.deepEqual(diffEndpoint(container, tier, liveEndpoint({ gpu: { pools: ["AMPERE_24", "ADA_24"], excludedTypes: [], minCudaVersion: "12.8" } })).patch, {
    gpu: { pools: ["ADA_24", "AMPERE_24"], excludedTypes: ["NVIDIA RTX A5000"], minCudaVersion: "12.8" },
  });
  const everything = diffEndpoint(container, tier, liveEndpoint({ name: "x", image: "x", disk: 1, ports: [], registry: "other", env: { A: "b" }, gpu: { pools: ["X"], excludedTypes: [], minCudaVersion: "9.0" }, workers: { min: 5, max: 5, idleTimeout: 9 }, flashboot: "OFF", timeout: 1, scaling: { type: "REQUEST_COUNT", requestCount: 9 } })).patch;
  assert.deepEqual(Object.keys(everything).sort(), [...PATCH_FIELDS].sort());
  assert.deepEqual(Object.keys(everything.gpu).sort(), [...GPU_FIELDS].sort());
  assert.deepEqual(Object.keys(everything.workers).sort(), [...WORKERS_FIELDS].sort());
  assert.equal("type" in everything, false, "an endpoint's type is not patchable");
  // An id or a label of the file, or anything the live endpoint reports (dataCenterIds, createdAt...), never reaches RunPod.
  for (const field of Object.keys(everything)) assert.ok(PATCH_FIELDS.includes(field));
});

test("scaling is compared by the fields the file names: extra or null fields and the order of keys are no difference, and nothing is patched for them", () => {
  const { container, endpoints } = config();
  const tier = endpoints[0];
  for (const scaling of [{ requestCount: 1, type: "REQUEST_COUNT" }, { type: "REQUEST_COUNT", requestCount: 1, queueDelay: null, extra: 7 }]) {
    const result = diffEndpoint(container, tier, liveEndpoint({ gpu: { ...liveEndpoint().gpu, minCudaVersion: "12.0" }, scaling }));
    assert.deepEqual(result.changes.map((change) => change.field), ["gpu.minCudaVersion"]);
    assert.deepEqual(Object.keys(result.patch), ["gpu"]);
  }
  const same = diffEndpoint(container, tier, liveEndpoint({ scaling: { requestCount: 1, type: "REQUEST_COUNT", queueDelay: null } }));
  assert.equal(same.patch, null);
  assert.deepEqual(same.changes, []);
  const nothing = diffEndpoint(container, tier, liveEndpoint({ scaling: null }));
  assert.deepEqual(nothing.changes.map((change) => change.field), ["scaling.type", "scaling.requestCount"]);
});

test("a real difference in scaling is listed and patched, and the patch lists what it sends", () => {
  const { container, endpoints } = config();
  const tier = endpoints[0];
  const result = diffEndpoint(container, tier, liveEndpoint({ scaling: { requestCount: 4, type: "REQUEST_COUNT", queueDelay: null } }));
  assert.deepEqual(result.changes, [{ field: "scaling.requestCount", from: 4, to: 1 }]);
  assert.deepEqual(result.patch, { scaling: { type: "REQUEST_COUNT", requestCount: 1 } });
});

test("--apply does not patch scaling when only its key order or extra fields differ", async () => {
  const reshaped = LIVE.map((endpoint) => (endpoint.id === "nuax43o5zxyv9a" ? { ...endpoint, scaling: { requestCount: 1, queueDelay: null, type: "REQUEST_COUNT" } } : endpoint));
  const { client, writes } = fakeClient({ endpoints: reshaped });
  assert.equal(await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, client, out: () => {} }), 0);
  assert.ok(writes().every((write) => !("scaling" in write.body)));
});

test("a registry that the file does not name is left alone; the type of a live endpoint that differs is a warning, not a patch", () => {
  const { container, endpoints } = config();
  const noRegistry = { ...container };
  delete noRegistry.registry;
  assert.equal(diffEndpoint(noRegistry, endpoints[0], liveEndpoint({ registry: "something" })).patch, null);
  const other = diffEndpoint(container, endpoints[0], liveEndpoint({ type: "QUEUE" }));
  assert.equal(other.patch, null);
  assert.match(other.warnings[0], /is a QUEUE endpoint at RunPod, not LOAD_BALANCER.*delete and create/);
});

test("a missing endpoint is created with schema fields, type and scaling included, and without the id or label", () => {
  const { container, endpoints } = config();
  const result = diffEndpoint(container, { ...endpoints[1], id: undefined }, null);
  assert.equal(result.exists, false);
  assert.deepEqual(Object.keys(result.create).sort(), [...CREATE_FIELDS].sort());
  assert.equal(result.create.type, "LOAD_BALANCER");
  assert.deepEqual(result.create.scaling, { type: "REQUEST_COUNT", requestCount: 1 });
  assert.deepEqual(result.create.gpu, { pools: ["ADA_32_PRO"], excludedTypes: [], minCudaVersion: "12.8" });
  assert.equal("id" in result.create || "label" in result.create, false);
});

test("planChanges finds a tier by id, or by name without an id; retired and unknown endpoints are told apart", () => {
  const byName = parseConfig(edit((c) => c.endpoints.forEach((tier) => delete tier.id)));
  const plan = planChanges(byName, { endpoints: [...LIVE, liveEndpoint({ id: "zmp5owbxu73fc2", name: "old" }), liveEndpoint({ id: "stray0000", name: "somebody-elses" })], templates: [] });
  assert.deepEqual(plan.endpoints.map((entry) => entry.live?.id), ["43nsvfb8svkosr", "muecz9pudncily", "nuax43o5zxyv9a"]);
  assert.deepEqual(plan.retired.map((entry) => [entry.id, entry.live?.name ?? null]), [["zmp5owbxu73fc2", "old"]]);
  assert.deepEqual(plan.unmanaged, [{ id: "stray0000", name: "somebody-elses" }]);
  const empty = planChanges(config(), { endpoints: [], templates: [] });
  assert.deepEqual(empty.endpoints.map((entry) => entry.exists), [false, false, false]);
  assert.deepEqual(empty.retired, [{ id: "zmp5owbxu73fc2", live: null }]);
});

test("unusedTemplates lists private serverless templates, skips public and pod ones and those in keepTemplates", () => {
  assert.deepEqual(unusedTemplates(TEMPLATES, config()), [{ id: "hsj330cqpf", name: "zk-bridge-prover-gpu-template" }, { id: "10sn7k4j8q", name: "zk-bridge-prover-gpu-32gb-template" }]);
  const kept = parseConfig(edit((c) => (c.keepTemplates = ["hsj330cqpf"])));
  assert.deepEqual(unusedTemplates(TEMPLATES, kept).map((template) => template.id), ["10sn7k4j8q"]);
});

test("describePlan prints a line per tier with old and new values, the retired, unknown and unused templates, and never an environment value", () => {
  const live = [liveEndpoint({ env: { PORT: "hunter2" }, workers: { min: 0, max: 1, idleTimeout: 60 } }), LIVE[1], liveEndpoint({ id: "stray0000", name: "other" })];
  const text = describePlan(planChanges(config(), { endpoints: [...live, LIVE[2]], templates: TEMPLATES })).join("\n");
  assert.match(text, /endpoint gpu-24gb \(sepolia-pls943, zk-bridge-prover-gpu, 43nsvfb8svkosr\): changes/);
  assert.match(text, /workers\.idleTimeout: 60 -> 5/);
  assert.match(text, /env\.PORT: \(set\) -> \(set\)/);
  assert.match(text, /endpoint gpu-32gb \(sepolia-pls943, zk-bridge-prover-gpu-32gb, muecz9pudncily\): no change/);
  assert.match(text, /gpu\.minCudaVersion: "12\.0" -> "12\.8"/);
  assert.match(text, /retired zmp5owbxu73fc2: already gone/);
  assert.match(text, /not in the file, left alone: stray0000 \(other\)/);
  assert.match(text, /templates that no tier needs[^\n]*--delete-unused-templates/);
  assert.match(text, /hsj330cqpf \(zk-bridge-prover-gpu-template\)/);
  assert.doesNotMatch(text, /hunter2|public|a-pod/);
  const created = describePlan(planChanges(config(), { endpoints: [], templates: [] })).join("\n");
  assert.match(created, /endpoint gpu-24gb \(sepolia-pls943, zk-bridge-prover-gpu, 43nsvfb8svkosr\): does not exist, will be created/);
  const present = describePlan(planChanges(config(), { endpoints: [...LIVE, liveEndpoint({ id: "zmp5owbxu73fc2", name: "old" })], templates: [] })).join("\n");
  assert.match(present, /retired zmp5owbxu73fc2 \(old\): still exists; deleted only with --apply --delete-retired/);
  const odd = describePlan(planChanges(config(), { endpoints: [liveEndpoint({ type: "QUEUE" }), LIVE[1], LIVE[2]], templates: [] })).join("\n");
  assert.match(odd, /warning: is a QUEUE endpoint/);
});

test("readLive follows the cursor through every page of the endpoints and reads the templates", async () => {
  const { client, calls } = fakeClient();
  const live = await readLive(client);
  assert.deepEqual(live.endpoints.map((endpoint) => endpoint.id), ["43nsvfb8svkosr", "muecz9pudncily", "nuax43o5zxyv9a"]);
  assert.equal(live.templates.length, 4);
  assert.deepEqual(calls.map((call) => call.path), ["/serverless?limit=100", "/serverless?limit=100&cursor=page2", "/templates?limit=100"]);
  await assert.rejects(listAll({ request: async () => ({ nope: true }) }, "/serverless", "endpoints"), /no "endpoints" list/);
  await assert.rejects(listAll({ request: async () => ({ endpoints: [], pagination: { hasNextPage: true, nextCursor: "again" } }) }, "/serverless", "endpoints"), /too many pages/);
});

test("a dry run reads the account, prints the differences and sends nothing but GET requests", async () => {
  const { client, calls } = fakeClient();
  const out = [];
  const code = await run({ argv: [], env: { RUNPOD_API_KEY: "k" }, client, out: (line) => out.push(line), err: () => assert.fail("no error expected") });
  assert.equal(code, 0);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.match(out.join("\n"), /gpu\.minCudaVersion: "12\.0" -> "12\.8"/);
  assert.match(out.at(-1), /dry run: nothing changed/);
});

test("--apply patches only the tier that differs, with only the field that differs, and nothing else", async () => {
  const { client, writes } = fakeClient();
  const out = [];
  const code = await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, client, out: (line) => out.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(writes(), [{ method: "PATCH", path: "/serverless/nuax43o5zxyv9a", body: { gpu: { pools: ["ADA_48_PRO"], excludedTypes: ["NVIDIA L40"], minCudaVersion: "12.8" } } }]);
  assert.ok(out.includes("patched endpoint gpu-48gb (nuax43o5zxyv9a): gpu"));
  assert.equal(out.at(-1), "done");
});

test("--apply with every endpoint settled writes nothing", async () => {
  const settled = LIVE.map((endpoint) => (endpoint.id === "nuax43o5zxyv9a" ? { ...endpoint, gpu: { ...endpoint.gpu, minCudaVersion: "12.8" } } : endpoint));
  const { client, writes } = fakeClient({ endpoints: settled });
  assert.equal(await run({ argv: ["--apply", "--delete-retired"], env: { RUNPOD_API_KEY: "k" }, client, out: () => {} }), 0);
  assert.deepEqual(writes(), []);
});

test("--apply creates a missing endpoint and says which id to put in the file", async () => {
  const { client, writes } = fakeClient({ endpoints: [LIVE[0], LIVE[2]] });
  const out = [];
  assert.equal(await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, client, out: (line) => out.push(line) }), 0);
  const [create, patch] = writes();
  assert.equal(create.method, "POST");
  assert.equal(create.path, "/serverless");
  assert.equal(create.body.name, "zk-bridge-prover-gpu-32gb");
  assert.deepEqual(Object.keys(create.body).sort(), [...CREATE_FIELDS].sort());
  assert.equal(patch.method, "PATCH");
  assert.ok(out.includes("created endpoint gpu-32gb (newid123456789); put this id in endpoints.json"));
});

test("retired endpoints are kept without --delete-retired, and deleted with it (scaled to zero first when they may run workers)", async () => {
  const retired = liveEndpoint({ id: "zmp5owbxu73fc2", name: "old", workers: { min: 0, max: 1, idleTimeout: 5 } });
  const settled = [LIVE[0], LIVE[1], { ...LIVE[2], gpu: { ...LIVE[2].gpu, minCudaVersion: "12.8" } }];
  const kept = fakeClient({ endpoints: [...settled, retired] });
  await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, client: kept.client, out: () => {} });
  assert.deepEqual(kept.writes(), []);
  const deleted = fakeClient({ endpoints: [...settled, retired] });
  const out = [];
  await run({ argv: ["--apply", "--delete-retired"], env: { RUNPOD_API_KEY: "k" }, client: deleted.client, out: (line) => out.push(line) });
  assert.deepEqual(deleted.writes(), [
    { method: "PATCH", path: "/serverless/zmp5owbxu73fc2", body: { workers: { min: 0, max: 0 } } },
    { method: "DELETE", path: "/serverless/zmp5owbxu73fc2", body: undefined },
  ]);
  assert.ok(out.includes("deleted retired endpoint zmp5owbxu73fc2"));
  const idle = fakeClient({ endpoints: [...settled, { ...retired, workers: { min: 0, max: 0, idleTimeout: 5 } }] });
  await run({ argv: ["--apply", "--delete-retired"], env: { RUNPOD_API_KEY: "k" }, client: idle.client, out: () => {} });
  assert.deepEqual(idle.writes().map((call) => call.method), ["DELETE"]);
});

test("unused templates are listed in every run and deleted only with --apply --delete-unused-templates", async () => {
  const settled = LIVE.map((endpoint) => (endpoint.id === "nuax43o5zxyv9a" ? { ...endpoint, gpu: { ...endpoint.gpu, minCudaVersion: "12.8" } } : endpoint));
  const listed = fakeClient({ endpoints: settled });
  const out = [];
  await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, client: listed.client, out: (line) => out.push(line) });
  assert.deepEqual(listed.writes(), []);
  assert.match(out.join("\n"), /hsj330cqpf \(zk-bridge-prover-gpu-template\)/);
  const deleted = fakeClient({ endpoints: settled });
  const lines = [];
  await run({ argv: ["--apply", "--delete-unused-templates"], env: { RUNPOD_API_KEY: "k" }, client: deleted.client, out: (line) => lines.push(line) });
  assert.deepEqual(deleted.writes().map((call) => `${call.method} ${call.path}`), ["DELETE /templates/hsj330cqpf", "DELETE /templates/10sn7k4j8q"]);
  assert.ok(lines.includes("deleted template hsj330cqpf (zk-bridge-prover-gpu-template)"));
});

test("the command line: the delete flags need --apply, unknown arguments and a missing config path are refused", () => {
  assert.deepEqual(parseArguments([]), { apply: false, deleteRetired: false, deleteUnusedTemplates: false, config: null, pair: null });
  assert.deepEqual(parseArguments(["--apply", "--delete-retired", "--delete-unused-templates", "--config", "-"]), { apply: true, deleteRetired: true, deleteUnusedTemplates: true, config: "-", pair: null });
  assert.throws(() => parseArguments(["--delete-retired"]), /only with --apply/);
  assert.throws(() => parseArguments(["--delete-unused-templates"]), /only with --apply/);
  assert.throws(() => parseArguments(["--config"]), /--config needs a path/);
  assert.equal(parseArguments(["--pair", "eth-pls"]).pair, "eth-pls");
  assert.throws(() => parseArguments(["--pair"]), /--pair needs the name of a pair/);
  assert.throws(() => parseArguments(["--pair", "--apply"]), /--pair needs the name of a pair/);
  assert.throws(() => parseArguments(["--force"]), /unknown argument --force/);
});

test("run: the key must be in the environment; the configuration comes from a path, standard input (--config -) or the default file", async () => {
  const errors = [];
  assert.equal(await run({ argv: [], env: {}, client: fakeClient().client, err: (line) => errors.push(line) }), 1);
  assert.match(errors[0], /set RUNPOD_API_KEY/);
  const paths = [];
  const readFile = (path) => (paths.push(path), fileText);
  await run({ argv: ["--config", "other.json"], env: { RUNPOD_API_KEY: "k" }, client: fakeClient().client, readFile, out: () => {} });
  await run({ argv: [], env: { RUNPOD_API_KEY: "k" }, client: fakeClient().client, readFile, out: () => {} });
  assert.equal(paths[0], "other.json");
  assert.match(paths[1], /endpoints\.json$/);
  const fromStdin = [];
  assert.equal(await run({ argv: ["--config", "-"], env: { RUNPOD_API_KEY: "k" }, client: fakeClient().client, readStdin: () => fileText, out: (line) => fromStdin.push(line) }), 0);
  assert.ok(fromStdin.length > 0);
  const bad = [];
  assert.equal(await run({ argv: [], env: { RUNPOD_API_KEY: "k" }, client: fakeClient().client, readFile: () => "{", err: (line) => bad.push(line) }), 1);
  assert.match(bad[0], /not valid JSON/);
});

test("an error from RunPod ends the run with a non-zero code and prints its message, never the key or the request", async () => {
  const key = "rpa_SECRET_KEY_VALUE";
  const { client } = fakeClient({ fail: { "PATCH /serverless/nuax43o5zxyv9a": "RunPod refused PATCH /serverless/nuax43o5zxyv9a: HTTP 422: Unprocessable Entity: unknown field" } });
  const errors = [];
  assert.equal(await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: key }, client, out: () => {}, err: (line) => errors.push(line) }), 1);
  assert.match(errors[0], /HTTP 422: Unprocessable Entity: unknown field/);
  assert.equal(errors.join("").includes(key), false);
  const unexpected = [];
  const broken = { request: async () => { throw Object.assign(new Error("boom"), { code: "EBROKEN" }); } };
  assert.equal(await run({ argv: [], env: { RUNPOD_API_KEY: key }, client: broken, err: (line) => unexpected.push(line) }), 1);
  assert.equal(unexpected[0], "failed: EBROKEN");
  const plain = { request: async () => { throw new Error("boom"); } };
  const other = [];
  await run({ argv: [], env: { RUNPOD_API_KEY: key }, client: plain, err: (line) => other.push(line) });
  assert.equal(other[0], "failed: unexpected error");
});

test("makeRestClient sends the key as a bearer header to the v2 address, the body as JSON, and returns the answer", async () => {
  const seen = [];
  const fetchFunction = async (url, init) => (seen.push({ url, init }), new Response(JSON.stringify({ id: "x" }), { status: 200 }));
  const client = makeRestClient("rpa_KEY", fetchFunction);
  assert.deepEqual(await client.request("PATCH", "/serverless/abc", { workers: { max: 1 } }), { id: "x" });
  assert.equal(RUNPOD_REST_URL, "https://api.runpod.io/v2");
  assert.equal(seen[0].url, "https://api.runpod.io/v2/serverless/abc");
  assert.equal(seen[0].init.method, "PATCH");
  assert.equal(seen[0].init.headers.authorization, "Bearer rpa_KEY");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.equal(seen[0].init.body, JSON.stringify({ workers: { max: 1 } }));
  await client.request("GET", "/serverless");
  assert.equal(seen[1].init.body, undefined);
  assert.equal("content-type" in seen[1].init.headers, false);
  const other = makeRestClient("k", fetchFunction, "https://example.test/v2/");
  await other.request("GET", "/templates");
  assert.equal(seen[2].url, "https://example.test/v2/templates");
});

test("makeRestClient reads an empty answer (the 204 of a delete) as null", async () => {
  const client = makeRestClient("k", async () => new Response(null, { status: 204 }));
  assert.equal(await client.request("DELETE", "/serverless/abc"), null);
});

test("makeRestClient reports a problem answer (RFC 9457) with its status, title and detail, and never the key or the request body", async () => {
  const problem = { type: "about:blank", title: "Unprocessable Entity", status: 422, detail: "body/gpu: unknown field 'foo'" };
  const client = makeRestClient("rpa_KEY_VALUE", async () => new Response(JSON.stringify(problem), { status: 422, headers: { "content-type": "application/problem+json" } }));
  await assert.rejects(client.request("PATCH", "/serverless/abc", { gpu: { foo: 1 }, secret: "rpa_KEY_VALUE" }), (error) => {
    assert.ok(error instanceof ApplyError);
    assert.equal(error.message, "RunPod refused PATCH /serverless/abc: HTTP 422: Unprocessable Entity: body/gpu: unknown field 'foo'");
    assert.equal(error.message.includes("rpa_KEY_VALUE"), false);
    return true;
  });
  const plain = makeRestClient("k", async () => new Response("<html>", { status: 502 }));
  await assert.rejects(plain.request("GET", "/serverless"), /RunPod refused GET \/serverless: HTTP 502$/);
  const empty = makeRestClient("k", async () => new Response(null, { status: 401 }));
  await assert.rejects(empty.request("GET", "/serverless"), /HTTP 401$/);
  const odd = makeRestClient("k", async () => new Response("<html>", { status: 200 }));
  await assert.rejects(odd.request("GET", "/serverless"), /not JSON/);
  const down = makeRestClient("k", async () => { throw new TypeError("fetch failed: rpa_k"); });
  await assert.rejects(down.request("GET", "/serverless"), (error) => error.message === "RunPod did not answer GET /serverless");
  const noBody = makeRestClient("k", async () => ({ ok: false, status: 500, text: async () => { throw new Error("x"); } }));
  await assert.rejects(noBody.request("GET", "/x"), /HTTP 500$/);
});

test("problemText reads title and detail, trims long text and refuses what is not a problem document", () => {
  assert.equal(problemText({ title: "Not Found", detail: "no such endpoint" }), "Not Found: no such endpoint");
  assert.equal(problemText({ detail: "only detail" }), "only detail");
  assert.equal(problemText({ title: "a".repeat(500) }).length, 300);
  assert.equal(problemText("text"), null);
  assert.equal(problemText({ status: 500 }), null);
  assert.equal(problemText([]), null);
});

test("applyPlan with no flags and an empty plan writes nothing", async () => {
  const { client, writes } = fakeClient();
  assert.deepEqual(await applyPlan({ endpoints: [], retired: [], unmanaged: [], templates: [] }, client), []);
  assert.deepEqual(writes(), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Pairs (docs/superpowers/specs/2026-11-18-two-pairs-gas-and-proving-design.md, decision 4)

test("every endpoint names its pair: the live tiers are sepolia-pls943, the mainnet tiers are eth-pls, pending, with the same pools and workers min 0", () => {
  const tiers = config().endpoints;
  assert.deepEqual(testnetTiers().map((tier) => tier.pending), [undefined, undefined, undefined]);
  const mainnet = tiers.filter((tier) => tier.pair === "eth-pls");
  assert.deepEqual(mainnet.map((tier) => tier.name), ["zk-bridge-prover-gpu-eth-pls", "zk-bridge-prover-gpu-32gb-eth-pls", "zk-bridge-prover-gpu-48gb-eth-pls"]);
  assert.ok(mainnet.every((tier) => tier.pending === true && tier.id === undefined && tier.workers.min === 0));
  assert.deepEqual(mainnet.map((tier) => tier.gpu), testnetTiers().map((tier) => tier.gpu));
});

test("no endpoint id or name appears under two pairs in the file in the repository", () => {
  const tiers = config().endpoints;
  for (const key of ["id", "name"]) {
    const values = tiers.map((tier) => tier[key]).filter((value) => value !== undefined);
    assert.equal(new Set(values).size, values.length, key);
  }
});

test("parseConfig refuses an endpoint without a pair, a bad pending, and one id or name under two pairs", () => {
  assert.throws(() => parseConfig(edit((c) => delete c.endpoints[0].pair)), /needs a text "pair"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].pending = "yes"))), /"pending" to be true or false/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[3].name = c.endpoints[0].name))), /twice, under pairs sepolia-pls943 and eth-pls/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[3].id = c.endpoints[0].id))), /"id" that is not text or is used twice, under pairs sepolia-pls943 and eth-pls/);
  // Inside one pair the older message stays.
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].name = c.endpoints[0].name))), /names the endpoint "zk-bridge-prover-gpu" twice$/);
});

test("without --pair the pending mainnet tiers are skipped and said so; the live account plan is the same as before", async () => {
  const plan = planChanges(config(), { endpoints: LIVE, templates: [] });
  assert.deepEqual(plan.endpoints.map(({ tier }) => tier.label), ["gpu-24gb", "gpu-32gb", "gpu-48gb"]);
  assert.deepEqual(plan.skipped.map((tier) => tier.label), ["gpu-24gb-eth-pls", "gpu-32gb-eth-pls", "gpu-48gb-eth-pls"]);
  assert.match(describePlan(plan).join("\n"), /gpu-24gb-eth-pls \(eth-pls, zk-bridge-prover-gpu-eth-pls\): not created yet, skipped; run with --pair eth-pls/);
  const { client, writes } = fakeClient();
  assert.equal(await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, client, out() {} }), 0);
  assert.equal(writes().some((call) => call.method === "POST"), false, "no create without --pair eth-pls");
});

test("--pair eth-pls plans only that pair, creates its pending tiers, and leaves the testnet endpoints alone (not even listed as unmanaged)", async () => {
  const plan = planChanges(config(), { endpoints: LIVE, templates: [] }, { pair: "eth-pls" });
  assert.deepEqual(plan.endpoints.map(({ tier }) => tier.label), ["gpu-24gb-eth-pls", "gpu-32gb-eth-pls", "gpu-48gb-eth-pls"]);
  assert.ok(plan.endpoints.every((entry) => !entry.exists));
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.unmanaged, []);
  const { client, writes } = fakeClient();
  assert.equal(await run({ argv: ["--apply", "--pair", "eth-pls"], env: { RUNPOD_API_KEY: "k" }, client, out() {} }), 0);
  assert.deepEqual(writes().map((call) => call.method), ["POST", "POST", "POST"]);
  assert.deepEqual(writes().map((call) => call.body.name), ["zk-bridge-prover-gpu-eth-pls", "zk-bridge-prover-gpu-32gb-eth-pls", "zk-bridge-prover-gpu-48gb-eth-pls"]);
});

test("--pair sepolia-pls943 applies the live tiers only, and a pair that has no endpoint is refused", async () => {
  const plan = planChanges(config(), { endpoints: LIVE, templates: [] }, { pair: "sepolia-pls943" });
  assert.deepEqual(plan.endpoints.map(({ tier }) => tier.label), ["gpu-24gb", "gpu-32gb", "gpu-48gb"]);
  assert.throws(() => planChanges(config(), { endpoints: LIVE, templates: [] }, { pair: "nope" }), /no endpoint of pair nope/);
  const errors = [];
  const { client } = fakeClient();
  assert.equal(await run({ argv: ["--pair", "nope"], env: { RUNPOD_API_KEY: "k" }, client, out() {}, err: (line) => errors.push(line) }), 1);
  assert.match(errors[0], /no endpoint of pair nope/);
});
