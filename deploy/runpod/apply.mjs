#!/usr/bin/env node
// Brings RunPod to the state that endpoints.json declares: one serverless endpoint per tier, each carrying the shared container settings (image, disk, ports, environment, registry) itself.
// No dependencies; Node 22. It talks to RunPod's REST API v2 (https://api.runpod.io/v2). There are no templates any more: RunPod copies a
// template into an endpoint when the endpoint is created and does not link them afterwards, so the settings are written to each endpoint directly.
//
//   RUNPOD_API_KEY=... node deploy/runpod/apply.mjs                    dry run: prints the differences from what RunPod holds now
//   RUNPOD_API_KEY=... node deploy/runpod/apply.mjs --apply            patches each endpoint that differs (only the fields that differ) and creates a missing one
//   ... --apply --delete-retired                                        also deletes the endpoints listed under "retired"
//   ... --apply --delete-unused-templates                               also deletes the templates that no tier needs (listed in every run)
//   ... --config <file>|-                                               another file, or the JSON on standard input
//
// The key comes from the environment only. It is never printed, and no request is printed. An endpoint that exists at
// RunPod but is neither in the file nor retired is listed and never touched. REST v2 answers 422 for a field it does not know, so the
// requests carry schema fields only. See docs/gpu-prover.md, "RunPod endpoints in configuration".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RUNPOD_REST_URL = "https://api.runpod.io/v2";

/** The page size of a list request (RunPod allows up to 1000). */
const PAGE_SIZE = 100;
/** `flashboot` of an endpoint: RunPod's enum. */
export const FLASHBOOT_VALUES = ["OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"];
export const ENDPOINT_TYPES = ["QUEUE", "LOAD_BALANCER"];

/** The top-level fields of `PATCH /v2/serverless/{id}` that this script sends (a subset of the schema; any other field is a 422). */
export const PATCH_FIELDS = ["name", "image", "disk", "ports", "env", "registry", "gpu", "workers", "flashboot", "timeout", "scaling"];
/** The top-level fields of `POST /v2/serverless` that this script sends: those of a patch, and the type. */
export const CREATE_FIELDS = [...PATCH_FIELDS, "type"];
/** The fields that RunPod reads in `gpu` and `workers`. */
export const GPU_FIELDS = ["pools", "excludedTypes", "minCudaVersion"];
export const WORKERS_FIELDS = ["min", "max", "idleTimeout"];

/** Raised for a problem the operator must read: a bad file, a RunPod error. Its message never holds the key. */
export class ApplyError extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// The file

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value !== "";
const isTextList = (value) => Array.isArray(value) && value.every((entry) => isText(entry));

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
  if (!isObject(config)) fail("must be an object");
  if ("template" in config) fail('has a "template": REST v2 has no per-tier templates; the shared settings are the "container" object and are written to each endpoint');
  const { container, endpoints, retired = [], keepTemplates = [] } = config;
  if (!isObject(container)) fail('needs a "container" object');
  if (!isText(container.image)) fail('container needs a text "image"');
  if (!Number.isInteger(container.disk) || container.disk < 1) fail('container needs a whole number "disk" of at least 1 (GB)');
  if (!isTextList(container.ports) || container.ports.length === 0) fail('container needs a non-empty "ports" list of text, such as "8000/http"');
  if (container.env !== undefined && (!isObject(container.env) || Object.values(container.env).some((value) => typeof value !== "string"))) fail('container "env" must map names to text');
  if (container.registry !== undefined && !isText(container.registry)) fail('container "registry" must be the text id of a RunPod container registry credential');
  if (!Array.isArray(endpoints) || endpoints.length === 0) fail('needs a non-empty "endpoints" list');
  if (!isTextList(retired)) fail('"retired" must be a list of endpoint ids');
  if (!isTextList(keepTemplates)) fail('"keepTemplates" must be a list of template ids that --delete-unused-templates leaves alone');
  const names = new Set();
  const ids = new Set();
  for (const endpoint of endpoints) {
    if (!isObject(endpoint)) fail("has an endpoint that is not an object");
    for (const key of ["label", "name"]) if (!isText(endpoint[key])) fail(`endpoint needs a text "${key}"`);
    const where = `endpoint ${endpoint.label}`;
    if (!ENDPOINT_TYPES.includes(endpoint.type)) fail(`${where} needs a "type" of ${ENDPOINT_TYPES.join(" or ")}`);
    const { gpu, workers, scaling } = endpoint;
    if (!isObject(gpu) || !isTextList(gpu.pools) || gpu.pools.length === 0) fail(`${where} needs "gpu" with a non-empty "pools" list`);
    if (!isTextList(gpu.excludedTypes) || gpu.excludedTypes.some((type) => type.trim().startsWith("-"))) fail(`${where} needs "gpu.excludedTypes", a list of GPU names without a leading "-" (it may be empty)`);
    if (typeof gpu.minCudaVersion !== "string" || !/^\d+\.\d+$/.test(gpu.minCudaVersion)) fail(`${where} needs "gpu.minCudaVersion" as text such as "12.8"`);
    if (!isObject(workers) || !Number.isInteger(workers.min) || !Number.isInteger(workers.max) || workers.min < 0 || workers.max < workers.min) fail(`${where} needs "workers" with whole numbers "min" and "max" (max not below min)`);
    if (!Number.isInteger(endpoint.idleTimeout) || endpoint.idleTimeout < 1 || endpoint.idleTimeout > 3600) fail(`${where} needs a whole number "idleTimeout" from 1 to 3600 (seconds)`);
    if (!FLASHBOOT_VALUES.includes(endpoint.flashboot)) fail(`${where} needs "flashboot" of ${FLASHBOOT_VALUES.join(", ")}`);
    if (!Number.isInteger(endpoint.timeoutMs) || endpoint.timeoutMs < 1) fail(`${where} needs a whole number "timeoutMs"`);
    if (!isObject(scaling)) fail(`${where} needs "scaling"`);
    if (scaling.type === "REQUEST_COUNT") {
      if (!Number.isInteger(scaling.requestCount) || scaling.requestCount < 1) fail(`${where} needs scaling "requestCount" of at least 1`);
    } else if (scaling.type === "QUEUE_DELAY") {
      if (typeof scaling.queueDelay !== "number" || scaling.queueDelay < 0.5) fail(`${where} needs scaling "queueDelay" of at least 0.5`);
    } else fail(`${where} needs scaling "type" REQUEST_COUNT or QUEUE_DELAY`);
    if (endpoint.type === "LOAD_BALANCER" && scaling.type !== "REQUEST_COUNT") fail(`${where} is a LOAD_BALANCER, which scales by REQUEST_COUNT`);
    if (names.has(endpoint.name)) fail(`names the endpoint "${endpoint.name}" twice`);
    names.add(endpoint.name);
    if (endpoint.id !== undefined) {
      if (!isText(endpoint.id) || ids.has(endpoint.id)) fail(`endpoint ${endpoint.label} has an "id" that is not text or is used twice`);
      ids.add(endpoint.id);
    }
  }
  for (const id of retired) if (ids.has(id)) fail(`lists ${id} both as an endpoint and as retired`);
  return { container, endpoints, retired, keepTemplates };
}

// ---------------------------------------------------------------------------------------------------------------------
// The call to RunPod

/** `title: detail` of an RFC 9457 problem document, or null. */
export function problemText(body) {
  if (!isObject(body)) return null;
  const parts = [body.title, body.detail].filter((part) => isText(part));
  return parts.length === 0 ? null : parts.join(": ").replace(/\s+/g, " ").slice(0, 300);
}

/**
 * A client of REST v2: `request(method, path, body)` returns the JSON answer (null for an empty one, such as the 204 of a
 * delete). It throws an ApplyError that carries the method, the path, the status and RunPod's problem text (RFC 9457
 * `title` and `detail`), never the key or the request body.
 */
export function makeRestClient(apiKey, fetchFunction = fetch, baseUrl = RUNPOD_REST_URL) {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async request(method, path, body) {
      let response;
      try {
        response = await fetchFunction(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new ApplyError(`RunPod did not answer ${method} ${path}`);
      }
      const text = await response.text().catch(() => "");
      let parsed = null;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (response.ok) throw new ApplyError(`RunPod answered ${method} ${path} with something that is not JSON`);
        }
      }
      if (!response.ok) {
        const problem = problemText(parsed);
        throw new ApplyError(`RunPod refused ${method} ${path}: HTTP ${response.status}${problem === null ? "" : `: ${problem}`}`);
      }
      return parsed;
    },
  };
}

/** Every item of a paginated list (`pagination.nextCursor`, `hasNextPage`), from the array under `key`. */
export async function listAll(client, path, key) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 1000; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const answer = await client.request("GET", `${path}${separator}limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    if (!isObject(answer) || !Array.isArray(answer[key])) throw new ApplyError(`RunPod answered ${path} with no "${key}" list`);
    items.push(...answer[key]);
    if (answer.pagination?.hasNextPage !== true || !isText(answer.pagination?.nextCursor)) return items;
    cursor = answer.pagination.nextCursor;
  }
  throw new ApplyError(`RunPod's list ${path} has too many pages`);
}

/** The endpoints and the templates of the account. */
export async function readLive(client) {
  const endpoints = await listAll(client, "/serverless", "endpoints");
  const templates = await listAll(client, "/templates", "templates");
  return { endpoints, templates };
}

// ---------------------------------------------------------------------------------------------------------------------
// Differences

const MASKS = new Set(["(set)", "(removed)"]);
const show = (value) => (MASKS.has(value) ? value : typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.join(", ")}]` : value === null ? "null" : String(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = (list) => [...(list ?? [])].sort();

/** What the file wants of one endpoint, in the shape of the API (the fields of {@link CREATE_FIELDS}). */
export function wantedBody(container, tier) {
  return {
    name: tier.name,
    type: tier.type,
    image: container.image,
    disk: container.disk,
    ports: container.ports,
    env: container.env ?? {},
    ...(container.registry === undefined ? {} : { registry: container.registry }),
    gpu: { pools: tier.gpu.pools, excludedTypes: tier.gpu.excludedTypes, minCudaVersion: tier.gpu.minCudaVersion },
    workers: { min: tier.workers.min, max: tier.workers.max, idleTimeout: tier.idleTimeout },
    flashboot: tier.flashboot,
    timeout: tier.timeoutMs,
    scaling: tier.scaling,
  };
}

/** What RunPod holds of one endpoint, cut to the same fields and shape (lists in a fixed order, missing parts empty). */
function liveView(live) {
  return {
    name: live.name,
    type: live.type,
    image: live.image,
    disk: live.disk,
    ports: live.ports ?? [],
    env: live.env ?? {},
    registry: live.registry ?? null,
    gpu: { pools: sorted(live.gpu?.pools), excludedTypes: sorted(live.gpu?.excludedTypes), minCudaVersion: live.gpu?.minCudaVersion ?? null },
    workers: { min: live.workers?.min, max: live.workers?.max, idleTimeout: live.workers?.idleTimeout },
    flashboot: live.flashboot,
    timeout: live.timeout,
    scaling: live.scaling ?? null,
  };
}

/** The wanted body with its lists in the same fixed order, for a comparison. */
function wantedView(wanted) {
  return { ...wanted, registry: wanted.registry ?? null, gpu: { ...wanted.gpu, pools: sorted(wanted.gpu.pools), excludedTypes: sorted(wanted.gpu.excludedTypes) } };
}

/**
 * The differences of one tier. `live` is the RunPod endpoint with the file's id (or, without an id, the one with the
 * file's name), or null. `changes` is a list of `{ field, from, to }` (environment values are masked); `patch` is the
 * request body of the fields that differ and only those, since RunPod changes only what is given and an unchanged field
 * must not be written again. The `type` of an endpoint cannot change: a difference is a warning.
 */
export function diffEndpoint(container, tier, live) {
  const wanted = wantedBody(container, tier);
  if (live === null) return { exists: false, changes: [], patch: null, create: wanted, warnings: [] };
  const have = liveView(live);
  const want = wantedView(wanted);
  const changes = [];
  const patch = {};
  const note = (field, from, to) => changes.push({ field, from, to });
  for (const field of ["name", "image", "disk", "registry", "flashboot", "timeout"]) {
    if (field === "registry" && !("registry" in wanted)) continue;
    if (same(want[field], have[field])) continue;
    note(field, have[field] ?? undefined, want[field]);
    patch[field] = wanted[field];
  }
  if (!same(want.ports, have.ports)) {
    note("ports", have.ports, want.ports);
    patch.ports = wanted.ports;
  }
  const envKeys = [...new Set([...Object.keys(have.env), ...Object.keys(want.env)])].sort();
  const envChanged = envKeys.filter((key) => have.env[key] !== want.env[key]);
  for (const key of envChanged) note(`env.${key}`, key in have.env ? "(set)" : undefined, key in want.env ? "(set)" : "(removed)");
  if (envChanged.length > 0) patch.env = wanted.env;
  // `gpu` goes whole when one of its fields differs: RunPod wants `pools` beside `excludedTypes`.
  const gpuChanged = GPU_FIELDS.filter((field) => !same(want.gpu[field], have.gpu[field]));
  for (const field of gpuChanged) note(`gpu.${field}`, have.gpu[field] ?? undefined, want.gpu[field]);
  if (gpuChanged.length > 0) patch.gpu = wanted.gpu;
  const workersChanged = WORKERS_FIELDS.filter((field) => want.workers[field] !== have.workers[field]);
  for (const field of workersChanged) note(`workers.${field}`, have.workers[field], want.workers[field]);
  if (workersChanged.length > 0) patch.workers = Object.fromEntries(workersChanged.map((field) => [field, wanted.workers[field]]));
  if (!same(want.scaling, have.scaling)) {
    for (const field of new Set([...Object.keys(want.scaling), ...Object.keys(have.scaling ?? {})])) if (want.scaling[field] !== have.scaling?.[field]) note(`scaling.${field}`, have.scaling?.[field], want.scaling[field]);
    patch.scaling = wanted.scaling;
  }
  const warnings = [];
  if (have.type !== want.type) warnings.push(`is a ${have.type} endpoint at RunPod, not ${want.type}; RunPod cannot change the type of an endpoint, so delete and create it to change it`);
  return { exists: true, changes, patch: changes.length === 0 ? null : patch, create: null, warnings };
}

/** Finds the live endpoint of a tier: by id when the file has one, else by name. */
export function findLive(live, tier) {
  if (tier.id !== undefined) return live.find((endpoint) => endpoint.id === tier.id) ?? null;
  return live.find((endpoint) => endpoint.name === tier.name) ?? null;
}

/**
 * The templates of the account that no tier needs. A tier does not use a template (the settings are written to its
 * endpoint, and RunPod keeps no link to a template), so every private serverless template qualifies except those that
 * `keepTemplates` names. Public templates and pod templates are not touched and not listed.
 */
export function unusedTemplates(templates, config) {
  return templates.filter((template) => template.public !== true && template.serverless === true && !config.keepTemplates.includes(template.id)).map((template) => ({ id: template.id, name: template.name }));
}

/** Everything the run would do. Pure. `live` is what {@link readLive} returns. */
export function planChanges(config, live) {
  const taken = new Set();
  const tiers = config.endpoints.map((tier) => {
    const current = findLive(live.endpoints, tier);
    if (current !== null) taken.add(current.id);
    return { tier, live: current, ...diffEndpoint(config.container, tier, current) };
  });
  const retired = config.retired.map((id) => {
    const current = live.endpoints.find((endpoint) => endpoint.id === id) ?? null;
    if (current !== null) taken.add(current.id);
    return { id, live: current };
  });
  const unmanaged = live.endpoints.filter((endpoint) => !taken.has(endpoint.id)).map((endpoint) => ({ id: endpoint.id, name: endpoint.name }));
  return { endpoints: tiers, retired, unmanaged, templates: unusedTemplates(live.templates, config) };
}

/** The report of a plan as lines of text. */
export function describePlan(plan) {
  const lines = [];
  const list = (changes) => changes.map(({ field, from, to }) => `    ${field}: ${from === undefined ? "(none)" : show(from)} -> ${show(to)}`);
  for (const { tier, exists, changes, warnings } of plan.endpoints) {
    lines.push(`endpoint ${tier.label} (${tier.name}${tier.id === undefined ? "" : `, ${tier.id}`}): ${!exists ? "does not exist, will be created" : changes.length === 0 ? "no change" : "changes"}`);
    lines.push(...list(changes));
    for (const warning of warnings) lines.push(`    warning: ${warning}`);
  }
  for (const { id, live } of plan.retired) {
    lines.push(live === null ? `retired ${id}: already gone` : `retired ${id} (${live.name}): still exists; deleted only with --apply --delete-retired`);
  }
  for (const { id, name } of plan.unmanaged) lines.push(`not in the file, left alone: ${id} (${name})`);
  if (plan.templates.length > 0) {
    lines.push(`templates that no tier needs (RunPod copies a template into an endpoint when it is created and keeps no link; deleted only with --apply --delete-unused-templates):`);
    for (const { id, name } of plan.templates) lines.push(`    ${id} (${name})`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Doing it

/**
 * Makes the plan true, tier by tier: a patch of the fields that differ, or a create for a missing endpoint. Retired
 * endpoints are deleted next, when `deleteRetired`, and the unused templates last, when `deleteUnusedTemplates`. Returns
 * the lines that say what was done.
 */
export async function applyPlan(plan, client, { deleteRetired = false, deleteUnusedTemplates = false } = {}) {
  const done = [];
  for (const { tier, live, exists, patch, create } of plan.endpoints) {
    if (!exists) {
      const created = await client.request("POST", "/serverless", create);
      done.push(`created endpoint ${tier.label} (${created?.id ?? "id not returned"}); put this id in endpoints.json`);
    } else if (patch !== null) {
      await client.request("PATCH", `/serverless/${encodeURIComponent(live.id)}`, patch);
      done.push(`patched endpoint ${tier.label} (${live.id}): ${Object.keys(patch).join(", ")}`);
    }
  }
  if (deleteRetired) {
    for (const { id, live } of plan.retired) {
      if (live === null) continue;
      // RunPod may refuse to delete an endpoint that can still run workers: scale it to zero first. Not tried live.
      if ((live.workers?.min ?? 0) > 0 || (live.workers?.max ?? 0) > 0) await client.request("PATCH", `/serverless/${encodeURIComponent(id)}`, { workers: { min: 0, max: 0 } });
      await client.request("DELETE", `/serverless/${encodeURIComponent(id)}`);
      done.push(`deleted retired endpoint ${id}`);
    }
  }
  if (deleteUnusedTemplates) {
    for (const { id, name } of plan.templates) {
      await client.request("DELETE", `/templates/${encodeURIComponent(id)}`);
      done.push(`deleted template ${id} (${name})`);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------------------------------------------------
// The command

/** Reads the command line. */
export function parseArguments(argv) {
  const options = { apply: false, deleteRetired: false, deleteUnusedTemplates: false, config: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--delete-retired") options.deleteRetired = true;
    else if (argument === "--delete-unused-templates") options.deleteUnusedTemplates = true;
    else if (argument === "--config") {
      options.config = argv[index + 1];
      index += 1;
      if (options.config === undefined) throw new ApplyError("--config needs a path, or - for standard input");
    } else throw new ApplyError(`unknown argument ${argument}`);
  }
  if ((options.deleteRetired || options.deleteUnusedTemplates) && !options.apply) throw new ApplyError("--delete-retired and --delete-unused-templates work only with --apply");
  return options;
}

const DEFAULT_CONFIG = fileURLToPath(new URL("./endpoints.json", import.meta.url));

/**
 * Runs the command. Everything outside is passed in: the arguments, the environment, the readers, the HTTP client and
 * the output. Returns the exit code.
 */
export async function run({ argv, env, readFile = (path) => readFileSync(path, "utf8"), readStdin = () => readFileSync(0, "utf8"), client, fetchFunction, out = (line) => console.log(line), err = (line) => console.error(line) }) {
  try {
    const options = parseArguments(argv);
    const apiKey = env.RUNPOD_API_KEY;
    if (apiKey === undefined || apiKey === "") throw new ApplyError("set RUNPOD_API_KEY in the environment");
    const config = parseConfig(options.config === "-" ? readStdin() : readFile(options.config ?? DEFAULT_CONFIG));
    const rest = client ?? makeRestClient(apiKey, fetchFunction);
    const plan = planChanges(config, await readLive(rest));
    for (const line of describePlan(plan)) out(line);
    if (!options.apply) {
      out("dry run: nothing changed. Add --apply to make these changes.");
      return 0;
    }
    for (const line of await applyPlan(plan, rest, options)) out(line);
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
