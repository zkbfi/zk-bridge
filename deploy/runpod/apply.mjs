#!/usr/bin/env node
// Brings RunPod to the state that endpoints.json declares: the shared template settings, one template and one serverless endpoint per tier (RunPod binds a template to one endpoint).
// No dependencies; Node 22. It talks to RunPod's GraphQL API (the REST API has a small daily limit).
//
//   RUNPOD_API_KEY=... node deploy/runpod/apply.mjs                    dry run: prints what would change
//   RUNPOD_API_KEY=... node deploy/runpod/apply.mjs --apply            saves each tier template and endpoint that differs
//   ... --apply --delete-retired                                        also deletes the endpoints listed under "retired"
//   ... --config <file>|-                                               another file, or the JSON on standard input
//
// The key comes from the environment only. It is never printed, and no request is printed. An endpoint that exists at
// RunPod but is neither in the file nor retired is listed and never touched. See docs/gpu-prover.md,
// "RunPod endpoints in configuration".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GRAPHQL_URL = "https://api.runpod.io/graphql";

const TEMPLATE_FIELDS = ["name", "imageName", "containerDiskInGb", "volumeInGb", "volumeMountPath", "ports", "startSsh", "startJupyter", "containerRegistryAuthId"];
const ENDPOINT_FIELDS = ["name", "gpuIds", "workersMin", "workersMax", "idleTimeout", "flashBootType", "scalerType", "scalerValue", "executionTimeoutMs", "type"];

/** The read query: every endpoint of the account with its template. */
export const ENDPOINTS_QUERY =
  "{ myself { endpoints { id name gpuIds gpuCount idleTimeout locations networkVolumeId scalerType scalerValue templateId type workersMin workersMax flashBootType executionTimeoutMs template { id name imageName isServerless containerDiskInGb volumeInGb volumeMountPath dockerArgs ports startJupyter startSsh readme containerRegistryAuthId env { key value } } } } }";

/** The read query of the account's templates: one that an earlier run created for an endpoint that then failed is found here. */
export const TEMPLATES_QUERY =
  "{ myself { podTemplates { id name imageName isServerless containerDiskInGb volumeInGb volumeMountPath dockerArgs ports startJupyter startSsh readme containerRegistryAuthId env { key value } } } }";

export const SAVE_TEMPLATE_QUERY = "mutation SaveTemplate($input: SaveTemplateInput!) { saveTemplate(input: $input) { id name imageName } }";
export const DELETE_ENDPOINT_QUERY = "mutation DeleteEndpoint($id: String!) { deleteEndpoint(id: $id) }";

/** Raised for a problem the operator must read: a bad file, a RunPod error. Its message never holds the key. */
export class ApplyError extends Error {}

const GPU_IDS_SEPARATOR = ",";

/** RunPod keeps the GPU ids as one comma separated text. */
export const gpuIdsOf = (value) => (Array.isArray(value) ? value : String(value ?? "").split(GPU_IDS_SEPARATOR).map((id) => id.trim()).filter((id) => id !== ""));

/** The key and value pairs of `env` as an object. */
const envOf = (list) => Object.fromEntries((list ?? []).map(({ key, value }) => [key, value]));

// ---------------------------------------------------------------------------------------------------------------------
// The file

/** Checks the shape of endpoints.json and returns it. */
export function parseConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new ApplyError("the configuration is not valid JSON");
  }
  const fail = (message) => {
    throw new ApplyError(`the configuration ${message}`);
  };
  const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!object(config)) fail("must be an object");
  const { template, endpoints, retired = [] } = config;
  if (!object(template)) fail('needs a "template" object');
  for (const key of ["imageName", "ports"]) if (typeof template[key] !== "string" || template[key] === "") fail(`template needs a text "${key}"`);
  for (const key of ["id", "name"]) if (template[key] !== undefined) fail(`template holds the settings every tier shares; "${key}" belongs in the template of each endpoint`);
  if (!Array.isArray(endpoints) || endpoints.length === 0) fail('needs a non-empty "endpoints" list');
  if (!Array.isArray(retired) || retired.some((id) => typeof id !== "string")) fail('"retired" must be a list of endpoint ids');
  const names = new Set();
  const ids = new Set();
  const templateNames = new Set();
  const templateIds = new Set();
  for (const endpoint of endpoints) {
    if (!object(endpoint)) fail("has an endpoint that is not an object");
    for (const key of ["label", "name", "flashBootType", "scalerType", "type"]) if (typeof endpoint[key] !== "string" || endpoint[key] === "") fail(`endpoint needs a text "${key}"`);
    if (!Array.isArray(endpoint.gpuIds) || endpoint.gpuIds.length === 0) fail(`endpoint ${endpoint.label} needs a non-empty "gpuIds" list`);
    for (const key of ["workersMin", "workersMax", "idleTimeout", "scalerValue", "executionTimeoutMs"]) if (!Number.isInteger(endpoint[key])) fail(`endpoint ${endpoint.label} needs a whole number "${key}"`);
    if (names.has(endpoint.name)) fail(`names the endpoint "${endpoint.name}" twice`);
    names.add(endpoint.name);
    if (!object(endpoint.template) || typeof endpoint.template.name !== "string" || endpoint.template.name === "") fail(`endpoint ${endpoint.label} needs a "template" with a text "name"`);
    if (endpoint.template.id !== undefined && typeof endpoint.template.id !== "string") fail(`endpoint ${endpoint.label} has a template "id" that is not text`);
    if (templateNames.has(endpoint.template.name) || (endpoint.template.id !== undefined && templateIds.has(endpoint.template.id))) fail(`gives one template to two endpoints (RunPod binds a template to one endpoint): ${endpoint.template.name}`);
    templateNames.add(endpoint.template.name);
    if (endpoint.template.id !== undefined) templateIds.add(endpoint.template.id);
    if (endpoint.id !== undefined) {
      if (typeof endpoint.id !== "string" || ids.has(endpoint.id)) fail(`endpoint ${endpoint.label} has an "id" that is not text or is used twice`);
      ids.add(endpoint.id);
    }
  }
  for (const id of retired) if (ids.has(id)) fail(`lists ${id} both as an endpoint and as retired`);
  return { template, endpoints, retired };
}

// ---------------------------------------------------------------------------------------------------------------------
// The state at RunPod

/** The endpoints and the templates of the account, as the queries return them. */
export async function readLive(post) {
  const endpoints = (await post(ENDPOINTS_QUERY))?.myself?.endpoints ?? [];
  const templates = (await post(TEMPLATES_QUERY))?.myself?.podTemplates ?? [];
  return { endpoints, templates };
}

/**
 * The live template of a tier, or null. In order: the one its `template.id` names, the one its live endpoint is bound
 * to, the one with its `template.name` (a template that an earlier run made before the endpoint failed). Each is looked
 * for among the endpoints' templates first, then among all templates.
 */
export function liveTemplateOf(live, tier, liveEndpoint) {
  const all = [...live.endpoints.map((endpoint) => endpoint.template).filter(Boolean), ...live.templates];
  const byId = (id) => all.find((template) => template.id === id) ?? null;
  const byName = (name) => all.find((template) => template.name === name) ?? null;
  return (tier.template.id === undefined ? null : byId(tier.template.id)) ?? (liveEndpoint === null ? null : (liveEndpoint.template ?? byId(liveEndpoint.templateId))) ?? byName(tier.template.name);
}

// ---------------------------------------------------------------------------------------------------------------------
// Differences

const MASKS = new Set(["(set)", "(removed)"]);
const show = (value) => (MASKS.has(value) ? value : typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.join(", ")}]` : String(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** `{ field, from, to }` for each field of `fields` that differs; `from` is undefined when there is no live value. */
function changedFields(fields, wanted, current) {
  const changes = [];
  for (const field of fields) {
    if (same(wanted[field], current?.[field])) continue;
    changes.push({ field, from: current?.[field], to: wanted[field] });
  }
  return changes;
}

/** The differences of one tier's template against the shared settings and its name. `live` is null when RunPod shows none. Environment values are masked. */
export function diffTemplate(wanted, live) {
  const changes = changedFields(TEMPLATE_FIELDS, wanted, live);
  const have = envOf(live?.env);
  const want = wanted.env ?? {};
  for (const key of [...new Set([...Object.keys(have), ...Object.keys(want)])].sort()) {
    if (have[key] === want[key]) continue;
    changes.push({ field: `env.${key}`, from: key in have ? "(set)" : undefined, to: key in want ? "(set)" : "(removed)" });
  }
  return { exists: live !== null, changes };
}

/**
 * The differences of one tier. `live` is the RunPod endpoint with the file's id (or, without an id, the one with the
 * file's name), or null. A template that RunPod would not change (saveEndpoint ignores it) is a warning, not a change.
 */
export function diffEndpoint(wanted, live, templateId) {
  const current = live === null ? null : { ...live, gpuIds: gpuIdsOf(live.gpuIds) };
  const changes = changedFields(ENDPOINT_FIELDS, wanted, current);
  const warnings = [];
  if (live !== null && templateId !== undefined && live.templateId !== templateId) {
    warnings.push(`is bound to template ${live.templateId}, not ${templateId}; RunPod ignores a template change on an existing endpoint, so delete and create it to move it`);
  }
  return { exists: live !== null, changes, warnings };
}

/** Finds the live endpoint of a tier: by id when the file has one, else by name. */
export function findLive(live, tier) {
  if (tier.id !== undefined) return live.find((endpoint) => endpoint.id === tier.id) ?? null;
  return live.find((endpoint) => endpoint.name === tier.name) ?? null;
}

/** Everything the run would do. Pure. `live` is what {@link readLive} returns. */
export function planChanges(config, live) {
  const taken = new Set();
  const tiers = config.endpoints.map((tier) => {
    const current = findLive(live.endpoints, tier);
    if (current !== null) taken.add(current.id);
    const liveTemplate = liveTemplateOf(live, tier, current);
    const wanted = { ...config.template, name: tier.template.name, id: tier.template.id ?? liveTemplate?.id };
    const template = { wanted, live: liveTemplate, ...diffTemplate(wanted, liveTemplate) };
    return { tier, template, live: current, ...diffEndpoint(tier, current, wanted.id) };
  });
  const retired = config.retired.map((id) => {
    const current = live.endpoints.find((endpoint) => endpoint.id === id) ?? null;
    if (current !== null) taken.add(current.id);
    return { id, live: current };
  });
  const unmanaged = live.endpoints.filter((endpoint) => !taken.has(endpoint.id)).map((endpoint) => ({ id: endpoint.id, name: endpoint.name }));
  return { endpoints: tiers, retired, unmanaged };
}

/** The report of a plan as lines of text: for each tier its template, then its endpoint. */
export function describePlan(plan) {
  const lines = [];
  const list = (changes) => changes.map(({ field, from, to }) => `    ${field}: ${from === undefined ? "(none)" : show(from)} -> ${show(to)}`);
  for (const { tier, template, exists, changes, warnings } of plan.endpoints) {
    const { wanted } = template;
    lines.push(`template of ${tier.label} (${wanted.name}${wanted.id === undefined ? "" : `, ${wanted.id}`}): ${!template.exists ? "does not exist, will be created" : template.changes.length === 0 ? "no change" : "changes"}`);
    lines.push(...list(template.exists ? template.changes : []));
    lines.push(`endpoint ${tier.label} (${tier.name}${tier.id === undefined ? "" : `, ${tier.id}`}): ${!exists ? "does not exist, will be created" : changes.length === 0 ? "no change" : "changes"}`);
    lines.push(...list(exists ? changes : []));
    for (const warning of warnings) lines.push(`    warning: ${warning}`);
  }
  for (const { id, live } of plan.retired) {
    lines.push(live === null ? `retired ${id}: already gone` : `retired ${id} (${live.name}): still exists; deleted only with --apply --delete-retired; its template ${live.templateId} stays in place`);
  }
  for (const { id, name } of plan.unmanaged) lines.push(`not in the file, left alone: ${id} (${name})`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests

/** A GraphQL literal of a text, number or boolean: JSON is valid GraphQL for these. Enum values are written bare by the caller. */
function literal(value) {
  return JSON.stringify(value);
}

/**
 * The saveEndpoint mutation of a tier, as one query text (no variables: the input type of saveEndpoint is not
 * published). RunPod takes `scalerType` and `type` as text ("REQUEST_COUNT", "LB") and `flashBootType` as an enum (FLASHBOOT), which is
 * why a literal is built by hand. `id` is left out to create.
 */
export function saveEndpointQuery(tier, { id, templateId }) {
  const input = [
    ...(id === undefined ? [] : [`id: ${literal(id)}`]),
    `name: ${literal(tier.name)}`,
    `templateId: ${literal(templateId)}`,
    `gpuIds: ${literal(tier.gpuIds.join(GPU_IDS_SEPARATOR))}`,
    "gpuCount: 1",
    `type: ${literal(tier.type)}`,
    `workersMin: ${literal(tier.workersMin)}`,
    `workersMax: ${literal(tier.workersMax)}`,
    `idleTimeout: ${literal(tier.idleTimeout)}`,
    `scalerType: ${literal(tier.scalerType)}`,
    `scalerValue: ${literal(tier.scalerValue)}`,
    `flashBootType: ${tier.flashBootType}`,
    `executionTimeoutMs: ${literal(tier.executionTimeoutMs)}`,
  ];
  return `mutation { saveEndpoint(input: { ${input.join(", ")} }) { id name } }`;
}

/** The variables of saveTemplate: the file's fields on top of what RunPod holds for the fields the file does not name. Without an id it creates. */
export function saveTemplateVariables(wanted, live) {
  return {
    input: {
      ...(wanted.id === undefined ? {} : { id: wanted.id }),
      name: wanted.name,
      imageName: wanted.imageName,
      containerDiskInGb: wanted.containerDiskInGb,
      volumeInGb: wanted.volumeInGb,
      volumeMountPath: wanted.volumeMountPath,
      ports: wanted.ports,
      startSsh: wanted.startSsh,
      startJupyter: wanted.startJupyter,
      containerRegistryAuthId: wanted.containerRegistryAuthId,
      env: Object.entries(wanted.env ?? {}).map(([key, value]) => ({ key, value })),
      isServerless: true,
      dockerArgs: live?.dockerArgs ?? "",
      readme: live?.readme ?? "",
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Doing it

/**
 * Makes the plan true, tier by tier: the tier's template (saved to update, or created and its id read from the answer),
 * then its endpoint when it differs, bound to that template. Retired endpoints are deleted last, when `deleteRetired`;
 * their templates stay. Returns the lines that say what was done.
 */
export async function applyPlan(plan, post, { deleteRetired }) {
  const done = [];
  for (const { tier, template, live, exists, changes } of plan.endpoints) {
    let templateId = template.wanted.id;
    if (!template.exists || template.changes.length > 0) {
      const saved = await post(SAVE_TEMPLATE_QUERY, saveTemplateVariables(template.wanted, template.live));
      templateId = templateId ?? saved?.saveTemplate?.id;
      done.push(`${template.exists ? "saved" : "created"} template of ${tier.label} (${templateId})`);
    }
    if (exists && changes.length === 0) continue;
    const saved = await post(saveEndpointQuery(tier, { id: live?.id, templateId: live?.templateId ?? templateId }));
    done.push(`${exists ? "saved" : "created"} endpoint ${tier.label} (${live?.id ?? saved?.saveEndpoint?.id})`);
  }
  if (deleteRetired) {
    for (const { id, live } of plan.retired) {
      if (live === null) continue;
      // RunPod refuses to delete an endpoint that may still run workers: scale it to zero first. Not tried live.
      if (live.workersMin > 0 || live.workersMax > 0) {
        const idle = { name: live.name, gpuIds: gpuIdsOf(live.gpuIds), type: live.type, workersMin: 0, workersMax: 0, idleTimeout: live.idleTimeout, scalerType: live.scalerType, scalerValue: live.scalerValue, flashBootType: live.flashBootType ?? "FLASHBOOT", executionTimeoutMs: live.executionTimeoutMs };
        await post(saveEndpointQuery(idle, { id, templateId: live.templateId }));
      }
      await post(DELETE_ENDPOINT_QUERY, { id });
      done.push(`deleted retired endpoint ${id}; left its template ${live.templateId} in place`);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------------------------------------------------
// The call to RunPod

/**
 * A function that posts one GraphQL request and returns its `data`. It throws an ApplyError that carries RunPod's error
 * messages, never the key or the request.
 */
export function makeGraphqlPost(apiKey, fetchFunction = fetch) {
  return async (query, variables) => {
    let response;
    try {
      response = await fetchFunction(GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
      });
    } catch {
      throw new ApplyError("RunPod did not answer");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ApplyError(`RunPod answered HTTP ${response.status} with no JSON`);
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      throw new ApplyError(`RunPod refused the request: ${body.errors.map((error) => String(error?.message ?? "no message")).join("; ")}`);
    }
    if (!response.ok) throw new ApplyError(`RunPod answered HTTP ${response.status}`);
    return body?.data;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The command

/** Reads the command line. */
export function parseArguments(argv) {
  const options = { apply: false, deleteRetired: false, config: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--delete-retired") options.deleteRetired = true;
    else if (argument === "--config") {
      options.config = argv[index + 1];
      index += 1;
      if (options.config === undefined) throw new ApplyError("--config needs a path, or - for standard input");
    } else throw new ApplyError(`unknown argument ${argument}`);
  }
  if (options.deleteRetired && !options.apply) throw new ApplyError("--delete-retired works only with --apply");
  return options;
}

const DEFAULT_CONFIG = fileURLToPath(new URL("./endpoints.json", import.meta.url));

/**
 * Runs the command. Everything outside is passed in: the arguments, the environment, the readers, the HTTP call and
 * the output. Returns the exit code.
 */
export async function run({ argv, env, readFile = (path) => readFileSync(path, "utf8"), readStdin = () => readFileSync(0, "utf8"), post, fetchFunction, out = (line) => console.log(line), err = (line) => console.error(line) }) {
  try {
    const options = parseArguments(argv);
    const apiKey = env.RUNPOD_API_KEY;
    if (apiKey === undefined || apiKey === "") throw new ApplyError("set RUNPOD_API_KEY in the environment");
    const config = parseConfig(options.config === "-" ? readStdin() : readFile(options.config ?? DEFAULT_CONFIG));
    const send = post ?? makeGraphqlPost(apiKey, fetchFunction);
    const plan = planChanges(config, await readLive(send));
    for (const line of describePlan(plan)) out(line);
    if (!options.apply) {
      out("dry run: nothing changed. Add --apply to make these changes.");
      return 0;
    }
    for (const line of await applyPlan(plan, send, { deleteRetired: options.deleteRetired })) out(line);
    out("done");
    return 0;
  } catch (error) {
    err(error instanceof ApplyError ? error.message : `failed: ${error?.code ?? "unexpected error"}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
}
