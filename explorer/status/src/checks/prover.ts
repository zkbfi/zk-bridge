import type { Deps } from "../deps.ts";
import type { CheckSpec, Outcome } from "../types.ts";
import { get, json, type Answer } from "./fetch.ts";

/** `title: detail` of an RFC 9457 problem document (RunPod's error answers), or null. */
function problemOf(answer: Answer): string | null {
  const body = json(answer) as { title?: unknown; detail?: unknown } | null;
  if (typeof body !== "object" || body === null) return null;
  const parts = [body.title, body.detail].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length === 0 ? null : parts.join(": ").replace(/\s+/g, " ").slice(0, 200);
}

type EndpointBody = { workers?: { min?: unknown; max?: unknown } | null; gpu?: { pools?: unknown } | null };
type WorkersBody = { workers?: unknown; endpointVersion?: unknown };
/** The worker states that count as a worker up: RunPod's `RUNNING`, `IDLE` and `INITIALIZING` (not `THROTTLED` or `UNHEALTHY`). */
const UP = new Set(["RUNNING", "IDLE", "INITIALIZING"]);

/**
 * The proving endpoints at RunPod, read from REST API v2, two requests per endpoint and run: `GET /v2/serverless/{id}`
 * (the smallest and the largest number of workers, the GPU pools) and `GET /v2/serverless/{id}/workers` (the workers up
 * now, and whether each is stale: `isStale` is true for a worker that started before the endpoint's latest settings change,
 * such as a new image; `endpointVersion` is the number of that change). A tier with stale workers says how many of its workers
 * still run an older configuration; that alone does not change the state. Degraded when an endpoint has max 0, is not found, or its worker list cannot be read; down on a refused key or an
 * HTTP error. RunPod's error answers are RFC 9457 problem documents; their title and detail go into the text. This never
 * calls an endpoint itself (`/ping` or `/prove` would start a paid worker).
 */
export const runpodCheck: CheckSpec<Deps> = {
  id: "prover-runpod",
  name: "RunPod proving endpoint",
  section: "pipeline",
  async run(deps) {
    const runpod = deps.config.runpod as NonNullable<Deps["config"]["runpod"]>;
    const headers = { authorization: `Bearer ${deps.apiKey as string}` };
    const base = runpod.restUrl.replace(/\/+$/, "");
    const refused = (answer: Answer): Outcome | null => {
      if (answer.status !== 401 && answer.status !== 403) return null;
      const problem = problemOf(answer);
      return { state: "down", detail: `RunPod refused the API key (${answer.status})${problem === null ? "" : `: ${problem}`}` };
    };
    const reads = await Promise.all(
      runpod.endpoints.map(async ({ id }) => {
        const [endpoint, list] = await Promise.all([get(deps, `${base}/serverless/${encodeURIComponent(id)}`, { headers }), get(deps, `${base}/serverless/${encodeURIComponent(id)}/workers`, { headers })]);
        return { endpoint, list };
      }),
    );
    for (const { endpoint, list } of reads) {
      const stop = refused(endpoint) ?? refused(list);
      if (stop !== null) return stop;
    }
    const lines: string[] = [];
    let degraded = false;
    let anyStale = false;
    for (const [index, { id, label }] of runpod.endpoints.entries()) {
      const { endpoint, list } = reads[index] as (typeof reads)[number];
      if (endpoint.status === 404) {
        degraded = true;
        const problem = problemOf(endpoint);
        lines.push(`${label}: RunPod has no endpoint with this id${problem === null ? "" : ` (${problem})`}`);
        continue;
      }
      if (endpoint.status !== 200) {
        const problem = problemOf(endpoint);
        return { state: "down", detail: `RunPod answered ${endpoint.status}${problem === null ? "" : `: ${problem}`}` };
      }
      const body = json(endpoint) as EndpointBody | null;
      if (typeof body !== "object" || body === null) {
        degraded = true;
        lines.push(`${label}: RunPod answered something that is not an endpoint`);
        continue;
      }
      const max = Number(body.workers?.max ?? 0);
      const range = `min ${Number(body.workers?.min ?? 0)}, max ${max}`;
      const pools = Array.isArray(body.gpu?.pools) ? (body.gpu?.pools as unknown[]).filter((pool): pool is string => typeof pool === "string" && pool !== "") : [];
      const gpus = pools.length > 0 ? `GPUs ${pools.join(", ")}` : "no GPU list";
      if (max === 0) {
        degraded = true;
        lines.push(`${label}: the largest number of workers is 0, so it cannot prove (${range})`);
        continue;
      }
      if (list.status !== 200) {
        degraded = true;
        const problem = problemOf(list);
        lines.push(`${label}: running workers unknown, RunPod answered ${list.status} for the worker list${problem === null ? "" : `: ${problem}`} (${range}), ${gpus}`);
        continue;
      }
      const listBody = json(list) as WorkersBody | null;
      const workers = Array.isArray(listBody?.workers) ? (listBody?.workers as unknown[]) : [];
      const running = workers.filter((worker) => UP.has(String((worker as { status?: unknown } | null)?.status))).length;
      const stale = workers.filter((worker) => (worker as { isStale?: unknown } | null)?.isStale === true).length;
      let line = `${label}: ${running} running now (${range}), ${gpus}`;
      if (stale > 0) {
        anyStale = true;
        const version = listBody?.endpointVersion;
        line += `, ${stale} of ${workers.length} workers still ${stale === 1 ? "runs" : "run"} an older configuration${typeof version === "number" ? ` than endpoint version ${version}` : ""}`;
      }
      lines.push(line);
    }
    const explanation = anyStale ? ". Endpoint version is RunPod's count of changes to an endpoint's settings, such as a new image." : "";
    return { state: degraded ? "degraded" : "ok", detail: `${lines.join("; ")}${explanation}` };
  },
};
