import type { Address, PublicClient } from "viem";
import { zeroHash } from "viem";
import { beaconLightClientAbi } from "@zk-bridge/shared";
import type { LightClientFacts, SourceFacts, SourceHistory } from "./plan.ts";

/** How long one beacon request may take, in milliseconds. */
export const BEACON_TIMEOUT_MILLISECONDS = 30_000;

/** The User-Agent that public beacon nodes accept (some refuse the default one of Node.js). */
export const USER_AGENT = "Mozilla/5.0 (compatible; zk-bridge/1.0)";

type ReadClient = Pick<PublicClient, "getBlockNumber" | "readContract">;

/**
 * Reads the facts of a `BeaconLightClient`: head, period length, clock and whether the next committee is stored. All
 * reads name one block, so a load balancer cannot mix two heights.
 */
export async function readLightClient(client: ReadClient, lightClient: Address): Promise<LightClientFacts> {
  const blockNumber = await client.getBlockNumber();
  const read = <Name extends "head" | "slotsPerPeriod" | "genesisTime" | "secondsPerSlot">(functionName: Name) =>
    client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName, blockNumber }) as Promise<bigint | number>;
  const [head, slotsPerPeriod, genesisTime, secondsPerSlot] = await Promise.all([read("head"), read("slotsPerPeriod"), read("genesisTime"), read("secondsPerSlot")]);
  if (BigInt(slotsPerPeriod) === 0n) throw new Error(`${lightClient} reports zero slots per period: it is not a beacon light client`);
  const headPeriod = BigInt(head) / BigInt(slotsPerPeriod);
  const next = await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "syncCommittees", args: [headPeriod + 1n], blockNumber });
  return {
    headSlot: Number(head),
    slotsPerPeriod: Number(slotsPerPeriod),
    genesisTime: Number(genesisTime),
    secondsPerSlot: Number(secondsPerSlot),
    nextCommitteeKnown: next !== zeroHash,
  };
}

/** A GET that answers a status and a parsed JSON body (null when the body is not JSON). */
export type JsonGet = (url: string) => Promise<{ readonly status: number; readonly body: unknown }>;

/** The {@link JsonGet} over the global fetch, with the beacon User-Agent and a timeout (30 s by default). */
export function fetchJsonGet(fetchFunction: typeof fetch = globalThis.fetch, timeoutMilliseconds = BEACON_TIMEOUT_MILLISECONDS): JsonGet {
  return async (url) => {
    const answer = await fetchFunction(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    const body: unknown = await answer.json().catch(() => null);
    return { status: answer.status, body };
  };
}

const base = (beaconUrl: string) => beaconUrl.replace(/\/+$/, "");

const asSlot = (value: unknown, what: string): number => {
  const slot = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(slot)) throw new Error(`the beacon node sent ${what} in an unknown shape`);
  return slot;
};

/** Reads the newest finalized slot from `/eth/v1/beacon/headers/finalized`. */
export async function readSource(get: JsonGet, beaconUrl: string): Promise<SourceFacts> {
  const answer = await get(`${base(beaconUrl)}/eth/v1/beacon/headers/finalized`);
  if (answer.status !== 200) throw new Error(`the beacon node answered ${answer.status} for the finalized header`);
  const slot = (answer.body as { data?: { header?: { message?: { slot?: unknown } } } } | null)?.data?.header?.message?.slot;
  return { finalizedSlot: asSlot(slot, "the finalized header") };
}

/**
 * Asks the source node for the committee handoff updates of `periods` (`/eth/v1/beacon/light_client/updates`), the
 * same route the prover reads. Answers `serves` only when every period came back. A 404 or 501 means the node does not
 * serve the route at all (chain 943): the first period is missing.
 *
 * @throws For any other status, or a body that is not a list of updates.
 */
export async function readHistory(get: JsonGet, beaconUrl: string, periods: readonly number[], slotsPerPeriod: number): Promise<SourceHistory> {
  if (periods.length === 0) return { kind: "not-needed" };
  const { received } = await readUpdates(get, beaconUrl, periods, slotsPerPeriod);
  const missing = periods.find((period) => !received.has(period));
  return missing === undefined ? { kind: "serves" } : { kind: "missing", period: missing };
}

/** The periods of `periods` whose update the node gave, and whether it serves the route at all (not 404 or 501). */
async function readUpdates(get: JsonGet, beaconUrl: string, periods: readonly number[], slotsPerPeriod: number): Promise<{ received: Set<number>; routeServed: boolean }> {
  const received = new Set<number>();
  const last = periods[periods.length - 1] as number;
  // A node gives at most a count of its own choice, so ask again after the highest period received.
  for (let start = periods[0] as number; start <= last; ) {
    const answer = await get(`${base(beaconUrl)}/eth/v1/beacon/light_client/updates?start_period=${start}&count=${last - start + 1}`);
    if (answer.status === 404 || answer.status === 501) return { received, routeServed: received.size > 0 };
    if (answer.status !== 200) throw new Error(`the beacon node answered ${answer.status} for the light-client updates`);
    if (!Array.isArray(answer.body)) throw new Error("the beacon node sent the light-client updates in an unknown shape");
    const before = received.size;
    let highest = start - 1;
    for (const entry of answer.body as Array<{ data?: { attested_header?: { beacon?: { slot?: unknown } } } }>) {
      const period = Math.floor(asSlot(entry?.data?.attested_header?.beacon?.slot, "a light-client update") / slotsPerPeriod);
      received.add(period);
      highest = Math.max(highest, period);
    }
    if (received.size === before) break;
    start = highest + 1;
  }
  return { received, routeServed: true };
}

/** The host of an endpoint, for messages: never the path or a key. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an endpoint";
  }
}

/**
 * One place that may have the committee handoff update of a period. `ask` answers which of `periods` it has and, in a
 * few words, what it answered. It throws when it could not answer (no connection, an unexpected status): that is not a
 * "no", so a period it was asked for is not counted as missing because of it.
 */
export type HandoffSource = {
  /** Such as `beacon.example (light_client/updates)`. A host, never a URL. */
  readonly label: string;
  readonly ask: (periods: readonly number[], slotsPerPeriod: number) => Promise<{ readonly served: readonly number[]; readonly answer: string }>;
};

const listOf = (periods: readonly number[]) => (periods.length === 1 ? `period ${periods[0]}` : `periods ${periods.join(", ")}`);

/**
 * `light_client/updates` of one beacon node. `route` records whether the node serves the route at all, which decides
 * whether its states are worth asking (the prover assembles updates from states only on a chain whose nodes lack the
 * route).
 */
function updatesSource(get: JsonGet, url: string, route: { served: boolean }): HandoffSource {
  return {
    label: `${hostOf(url)} (light_client/updates)`,
    async ask(periods, slotsPerPeriod) {
      try {
        const { received, routeServed } = await readUpdates(get, url, periods, slotsPerPeriod);
        route.served = routeServed;
        const served = periods.filter((period) => received.has(period));
        const missing = periods.filter((period) => !received.has(period));
        if (missing.length === 0) return { served, answer: `has ${listOf(periods)}` };
        return { served, answer: routeServed ? `no update for ${listOf(missing)}` : "does not serve the route (404 or 501)" };
      } catch (error) {
        // A node that cannot answer may still lack the route; its states are asked too.
        route.served = false;
        throw new Error(`${hostOf(url)} (light_client/updates): ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * The states a node holds at the end of each period: the prover assembles the handoff update of a period from the
 * blocks and the state at its end. Asked only when `route` says the beacon node does not serve `light_client/updates`.
 */
function statesSource(get: JsonGet, url: string, route: { served: boolean }): HandoffSource {
  return {
    label: `${hostOf(url)} (states)`,
    async ask(periods, slotsPerPeriod) {
      if (route.served) return { served: [], answer: "not asked: the beacon node serves light_client/updates, so updates are not built from states" };
      const served: number[] = [];
      const missing: string[] = [];
      for (const period of periods) {
        const slot = (period + 1) * slotsPerPeriod - 1;
        const answer = await get(`${base(url)}/eth/v1/beacon/states/${slot}/finality_checkpoints`).catch(() => null);
        if (answer?.status === 200) served.push(period);
        else missing.push(`no state at slot ${slot} (answered ${answer === null ? "nothing" : answer.status})`);
      }
      return { served, answer: missing.length === 0 ? `holds the states of ${listOf(periods)}` : missing.join(", ") };
    },
  };
}

/** One base URL of the handoff archive: `<base>/<chainId>/<period>.json` (docs/proof-archive.md). */
export function archiveSource(get: JsonGet, url: string, chainId: number): HandoffSource {
  return {
    label: `${hostOf(url)} (handoff archive)`,
    async ask(periods) {
      const served: number[] = [];
      const answers: string[] = [];
      for (const period of periods) {
        const answer = await get(`${base(url)}/${chainId}/${period}.json`).catch((error: unknown) => {
          throw new Error(`${hostOf(url)} (handoff archive): ${error instanceof Error ? error.message : String(error)}`);
        });
        const record = answer.body as { format?: unknown; period?: unknown; chainId?: unknown } | null;
        if (answer.status === 200 && record?.format === "zkb-handoff-update/1" && record.period === period && record.chainId === chainId) served.push(period);
        else answers.push(`period ${period}: ${answer.status === 200 ? "not a handoff record of the period" : `answered ${answer.status}`}`);
      }
      return { served, answer: answers.length === 0 ? `has ${listOf(periods)}` : answers.join(", ") };
    },
  };
}

/** The archive of this backend's own table, read without a request. */
export function localArchiveSource(has: (period: number) => boolean): HandoffSource {
  return {
    label: "this backend (handoff archive)",
    async ask(periods) {
      const served = periods.filter(has);
      const missing = periods.filter((period) => !has(period));
      return { served, answer: missing.length === 0 ? `has ${listOf(periods)}` : `no record of ${listOf(missing)}` };
    },
  };
}

/** Every endpoint of one source chain that can give a handoff update, for {@link handoffSources}. */
export type HandoffEndpoints = {
  readonly chainId: number;
  readonly beaconUrl: string;
  /** More beacon APIs for states (`stateUrls`). */
  readonly stateUrls: readonly string[];
  /** More beacon APIs for handoff updates (`handoffUrls`). */
  readonly handoffUrls: readonly string[];
  /** Base URLs of the handoff archive. */
  readonly archiveUrls: readonly string[];
  /** The backend's own archive table, asked before the archive URLs. */
  readonly local?: (period: number) => boolean;
};

/**
 * The sources in the order the prover asks them: the beacon node (`light_client/updates`), the states of the beacon node
 * and of each state URL (only on a chain whose node lacks the route), each handoff URL (its updates, then its states),
 * the backend's own archive, then each archive URL.
 */
export function handoffSources(get: JsonGet, endpoints: HandoffEndpoints): HandoffSource[] {
  const main = { served: true };
  const sources: HandoffSource[] = [updatesSource(get, endpoints.beaconUrl, main), ...[endpoints.beaconUrl, ...endpoints.stateUrls].map((url) => statesSource(get, url, main))];
  for (const url of endpoints.handoffUrls) {
    const route = { served: true };
    sources.push(updatesSource(get, url, route), statesSource(get, url, route));
  }
  if (endpoints.local !== undefined) sources.push(localArchiveSource(endpoints.local));
  sources.push(...endpoints.archiveUrls.map((url) => archiveSource(get, url, endpoints.chainId)));
  return sources;
}

/**
 * Asks every source in order for the periods still missing, and stops once all are found. `missing` only when every
 * source answered and none had the period; its `tried` lists each source and what it answered.
 *
 * @throws When a period stays missing and some source could not answer: that is a failed read, not a stranded light client.
 */
export async function readHistoryFrom(sources: readonly HandoffSource[], periods: readonly number[], slotsPerPeriod: number): Promise<SourceHistory> {
  if (periods.length === 0) return { kind: "not-needed" };
  let remaining = [...periods];
  const tried: string[] = [];
  const failed: string[] = [];
  for (const source of sources) {
    if (remaining.length === 0) break;
    try {
      const { served, answer } = await source.ask(remaining, slotsPerPeriod);
      tried.push(`${source.label}: ${answer}`);
      remaining = remaining.filter((period) => !served.includes(period));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      tried.push(`${source.label}: could not answer`);
      failed.push(text);
    }
  }
  if (remaining.length === 0) return { kind: "serves" };
  if (failed.length > 0) throw new Error(`no source answered for period ${remaining[0]}, and some could not be read: ${failed.join("; ")}`);
  return { kind: "missing", period: remaining[0] as number, tried };
}
