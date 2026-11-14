import type { Deps } from "../deps.ts";
import type { CheckSpec } from "../types.ts";
import { get, json } from "./fetch.ts";

const QUERY = "{ myself { endpoints { id name workersMin workersMax gpuIds pods { id desiredStatus } } } }";

type Row = { id?: unknown; workersMin?: unknown; workersMax?: unknown; gpuIds?: unknown; pods?: unknown };

/**
 * The proving endpoints at RunPod, read with one GraphQL request per run (`myself { endpoints }`), for all configured
 * endpoints: workers now (pods that should be running), the smallest and the largest number of workers, and the GPU list.
 * RunPod's REST API has a daily request limit; GraphQL kept answering. This never calls an endpoint itself (`/ping` or
 * `/prove` would start a paid worker).
 */
export const runpodCheck: CheckSpec<Deps> = {
  id: "prover-runpod",
  name: "RunPod proving endpoint",
  section: "pipeline",
  async run(deps) {
    const runpod = deps.config.runpod as NonNullable<Deps["config"]["runpod"]>;
    const key = deps.apiKey as string;
    const answer = await get(deps, runpod.graphqlUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      requestBody: JSON.stringify({ query: QUERY }),
    });
    if (answer.status === 401 || answer.status === 403) return { state: "down", detail: `RunPod refused the API key (${answer.status})` };
    if (answer.status !== 200) return { state: "down", detail: `RunPod answered ${answer.status}` };
    const body = json(answer) as { data?: { myself?: { endpoints?: unknown } | null } | null; errors?: unknown } | null;
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const first = (body.errors[0] as { message?: unknown } | null)?.message;
      return { state: "down", detail: `RunPod GraphQL error: ${typeof first === "string" ? first : "no message"}` };
    }
    const rows = body?.data?.myself?.endpoints;
    if (!Array.isArray(rows)) return { state: "degraded", detail: "RunPod answered something that is not a list of endpoints" };
    const lines: string[] = [];
    let degraded = false;
    for (const { id, label } of runpod.endpoints) {
      const row = rows.find((candidate) => (candidate as Row | null)?.id === id) as Row | undefined;
      if (row === undefined) {
        degraded = true;
        lines.push(`${label}: not in the RunPod answer`);
        continue;
      }
      const running = Array.isArray(row.pods) ? row.pods.filter((pod) => (pod as { desiredStatus?: unknown } | null)?.desiredStatus === "RUNNING").length : 0;
      const max = Number(row.workersMax ?? 0);
      const range = `min ${Number(row.workersMin ?? 0)}, max ${max}`;
      const gpus = typeof row.gpuIds === "string" && row.gpuIds !== "" ? `GPUs ${row.gpuIds.split(",").map((gpu) => gpu.trim()).join(", ")}` : "no GPU list";
      if (max === 0) {
        degraded = true;
        lines.push(`${label}: the largest number of workers is 0, so it cannot prove (${range})`);
      } else lines.push(`${label}: ${running} running now (${range}), ${gpus}`);
    }
    return { state: degraded ? "degraded" : "ok", detail: lines.join("; ") };
  },
};
