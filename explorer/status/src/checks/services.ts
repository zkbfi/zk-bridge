import type { Deps } from "../deps.ts";
import type { CheckSpec } from "../types.ts";
import { count, get, isSlow, json, seconds } from "./fetch.ts";

type Spec = CheckSpec<Deps>;
const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The indexer answers `/ready` with 200 when it has caught up with the chains. */
export const indexerReadyCheck = (base: string, where: "local" | "public" = base.includes("127.0.0.1") ? "local" : "public"): Spec => ({
  id: `indexer-${where}`,
  name: where === "local" ? "Indexer (on the server)" : "Indexer (public)",
  section: "services",
  async run(deps) {
    const answer = await get(deps, `${base}/ready`);
    if (answer.status !== 200) return { state: "down", detail: `answered ${answer.status}, not ready` };
    return isSlow(deps, answer) ? { state: "degraded", detail: `ready, but it took ${seconds(answer.ms)}` } : { state: "ok", detail: "ready" };
  },
});

/** The webhook host answers `/health` through the backend. */
export const webhookCheck = (base: string): Spec => healthCheck("webhook", "Webhook (public)", base);

/** The public prove host answers `/health` through the backend. */
export const backendPublicCheck = (base: string): Spec => healthCheck("backend-public", "Backend (public)", base);

function healthCheck(id: string, name: string, base: string): Spec {
  return {
    id,
    name,
    section: "services",
    async run(deps) {
      const answer = await get(deps, `${base}/health`);
      if (answer.status !== 200) return { state: "down", detail: `answered ${answer.status} on /health` };
      return isSlow(deps, answer) ? { state: "degraded", detail: `healthy, but it took ${seconds(answer.ms)}` } : { state: "ok", detail: "healthy" };
    },
  };
}

/** The backend on the server: `/health` with the state of each module and the queue. */
export const backendLocalCheck = (base: string): Spec => ({
  id: "backend-local",
  name: "Backend (on the server)",
  section: "services",
  async run(deps) {
    const answer = await get(deps, `${base}/health`);
    if (answer.status !== 200) return { state: "down", detail: `answered ${answer.status} on /health` };
    const report = record(json(answer));
    const modules = record(report?.modules);
    if (report === null || modules === null) return { state: "down", detail: "answered something that is not the health report" };
    const queue = Number(record(report.queue)?.length ?? 0);
    const trouble = Object.entries(modules)
      .map(([name, value]) => ({ name, health: record(value) }))
      .filter((module) => module.health?.state !== "running")
      .map((module) => `module ${module.name} is ${String(module.health?.state ?? "unknown")}${typeof module.health?.detail === "string" ? ` (${module.health.detail})` : ""}`);
    if (trouble.length > 0) return { state: "degraded", detail: trouble.join("; ") };
    return { state: "ok", detail: `${count(Object.keys(modules).length, "module")} running, ${count(queue, "job")} queued` };
  },
});

type Release = { readonly sequence: number; readonly version: string | null; readonly dappCid: string | null };

/** Reads `version.json` of a site. Throws a message that says why not. */
async function readRelease(deps: Deps, base: string): Promise<Release> {
  const answer = await get(deps, `${base}/version.json`);
  if (answer.status !== 200) throw new ReleaseError(`version.json answered ${answer.status}`);
  const manifest = record(json(answer));
  const sequence = manifest?.sequence;
  const releases = Array.isArray(manifest?.releases) ? manifest.releases.map(record) : [];
  const dapp = releases.find((release) => release?.name === "dapp");
  const channels = Object.values(record(manifest?.channels) ?? {});
  return {
    sequence: typeof sequence === "number" ? sequence : Number.NaN,
    version: typeof channels[0] === "string" ? channels[0] : null,
    dappCid: typeof dapp?.cid === "string" ? dapp.cid : null,
  };
}

class ReleaseError extends Error {}

/** A site answers 200 and its `version.json` names a release sequence that never goes down. */
export const siteCheck = (channel: "next" | "main", base: string): Spec => ({
  id: `site-${channel}`,
  name: channel === "next" ? "next.zkb.fi (staging channel)" : "zkb.fi (landing)",
  section: "services",
  async run(deps) {
    const page = await get(deps, `${base}/`, { body: false });
    if (page.status !== 200) return { state: "down", detail: `the page answered ${page.status}` };
    let release: Release;
    try {
      release = await readRelease(deps, base);
    } catch (error) {
      if (!(error instanceof ReleaseError)) throw error;
      return { state: "degraded", detail: `the page answers, but ${error.message}` };
    }
    if (!Number.isInteger(release.sequence)) return { state: "degraded", detail: "the page answers, but version.json has no release sequence" };
    const key = `sequence-${channel}`;
    const seen = deps.memory.get(key);
    deps.memory.set(key, Math.max(seen ?? 0, release.sequence));
    if (seen !== undefined && release.sequence < seen) return { state: "degraded", detail: `release sequence went back from ${seen} to ${release.sequence}` };
    return { state: "ok", detail: `page 200, release sequence ${release.sequence}${release.version === null ? "" : ` (${release.version})`}` };
  },
});

/** The IPFS gateway serves the dapp that the release of a site names. */
export const gatewayCheck = (channel: "next" | "main", siteBase: string, gatewayBase: string): Spec => ({
  id: `gateway-${channel}`,
  name: channel === "next" ? "IPFS gateway (staging dapp)" : "IPFS gateway (release dapp)",
  section: "services",
  async run(deps) {
    let release: Release;
    try {
      release = await readRelease(deps, siteBase);
    } catch (error) {
      if (!(error instanceof ReleaseError)) throw error;
      return { state: "degraded", detail: `cannot read the release: ${error.message}` };
    }
    if (release.dappCid === null) return { state: "degraded", detail: "cannot read the release: version.json lists no dapp" };
    const short = `${release.dappCid.slice(0, 12)}...`;
    const answer = await get(deps, `${gatewayBase}/ipfs/${release.dappCid}`, { body: false });
    if (answer.status !== 200) return { state: "down", detail: `the gateway answered ${answer.status} for the dapp of the release (${short})` };
    return isSlow(deps, answer)
      ? { state: "degraded", detail: `serves the dapp of the release (${short}), but it took ${seconds(answer.ms)}` }
      : { state: "ok", detail: `serves the dapp of the release (${short})` };
  },
});
