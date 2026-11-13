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
  TEMPLATES_QUERY,
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
/**
 * The file as it was before the 32 GB and 48 GB tiers existed: the tests build on that state (two tiers to create), so
 * the ids that the first apply wrote back into the file are taken out again here.
 */
const beforeTiersText = () => {
  const parsed = JSON.parse(fileText);
  for (const tier of parsed.endpoints.slice(1)) {
    delete tier.id;
    delete tier.template.id;
  }
  return JSON.stringify(parsed);
};
const config = () => parseConfig(beforeTiersText());
/** The wanted template of the first tier: the shared settings with its name and id. */
const wantedTemplate = () => ({ ...config().template, name: "zk-bridge-prover-gpu-template", id: "hsj330cqpf" });

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
  assert.equal("id" in template || "name" in template, false, "the shared settings name no template");
  assert.deepEqual(endpoints.map((tier) => tier.template), [{ id: "hsj330cqpf", name: "zk-bridge-prover-gpu-template" }, { name: "zk-bridge-prover-gpu-32gb-template" }, { name: "zk-bridge-prover-gpu-48gb-template" }]);
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
  assert.throws(() => parseConfig(edit((c) => (c.template.id = "x"))), /"id" belongs in the template of each endpoint/);
  assert.throws(() => parseConfig(edit((c) => (c.template.name = "x"))), /"name" belongs in the template of each endpoint/);
  assert.throws(() => parseConfig(edit((c) => delete c.endpoints[1].template)), /needs a "template"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].template = { name: "" }))), /needs a "template"/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].template.id = 5))), /template "id" that is not text/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].template.name = c.endpoints[0].template.name))), /one template to two endpoints/);
  assert.throws(() => parseConfig(edit((c) => (c.endpoints[1].template.id = "hsj330cqpf"))), /one template to two endpoints/);
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
  const same = diffTemplate(wantedTemplate(), liveTemplate());
  assert.deepEqual(same, { exists: true, changes: [] });
  const changed = diffTemplate(wantedTemplate(), liveTemplate({ imageName: "ghcr.io/x@sha256:old", containerDiskInGb: 20, env: [{ key: "PORT", value: "9999" }, { key: "EXTRA", value: "hunter2" }] }));
  assert.deepEqual(changed.changes.map((change) => change.field), ["imageName", "containerDiskInGb", "env.EXTRA", "env.PORT", "env.PORT_HEALTH"]);
  assert.deepEqual(changed.changes[0], { field: "imageName", from: "ghcr.io/x@sha256:old", to: config().template.imageName });
  assert.deepEqual(changed.changes.slice(2), [
    { field: "env.EXTRA", from: "(set)", to: "(removed)" },
    { field: "env.PORT", from: "(set)", to: "(set)" },
    { field: "env.PORT_HEALTH", from: undefined, to: "(set)" },
  ]);
  assert.doesNotMatch(JSON.stringify(changed), /hunter2|9999/);
  assert.equal(diffTemplate(wantedTemplate(), null).exists, false);
});

test("diffEndpoint compares GPU ids as an ordered list, and warns about a template that RunPod would not change", () => {
  const [tier] = config().endpoints;
  assert.deepEqual(diffEndpoint(tier, liveEndpoint(), "hsj330cqpf"), { exists: true, changes: [], warnings: [] });
  const reordered = diffEndpoint(tier, liveEndpoint({ gpuIds: "AMPERE_24,ADA_24,-NVIDIA RTX A5000", idleTimeout: 60, templateId: "other" }), "hsj330cqpf");
  assert.deepEqual(reordered.changes.map((change) => change.field), ["gpuIds", "idleTimeout"]);
  assert.deepEqual(reordered.changes[0].from, ["AMPERE_24", "ADA_24", "-NVIDIA RTX A5000"]);
  assert.equal(reordered.warnings.length, 1);
  assert.match(reordered.warnings[0], /is bound to template other, not hsj330cqpf/);
  assert.deepEqual(diffEndpoint(tier, null, "hsj330cqpf"), { exists: false, changes: diffEndpoint(tier, null, "hsj330cqpf").changes, warnings: [] });
});

test("saveEndpointQuery writes scalerType and type as text and flashBootType as a bare enum value; no id creates", () => {
  const [first, second] = config().endpoints;
  const update = saveEndpointQuery(first, { id: first.id, templateId: "hsj330cqpf" });
  assert.match(update, /scalerType: "REQUEST_COUNT"/);
  assert.match(update, /flashBootType: FLASHBOOT[,\s]/);
  assert.doesNotMatch(update, /"FLASHBOOT"/);
  assert.match(update, /type: "LB",/);
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
  const { input } = saveTemplateVariables(wantedTemplate(), liveTemplate());
  assert.equal(input.id, "hsj330cqpf");
  assert.equal(input.isServerless, true);
  assert.deepEqual(input.env, [{ key: "PORT", value: "8000" }, { key: "PORT_HEALTH", value: "8000" }]);
  assert.equal(input.dockerArgs, "--flag");
  assert.equal(input.readme, "notes");
  const fresh = saveTemplateVariables({ ...wantedTemplate(), id: undefined, env: undefined }, null).input;
  assert.deepEqual([fresh.dockerArgs, fresh.readme, fresh.env, "id" in fresh], ["", "", [], false]);
});

/** What readLive returns: the endpoints, and the templates that no endpoint shows (the account's own list). */
const account = (endpoints, templates = []) => ({ endpoints, templates });
/** The live state of the three tiers, as the file declares them (each tier bound to its own template). */
const settled = () => [
  liveEndpoint(),
  liveEndpoint({ id: "id-32", name: "zk-bridge-prover-gpu-32gb", gpuIds: "ADA_32_PRO", templateId: "tpl-32", template: liveTemplate({ id: "tpl-32", name: "zk-bridge-prover-gpu-32gb-template" }) }),
  liveEndpoint({ id: "id-48", name: "zk-bridge-prover-gpu-48gb", gpuIds: "ADA_48_PRO,-NVIDIA L40", templateId: "tpl-48", template: liveTemplate({ id: "tpl-48", name: "zk-bridge-prover-gpu-48gb-template" }) }),
];

test("planChanges: each tier has its own template and endpoint; retired and unknown endpoints are told apart", () => {
  const live = [liveEndpoint({ workersMax: 2 }), liveEndpoint({ id: "zmp5owbxu73fc2", name: "v9-test", templateId: "v9tpl", template: liveTemplate({ id: "v9tpl", name: "v9" }) }), liveEndpoint({ id: "stranger", name: "someone-elses", templateId: "s", template: liveTemplate({ id: "s", name: "s" }) })];
  const plan = planChanges(config(), account(live));
  const [first, second, third] = plan.endpoints;
  assert.deepEqual([first.template.exists, first.template.changes, first.exists, first.changes.map((change) => change.field)], [true, [], true, ["workersMax"]]);
  assert.equal(first.template.wanted.id, "hsj330cqpf");
  assert.equal(first.template.wanted.name, "zk-bridge-prover-gpu-template");
  assert.equal(first.template.wanted.imageName, config().template.imageName);
  assert.deepEqual([second.template.exists, second.exists, second.template.wanted.id], [false, false, undefined]);
  assert.deepEqual([third.template.exists, third.exists], [false, false]);
  assert.equal(plan.retired[0].live.name, "v9-test");
  assert.deepEqual(plan.unmanaged, [{ id: "stranger", name: "someone-elses" }]);
});

test("a tier's template is found by its id, by its endpoint, or by its name (a template that an earlier run made before the endpoint failed)", () => {
  const tier = { ...config().endpoints[1] };
  const orphan = liveTemplate({ id: "orphan", name: "zk-bridge-prover-gpu-32gb-template", imageName: "ghcr.io/x@sha256:old" });
  const byName = planChanges(config(), account([], [orphan])).endpoints[1];
  assert.equal(byName.template.exists, true);
  assert.equal(byName.template.wanted.id, "orphan", "reused, not duplicated");
  assert.deepEqual(byName.template.changes.map((change) => change.field), ["imageName"]);
  // The endpoint of the tier exists (found by name) and is bound to a template: that one counts, whatever it is called.
  const bound = liveEndpoint({ id: "id-32", name: tier.name, templateId: "tpl-32", template: liveTemplate({ id: "tpl-32", name: "renamed" }) });
  const byEndpoint = planChanges(config(), account([bound], [orphan])).endpoints[1];
  assert.equal(byEndpoint.template.wanted.id, "tpl-32");
  assert.deepEqual(byEndpoint.template.changes.map((change) => change.field), ["name"]);
  // The endpoint shows no template object: it is read from the account's list by the endpoint's template id.
  const bare = liveEndpoint({ id: "id-32", name: tier.name, templateId: "listed", template: null });
  const byListed = planChanges(config(), account([bare], [liveTemplate({ id: "listed", name: "zk-bridge-prover-gpu-32gb-template" })])).endpoints[1];
  assert.deepEqual([byListed.template.wanted.id, byListed.template.exists], ["listed", true]);
  // A template named by id in the file, shown only in the account's list.
  const named = parseConfig(JSON.stringify({ ...JSON.parse(beforeTiersText()), endpoints: JSON.parse(beforeTiersText()).endpoints.map((entry) => (entry.label === "gpu-32gb" ? { ...entry, template: { id: "pinned", name: "zk-bridge-prover-gpu-32gb-template" } } : entry)) }));
  assert.equal(planChanges(named, account([], [liveTemplate({ id: "pinned", name: "other name" })])).endpoints[1].template.changes[0].field, "name");
  // A tier without an id is matched by name.
  const byTierName = planChanges(config(), account([liveEndpoint({ id: "new32", name: "zk-bridge-prover-gpu-32gb", gpuIds: "ADA_32_PRO", templateId: "tpl-32", template: liveTemplate({ id: "tpl-32" }) })]));
  assert.equal(byTierName.endpoints[1].exists, true);
  assert.equal(byTierName.endpoints[1].live.id, "new32");
  assert.deepEqual(byTierName.unmanaged, []);
});

test("describePlan prints a template line and an endpoint line per tier, old and new values, never an environment value", () => {
  const live = [
    liveEndpoint({ idleTimeout: 60, template: liveTemplate({ env: [{ key: "PORT", value: "s3cret" }] }) }),
    liveEndpoint({ id: "zmp5owbxu73fc2", name: "v9", templateId: "v9tpl", template: liveTemplate({ id: "v9tpl", name: "v9" }) }),
    liveEndpoint({ id: "stranger", name: "other", templateId: "s", template: liveTemplate({ id: "s", name: "s" }) }),
  ];
  const text = describePlan(planChanges(config(), account(live))).join("\n");
  assert.match(text, /template of gpu-24gb \(zk-bridge-prover-gpu-template, hsj330cqpf\): changes/);
  assert.match(text, /env\.PORT: \(set\) -> \(set\)/);
  assert.match(text, /env\.PORT_HEALTH: \(none\) -> \(set\)/);
  assert.doesNotMatch(text, /s3cret/);
  assert.match(text, /endpoint gpu-24gb \(zk-bridge-prover-gpu, 43nsvfb8svkosr\): changes/);
  assert.match(text, /idleTimeout: 60 -> 5/);
  assert.match(text, /template of gpu-32gb \(zk-bridge-prover-gpu-32gb-template\): does not exist, will be created/);
  assert.match(text, /endpoint gpu-32gb \(zk-bridge-prover-gpu-32gb\): does not exist, will be created/);
  assert.match(text, /retired zmp5owbxu73fc2 \(v9\): still exists; deleted only with --apply --delete-retired; its template v9tpl stays in place/);
  assert.match(text, /not in the file, left alone: stranger \(other\)/);
  const quiet = describePlan(planChanges(config(), account(settled()))).join("\n");
  assert.equal((quiet.match(/: no change/g) ?? []).length, 6);
  assert.match(quiet, /retired zmp5owbxu73fc2: already gone/);
  const moved = describePlan(planChanges(config(), account([liveEndpoint({ templateId: "elsewhere" })]))).join("\n");
  assert.match(moved, /warning: is bound to template elsewhere/);
});

/** A stub of the HTTP call that records every request and answers by its text. */
function stub(endpoints, { templates = [], failOn } = {}) {
  const calls = [];
  const post = async (query, variables) => {
    calls.push({ query, variables });
    if (failOn !== undefined && query.includes(failOn)) throw new ApplyError("RunPod refused the request: nope");
    if (query === ENDPOINTS_QUERY) return { myself: { endpoints } };
    if (query === TEMPLATES_QUERY) return { myself: { podTemplates: templates } };
    if (query === SAVE_TEMPLATE_QUERY) return { saveTemplate: { id: `made-${variables.input.name}` } };
    if (query.includes("saveEndpoint")) return { saveEndpoint: { id: "created-id" } };
    return {};
  };
  return { calls, post };
}

const quietly = { env: { RUNPOD_API_KEY: "k" }, readFile: () => beforeTiersText(), out: () => {} };

test("a dry run reads the endpoints and the templates, prints the differences and sends no mutation", async () => {
  const { calls, post } = stub([liveEndpoint({ idleTimeout: 60 })]);
  const lines = [];
  const code = await run({ ...quietly, argv: [], post, out: (line) => lines.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.query), [ENDPOINTS_QUERY, TEMPLATES_QUERY]);
  assert.match(lines.join("\n"), /dry run: nothing changed/);
});

test("--apply: each tier saves its own template (update by id, create without one and read the new id), then its endpoint bound to it", async () => {
  const live = [liveEndpoint({ idleTimeout: 60, template: liveTemplate({ imageName: "ghcr.io/x@sha256:old" }) })];
  const { calls, post } = stub(live);
  const lines = [];
  assert.equal(await run({ ...quietly, argv: ["--apply"], post, out: (line) => lines.push(line) }), 0);
  const mutations = calls.slice(2);
  assert.equal(mutations.length, 6);
  assert.equal(mutations[0].query, SAVE_TEMPLATE_QUERY);
  assert.equal(mutations[0].variables.input.id, "hsj330cqpf");
  assert.equal(mutations[0].variables.input.imageName, config().template.imageName);
  assert.match(mutations[1].query, /id: "43nsvfb8svkosr"/);
  assert.match(mutations[1].query, /templateId: "hsj330cqpf"/);
  assert.equal(mutations[2].query, SAVE_TEMPLATE_QUERY);
  assert.equal("id" in mutations[2].variables.input, false, "a new template is created without an id");
  assert.equal(mutations[2].variables.input.name, "zk-bridge-prover-gpu-32gb-template");
  assert.equal(mutations[2].variables.input.isServerless, true);
  assert.match(mutations[3].query, /name: "zk-bridge-prover-gpu-32gb"/);
  assert.match(mutations[3].query, /templateId: "made-zk-bridge-prover-gpu-32gb-template"/);
  assert.match(mutations[5].query, /templateId: "made-zk-bridge-prover-gpu-48gb-template"/);
  const text = lines.join("\n");
  assert.match(text, /saved template of gpu-24gb \(hsj330cqpf\)/);
  assert.match(text, /created template of gpu-32gb \(made-zk-bridge-prover-gpu-32gb-template\)/);
  assert.match(text, /saved endpoint gpu-24gb \(43nsvfb8svkosr\)/);
  assert.match(text, /created endpoint gpu-32gb \(created-id\)/);
});

test("--apply reuses a template left by an earlier failed run instead of creating another, and saves an endpoint only when it differs", async () => {
  const orphan = liveTemplate({ id: "orphan", name: "zk-bridge-prover-gpu-32gb-template" });
  const live = settled().filter((endpoint) => endpoint.id !== "id-32");
  const { calls, post } = stub(live, { templates: [orphan] });
  assert.equal(await run({ ...quietly, argv: ["--apply"], post }), 0);
  const mutations = calls.slice(2);
  assert.equal(mutations.length, 1, "the template matches; only the endpoint is created");
  assert.match(mutations[0].query, /templateId: "orphan"/);
  assert.equal(mutations[0].query.includes("saveEndpoint"), true);
  // A template that differs on an endpoint that matches saves the template only.
  const stale = settled();
  stale[1].template = liveTemplate({ id: "tpl-32", name: "zk-bridge-prover-gpu-32gb-template", containerDiskInGb: 20 });
  const second = stub(stale);
  await run({ ...quietly, argv: ["--apply"], post: second.post });
  assert.deepEqual(second.calls.slice(2).map((call) => call.query), [SAVE_TEMPLATE_QUERY]);
  assert.equal(second.calls[2].variables.input.id, "tpl-32");
});

test("retired endpoints are kept without --delete-retired, and deleted with it (scaled to zero first when they may run workers); their templates stay", async () => {
  const live = [...settled(), liveEndpoint({ id: "zmp5owbxu73fc2", name: "v9-test", templateId: "v9tpl", template: liveTemplate({ id: "v9tpl", name: "v9" }) }), liveEndpoint({ id: "idle-retired", name: "idle", workersMax: 0, templateId: "idletpl", template: liveTemplate({ id: "idletpl", name: "idle" }) })];
  const keep = stub(live);
  await run({ ...quietly, argv: ["--apply"], post: keep.post });
  assert.equal(keep.calls.some((call) => call.query === DELETE_ENDPOINT_QUERY), false);

  const drop = stub(live);
  const retiredConfig = JSON.stringify({ ...JSON.parse(beforeTiersText()), retired: ["zmp5owbxu73fc2", "idle-retired", "gone-already"] });
  const lines = [];
  await run({ ...quietly, argv: ["--apply", "--delete-retired"], post: drop.post, readFile: () => retiredConfig, out: (line) => lines.push(line) });
  const queries = drop.calls.map((call) => call.query);
  const scaleDown = queries.findIndex((query) => query.includes('id: "zmp5owbxu73fc2"') && query.includes("workersMax: 0"));
  assert.ok(scaleDown > 0 && scaleDown < queries.indexOf(DELETE_ENDPOINT_QUERY), "scaled to zero before the delete");
  assert.deepEqual(drop.calls.filter((call) => call.query === DELETE_ENDPOINT_QUERY).map((call) => call.variables), [{ id: "zmp5owbxu73fc2" }, { id: "idle-retired" }]);
  assert.equal(queries.filter((query) => query.includes('id: "idle-retired"')).length, 0, "an endpoint with no workers is not scaled");
  assert.equal(drop.calls.some((call) => call.query === SAVE_TEMPLATE_QUERY), false, "no template is touched");
  assert.match(lines.join("\n"), /deleted retired endpoint zmp5owbxu73fc2; left its template v9tpl in place/);
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
  const base = { env: { RUNPOD_API_KEY: "k" }, post, out: () => {}, readStdin: () => (read.stdin += 1, beforeTiersText()), readFile: (path) => (read.paths.push(path), beforeTiersText()) };
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
  const code = await run({ argv: ["--apply"], env: { RUNPOD_API_KEY: key }, post, readFile: () => beforeTiersText(), out: () => {}, err: (line) => errors.push(line) });
  assert.equal(code, 1);
  assert.deepEqual(errors, ["RunPod refused the request: nope"]);
  const unexpected = [];
  assert.equal(await run({ argv: [], env: { RUNPOD_API_KEY: key }, post: async () => { throw Object.assign(new Error(`boom ${key}`), { code: "EBOOM" }); }, readFile: () => beforeTiersText(), err: (line) => unexpected.push(line) }), 1);
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
    const { post: empty } = { post: async () => ({}) };
  assert.deepEqual(planChanges(config(), account([])).unmanaged, []);
  assert.equal((await run({ argv: [], env: { RUNPOD_API_KEY: "k" }, post: empty, readFile: () => fileText, out: () => {} })), 0);
});


test("a run with every template and endpoint settled saves nothing", async () => {
  const { calls, post } = stub(settled());
  assert.equal(await run({ ...quietly, argv: ["--apply"], post }), 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(await applyPlan({ endpoints: [], retired: [] }, post, { deleteRetired: true }), []);
});
