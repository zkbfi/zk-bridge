// Tests of apply.mjs. No call reaches RunPod: the HTTP call is a stub. Run: node --test deploy/runpod
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ApplyError,
  DELETE_ENDPOINT_QUERY,
  ENDPOINTS_QUERY,
  GRAPHQL_URL,
  SAVE_TEMPLATE_QUERY,
  applyPlan,
  describePlan,
  diffEndpoint,
  diffTemplate,
  gpuIdsOf,
  makeGraphqlPost,
  parseArguments,
  parseConfig,
  planChanges,
  run,
  saveEndpointQuery,
  saveTemplateVariables,
} from "./apply.mjs";

const fileText = readFileSync(new URL("./endpoints.json", import.meta.url), "utf8");
const config = () => parseConfig(fileText);

/** What RunPod returns for the file's own state (the live account of 2026-11-13, before the new tiers). */
const liveTemplate = (over = {}) => ({
  id: "hsj330cqpf",
  name: "zk-bridge-prover-gpu-template",
  imageName: config().template.imageName,
  isServerless: true,
  containerDiskInGb: 40,
  volumeInGb: 0,
  volumeMountPath: "/workspace",
  dockerArgs: "--flag",
  ports: "8000/http",
  startJupyter: false,
  startSsh: true,
  readme: "notes",
  containerRegistryAuthId: "cmvts6161003dsycaos24r5wg",
  env: [
    { key: "PORT", value: "8000" },
    { key: "PORT_HEALTH", value: "8000" },
  ],
  ...over,
});
const liveEndpoint = (over = {}) => ({
  id: "43nsvfb8svkosr",
  name: "zk-bridge-prover-gpu",
  gpuIds: "ADA_24,AMPERE_24,-NVIDIA RTX A5000",
  gpuCount: 1,
  idleTimeout: 5,
  locations: null,
  networkVolumeId: null,
  scalerType: "REQUEST_COUNT",
  scalerValue: 1,
  templateId: "hsj330cqpf",
  type: "LB",
  workersMin: 0,
  workersMax: 1,
  flashBootType: "FLASHBOOT",
  executionTimeoutMs: 600000,
  template: liveTemplate(),
  ...over,
});

test("the file in the repository is valid and holds the three tiers in order, one retired endpoint and no secret", () => {
  const { template, endpoints, retired } = config();
  assert.deepEqual(endpoints.map((tier) => tier.label), ["gpu-24gb", "gpu-32gb", "gpu-48gb"]);
  assert.deepEqual(endpoints[0].gpuIds, ["ADA_24", "AMPERE_24", "-NVIDIA RTX A5000"]);
  assert.equal(endpoints[0].id, "43nsvfb8svkosr");
  assert.equal(endpoints[1].id, undefined);
  assert.deepEqual(retired, ["zmp5owbxu73fc2"]);
  assert.match(template.imageName, /@sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(fileText, /rpa_|api[_-]?key|secret|token/i);
});

test("parseConfig refuses a file that is not JSON or has the wrong shape", () => {
  const edit = (change) => {
    const copy = JSON.parse(fileText);
    change(copy);
    return JSON.stringify(copy);
  };
  assert.throws(() => parseConfig("{"), /not valid JSON/);
  assert.throws(() => parseConfig("[]"), /must be an object/);
  assert.throws(() => parseConfig(edit((c) => delete c.template)), /"template"/);
  assert.throws(() => parseConfig(edit((c) => (c.template.imageName = ""))), /"imageName"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints = []))), /"endpoints"/);
  assert.throws(() => parseConfig(edit((c) => (c.retired = [1]))), /"retired"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0] = 5))), /not an object/);
  assert.throws(() => parseConfig(edit((c) => delete c.endpoints[0].name)), /"name"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].gpuIds = []))), /"gpuIds"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[0].idleTimeout = "5"))), /"idleTimeout"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].name = c.endpoints[0].name))), /twice/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].id = c.endpoints[0].id))), /used twice/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].id = 7))), /not text/);
  assert.throws(() => parseConfig(edit((c) => (c.retired = [c.endpoints[0].id]))), /both as an endpoint and as retired/);
  assert.deepEqual(parseConfig(edit((c) => delete c.retired)).retired, []);
});

test("gpuIdsOf reads RunPod's comma separated text, a list, or nothing", () => {
  assert.deepEqual(gpuIdsOf("ADA_24, AMPERE_24,-NVIDIA RTX A5000"), ["ADA_24", "AMPERE_24", "-NVIDIA RTX A5000"]);
  assert.deepEqual(gpuIdsOf(["A"]), ["A"]);
  assert.deepEqual(gpuIdsOf(null), []);
});

test("diffTemplate lists the fields that differ with old and new values, and masks every environment value", () => {
  const same = diffTemplate(config().template, liveTemplate());
  assert.deepEqual(same, { exists: true, changes: [] });
  const changed = diffTemplate(config().template, liveTemplate({ imageName: "ghcr.io/x@sha256:old", containerDiskInGb: 20, env: [{ key: "PORT", value: "9999" }, { key: "EXTRA", value: "hunter2" }] }));
  assert.deepEqual(changed.changes.map((change) => change.field), ["imageName", "containerDiskInGb", "env.EXTRA", "env.PORT", "env.PORT_HEALTH"]);
  assert.deepEqual(changed.changes[0], { field: "imageName", from: "ghcr.io/x@sha256:old", to: config().template.imageName });
  assert.deepEqual(changed.changes.slice(2), [
    { field: "env.EXTRA", from: "(set)", to: "(removed)" },
    { field: "env.PORT", from: "(set)", to: "(set)" },
    { field: "env.PORT_HEALTH", from: undefined, to: "(set)" },
  ]);
  assert.doesNotMatch(JSON.stringify(changed), /hunter2|9999/);
  assert.equal(diffTemplate(config().template, null).exists, false);
});

test("diffEndpoint compares GPU ids as an ordered list, and warns about a template that RunPod would not change", () => {
  const [tier] = config().endpoints;
  assert.deepEqual(diffEndpoint(tier, liveEndpoint(), "hsj330cqpf"), { exists: true, changes: [], warnings: [] });
  const reordered = diffEndpoint(tier, liveEndpoint({ gpuIds: "AMPERE_24,ADA_24,-NVIDIA RTX A5000", idleTimeout: 60, templateId: "other" }), "hsj330cqpf");
  assert.deepEqual(reordered.changes.map((change) => change.field), ["gpuIds", "idleTimeout"]);
  assert.deepEqual(reordered.changes[0].from, ["AMPERE_24", "ADA_24", "-NVIDIA RTX A5000"]);
  assert.equal(reordered.warnings.length, 1);
  assert.match(reordered.warnings[0], /uses template other, not hsj330cqpf/);
  assert.deepEqual(diffEndpoint(tier, null, "hsj330cqpf"), { exists: false, changes: diffEndpoint(tier, null, "hsj330cqpf").changes, warnings: [] });
});

test("saveEndpointQuery writes scalerType as text and flashBootType and type as bare enum values; no id creates", () => {
  const [first, second] = config().endpoints;
  const update = saveEndpointQuery(first, { id: first.id, templateId: "hsj330cqpf" });
  assert.match(update, /scalerType: "REQUEST_COUNT"/);
  assert.match(update, /flashBootType: FLASHBOOT[,\s]/);
  assert.doesNotMatch(update, /"FLASHBOOT"/);
  assert.match(update, /type: LB,/);
  assert.match(update, /id: "43nsvfb8svkosr"/);
  assert.match(update, /gpuIds: "ADA_24,AMPERE_24,-NVIDIA RTX A5000"/);
  assert.match(update, /gpuCount: 1/);
  assert.match(update, /workersMin: 0, workersMax: 1, idleTimeout: 5/);
  const create = saveEndpointQuery(second, { id: undefined, templateId: "hsj330cqpf" });
  assert.doesNotMatch(create, /\bid: "/);
  assert.match(create, /name: "zk-bridge-prover-gpu-32gb"/);
  assert.match(create, /templateId: "hsj330cqpf"/);
});

test("saveTemplateVariables sends the file's fields, the environment as key and value pairs, and keeps the live docker arguments and readme", () => {
  const { input } = saveTemplateVariables(config().template, liveTemplate());
  assert.equal(input.id, "hsj330cqpf");
  assert.equal(input.isServerless, true);
  assert.deepEqual(input.env, [{ key: "PORT", value: "8000" }, { key: "PORT_HEALTH", value: "8000" }]);
  assert.equal(input.dockerArgs, "--flag");
  assert.equal(input.readme, "notes");
  const fresh = saveTemplateVariables({ ...config().template, env: undefined }, null).input;
  assert.deepEqual([fresh.dockerArgs, fresh.readme, fresh.env], ["", "", []]);
});

test("planChanges: an existing endpoint updates, a missing tier is created, retired and unknown endpoints are told apart", () => {
  const live = [
    liveEndpoint({ workersMax: 2 }),
    liveEndpoint({ id: "zmp5owbxu73fc2", name: "v9-test" }),
    liveEndpoint({ id: "stranger", name: "someone-elses" }),
  ];
  const plan = planChanges(config(), live);
  assert.equal(plan.template.exists, true);
  assert.deepEqual(plan.template.changes, []);
  assert.deepEqual(plan.endpoints.map((entry) => [entry.tier.label, entry.exists, entry.changes.map((change) => change.field)]), [
    ["gpu-24gb", true, ["workersMax"]],
    ["gpu-32gb", false, plan.endpoints[1].changes.map((change) => change.field)],
    ["gpu-48gb", false, plan.endpoints[2].changes.map((change) => change.field)],
  ]);
  assert.equal(plan.retired[0].live.name, "v9-test");
  assert.deepEqual(plan.unmanaged, [{ id: "stranger", name: "someone-elses" }]);
  // A tier without an id is matched by name.
  const byName = planChanges(config(), [liveEndpoint({ id: "new32", name: "zk-bridge-prover-gpu-32gb", gpuIds: "ADA_32_PRO" })]);
  assert.equal(byName.endpoints[1].exists, true);
  assert.equal(byName.endpoints[1].live.id, "new32");
  assert.deepEqual(byName.unmanaged, []);
});

test("describePlan prints old and new values, never an environment value, and tells what is left alone", () => {
  const live = [liveEndpoint({ idleTimeout: 60, template: liveTemplate({ env: [{ key: "PORT", value: "s3cret" }] }), templateId: "hsj330cqpf" }), liveEndpoint({ id: "zmp5owbxu73fc2", name: "v9" }), liveEndpoint({ id: "stranger", name: "other" })];
  const text = describePlan(planChanges(config(), live)).join("\n");
  assert.match(text, /template hsj330cqpf \(zk-bridge-prover-gpu-template\): changes/);
  assert.match(text, /env\.PORT: \(set\) -> \(set\)/);
  assert.match(text, /env\.PORT_HEALTH: \(none\) -> \(set\)/);
  assert.doesNotMatch(text, /s3cret/);
  assert.match(text, /idleTimeout: 60 -> 5/);
  assert.match(text, /endpoint gpu-32gb \(zk-bridge-prover-gpu-32gb\): does not exist, will be created/);
  assert.match(text, /retired zmp5owbxu73fc2 \(v9\): still exists; deleted only with --apply --delete-retired/);
  assert.match(text, /not in the file, left alone: stranger \(other\)/);
  const quiet = describePlan(planChanges(config(), [liveEndpoint({ template: liveTemplate() })])).join("\n");
  assert.match(quiet, /template hsj330cqpf .*: no change/);
  assert.match(quiet, /endpoint gpu-24gb .*: no change/);
  assert.match(quiet, /retired zmp5owbxu73fc2: already gone/);
  const none = describePlan(planChanges(config(), [])).join("\n");
  assert.match(none, /not visible at RunPod, will be saved/);
  const moved = describePlan(planChanges(config(), [liveEndpoint({ templateId: "elsewhere" })])).join("\n");
  assert.match(moved, /warning: uses template elsewhere/);
});

/** A stub of the HTTP call that records every request and answers by the first word of the query. */
function stub(live, { failOn } = {}) {
  const calls = [];
  const post = async (query, variables) => {
    calls.push({ query, variables });
    if (failOn !== undefined && query.includes(failOn)) throw new ApplyError("RunPod refused the request: nope");
    if (query === ENDPOINTS_QUERY) return { myself: { endpoints: live } };
    if (query.includes("saveEndpoint")) return { saveEndpoint: { id: "created-id" } };
    return {};
  };
  return { calls, post };
}

test("a dry run reads RunPod, prints the differences and sends no mutation", async () => {
  const { calls, post } = stub([liveEndpoint({ idleTimeout: 60 })]);
  const lines = [];
  const code = await run({ argv: [], env: { RUNPOD_API_KEY: "k" }, post, readFile: () => fileText, out: (line) => lines.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.query), [ENDPOINTS_QUERY]);
  assert.match(lines.join("\n"), /dry run: nothing changed/);
});

test("--apply saves the template when it differs, updates the endpoint that differs, creates the missing tiers and leaves a matching endpoint alone", async () => {
  const live = [liveEndpoint({ idleTimeout: 60, template: liveTemplate({ imageName: "ghcr.io/x@sha256:old" }) })];
  const { calls, post } = stub(live);
  const lines = [];
  const code = await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, post, readFile: () => fileText, out: (line) => lines.push(line) });
  assert.equal(code, 0);
  const mutations = calls.slice(1);
  assert.equal(mutations.length, 4);
  assert.equal(mutations[0].query, SAVE_TEMPLATE_QUERY);
  assert.equal(mutations[0].variables.input.imageName, config().template.imageName);
  assert.match(mutations[1].query, /id: "43nsvfb8svkosr"/);
  assert.match(mutations[2].query, /name: "zk-bridge-prover-gpu-32gb"/);
  assert.doesNotMatch(mutations[2].query, /\bid: "/);
  assert.match(mutations[3].query, /name: "zk-bridge-prover-gpu-48gb"/);
  assert.match(lines.join("\n"), /saved template hsj330cqpf/);
  assert.match(lines.join("\n"), /saved endpoint gpu-24gb \(43nsvfb8svkosr\)/);
  assert.match(lines.join("\n"), /created endpoint gpu-32gb \(created-id\)/);
  const second = stub([liveEndpoint()]);
  await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, post: second.post, readFile: () => fileText, out: () => {} });
  assert.equal(second.calls.length, 3, "the read, and the two missing tiers");
});

test("retired endpoints are kept without --delete-retired, and deleted with it (scaled to zero first when they may run workers)", async () => {
  const live = [liveEndpoint(), liveEndpoint({ id: "zmp5owbxu73fc2", name: "v9-test" }), liveEndpoint({ id: "idle-retired", name: "idle", workersMax: 0 })];
  const keep = stub(live);
  await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, post: keep.post, readFile: () => fileText, out: () => {} });
  assert.equal(keep.calls.some((call) => call.query === DELETE_ENDPOINT_QUERY), false);

  const drop = stub(live);
  const retiredConfig = JSON.stringify({ ...JSON.parse(fileText), retired: ["zmp5owbxu73fc2", "idle-retired", "gone-already"] });
  const lines = [];
  await run({ argv: ["--apply", "--delete-retired"], env: { RUNPOD_API_KEY: "k" }, post: drop.post, readFile: () => retiredConfig, out: (line) => lines.push(line) });
  const queries = drop.calls.map((call) => call.query);
  const scaleDown = queries.findIndex((query) => query.includes('id: "zmp5owbxu73fc2"') && query.includes("workersMax: 0"));
  const firstDelete = queries.indexOf(DELETE_ENDPOINT_QUERY);
  assert.ok(scaleDown > 0 && scaleDown < firstDelete, "scaled to zero before the delete");
  assert.deepEqual(drop.calls.filter((call) => call.query === DELETE_ENDPOINT_QUERY).map((call) => call.variables), [{ id: "zmp5owbxu73fc2" }, { id: "idle-retired" }]);
  assert.equal(queries.filter((query) => query.includes('id: "idle-retired"')).length, 0, "an endpoint with no workers is not scaled");
  assert.match(lines.join("\n"), /deleted retired endpoint zmp5owbxu73fc2/);
  assert.doesNotMatch(lines.join("\n"), /gone-already.*deleted/);
});

test("the command line: --delete-retired needs --apply, unknown arguments and a missing config path are refused", () => {
  assert.deepEqual(parseArguments([]), { apply: false, deleteRetired: false, config: null });
  assert.deepEqual(parseArguments(["--apply", "--delete-retired", "--config", "-"]), { apply: true, deleteRetired: true, config: "-" });
  assert.throws(() => parseArguments(["--delete-retired"]), /only with --apply/);
  assert.throws(() => parseArguments(["--nope"]), /unknown argument/);
  assert.throws(() => parseArguments(["--config"]), /needs a path/);
});

test("run: the key must be in the environment; the configuration comes from a path, standard input (--config -) or the default file", async () => {
  const errors = [];
  assert.equal(await run({ argv: [], env: {}, post: async () => ({}), err: (line) => errors.push(line) }), 1);
  assert.match(errors[0], /RUNPOD_API_KEY/);
  const { post } = stub([]);
  const read = { stdin: 0, paths: [] };
  const base = { env: { RUNPOD_API_KEY: "k" }, post, out: () => {}, readStdin: () => (read.stdin += 1, fileText), readFile: (path) => (read.paths.push(path), fileText) };
  assert.equal(await run({ ...base, argv: ["--config", "-"] }), 0);
  assert.equal(read.stdin, 1);
  assert.equal(await run({ ...base, argv: ["--config", "/tmp/other.json"] }), 0);
  assert.equal(await run({ ...base, argv: [] }), 0);
  assert.deepEqual(read.paths[0], "/tmp/other.json");
  assert.match(read.paths[1], /deploy\/runpod\/endpoints\.json$/);
});

test("a GraphQL error ends the run with a non-zero code and prints the message, never the key or the request", async () => {
  const errors = [];
  const key = "rpa_SECRETKEYVALUE";
  const { post } = stub([liveEndpoint()], { failOn: "saveEndpoint" });
  const code = await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: key }, post, readFile: () => fileText, out: () => {}, err: (line) => errors.push(line) });
  assert.equal(code, 1);
  assert.deepEqual(errors, ["RunPod refused the request: nope"]);
  const unexpected = [];
  assert.equal(await run({ argv: [], env: { RUNPOD_API_KEY: key }, post: async () => { throw Object.assign(new Error(`boom ${key}`), { code: "EBOOM" }); }, readFile: () => fileText, err: (line) => unexpected.push(line) }), 1);
  assert.deepEqual(unexpected, ["failed: EBOOM"]);
  const plain = [];
  assert.equal(await run({ argv: [], env: { RUNPOD_API_KEY: key }, post: async () => { throw new Error(`boom ${key}`); }, readFile: () => fileText, err: (line) => plain.push(line) }), 1);
  assert.deepEqual(plain, ["failed: unexpected error"]);
});

test("makeGraphqlPost sends the key as a bearer header and the query as JSON, returns data, and reports errors without the key or request", async () => {
  const key = "rpa_SECRETKEYVALUE";
  const seen = [];
  const answer = (body, status = 200) => async (url, init) => (seen.push({ url, init }), { ok: status < 400, status, json: async () => body });
  const post = makeGraphqlPost(key, answer({ data: { ok: 1 } }));
  assert.deepEqual(await post("{ a }"), { ok: 1 });
  assert.equal(seen[0].url, GRAPHQL_URL);
  assert.equal(seen[0].init.headers.authorization, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(seen[0].init.body), { query: "{ a }" });
  await makeGraphqlPost(key, answer({ data: {} }))("mutation { b }", { id: 1 });
  assert.deepEqual(JSON.parse(seen[1].init.body), { query: "mutation { b }", variables: { id: 1 } });

  const refusal = await makeGraphqlPost(key, answer({ errors: [{ message: "bad input" }, {}] }))("{ a }").catch((error) => error);
  assert.ok(refusal instanceof ApplyError);
  assert.equal(refusal.message, "RunPod refused the request: bad input; no message");
  const http = await makeGraphqlPost(key, answer({}, 502))("{ a }").catch((error) => error);
  assert.equal(http.message, "RunPod answered HTTP 502");
  const noJson = await makeGraphqlPost(key, async () => ({ ok: false, status: 500, json: async () => { throw new Error("html"); } }))("{ a }").catch((error) => error);
  assert.equal(noJson.message, "RunPod answered HTTP 500 with no JSON");
  const down = await makeGraphqlPost(key, async () => { throw new Error(`connect ${key}`); })("{ a }").catch((error) => error);
  assert.equal(down.message, "RunPod did not answer");
  assert.equal([refusal, http, noJson, down].some((error) => error.message.includes(key) || error.message.includes("query")), false);
  // An answer without data or an account without endpoints reads as no endpoints.
  assert.equal(await makeGraphqlPost(key, answer({}))("{ a }"), undefined);
  const { calls } = stub([]);
  assert.equal(calls.length, 0);
  const { post: empty } = { post: async () => ({}) };
  assert.deepEqual(planChanges(config(), []).unmanaged, []);
  assert.equal((await run({ argv: [], env: { RUNPOD_API_KEY: "k" }, post: empty, readFile: () => fileText, out: () => {} })), 0);
});

test("applyPlan saves nothing when the template matches and every tier exists unchanged", async () => {
  const live = config().endpoints.map((tier) => ({ ...liveEndpoint({ id: tier.id ?? `id-${tier.label}`, name: tier.name, gpuIds: tier.gpuIds.join(",") }), template: liveTemplate() }));
  const { calls, post } = stub(live);
  const done = await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: "k" }, post, readFile: () => fileText, out: () => {} });
  assert.equal(done, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(await applyPlan({ template: { exists: true, changes: [] }, endpoints: [], retired: [] }, post, { deleteRetired: true }), []);
});
