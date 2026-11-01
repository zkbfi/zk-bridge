import type { Deps } from "../deps.ts";
import type { CheckSpec } from "../types.ts";
import { count, get, json } from "./fetch.ts";

/**
 * The proving endpoint at RunPod, read through RunPod's REST API (`GET /endpoints/<id>`): workers now, the smallest and
 * the largest number of workers, and the GPU list. This never calls the endpoint itself (`/ping` or `/prove` would start
 * a paid worker).
 */
export const runpodCheck: CheckSpec<Deps> = {
  id: "prover-runpod",
  name: "RunPod proving endpoint",
  section: "pipeline",
  async run(deps) {
    const runpod = deps.config.runpod as NonNullable<Deps["config"]["runpod"]>;
    const key = deps.apiKey as string;
    const answer = await get(deps, `${runpod.apiBase}/endpoints/${runpod.endpointId}?includeWorkers=true`, { headers: { authorization: `Bearer ${key}` } });
    if (answer.status === 401 || answer.status === 403) return { state: "down", detail: `RunPod refused the API key (${answer.status})` };
    if (answer.status === 404) return { state: "down", detail: "RunPod has no endpoint with this id (404)" };
    if (answer.status !== 200) return { state: "down", detail: `RunPod answered ${answer.status}` };
    const body = json(answer) as { workersMin?: unknown; workersMax?: unknown; gpuTypeIds?: unknown; workers?: unknown } | null;
    if (typeof body !== "object" || body === null || typeof body.workersMax !== "number") return { state: "degraded", detail: "RunPod answered something that is not an endpoint" };
    const workers = Array.isArray(body.workers) ? body.workers.length : 0;
    const range = `min ${Number(body.workersMin ?? 0)}, max ${body.workersMax}`;
    if (body.workersMax === 0) return { state: "degraded", detail: `the largest number of workers is 0, so it cannot prove (${range})` };
    const gpus = Array.isArray(body.gpuTypeIds) && body.gpuTypeIds.length > 0 ? `GPUs ${body.gpuTypeIds.join(", ")}` : "no GPU list";
    return { state: "ok", detail: `${count(workers, "worker")} running now (${range}), ${gpus}` };
  },
};
