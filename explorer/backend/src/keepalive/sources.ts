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
  const first = periods[0];
  if (first === undefined) return { kind: "not-needed" };
  const received = new Set<number>();
  // A node gives at most a count of its own choice, so ask again after the highest period received.
  for (let start = first; start <= (periods[periods.length - 1] as number); ) {
    const count = (periods[periods.length - 1] as number) - start + 1;
    const answer = await get(`${base(beaconUrl)}/eth/v1/beacon/light_client/updates?start_period=${start}&count=${count}`);
    if (answer.status === 404 || answer.status === 501) break;
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
  const missing = periods.find((period) => !received.has(period));
  return missing === undefined ? { kind: "serves" } : { kind: "missing", period: missing };
}
