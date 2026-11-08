import { secondsPerSlot } from "@zkb/data";
import type { ProofDirection } from "@zk-bridge/shared";
import { deadlineOf, formatHours } from "../../../backend/src/keepalive/plan.ts";
import { inspect, type Reads, type Target } from "../../../backend/src/keepalive/march.ts";
import { fetchJsonGet, handoffSources, readHistoryFrom, readLightClient, readSource } from "../../../backend/src/keepalive/sources.ts";
import { labelOf, type Deps } from "../deps.ts";
import { duration } from "../format.ts";
import type { CheckSpec } from "../types.ts";

type Spec = CheckSpec<Deps>;

const sideOf = (deps: Deps, chainId: number) => deps.pair.sides.find((side) => side.chainId === chainId) as Deps["pair"]["sides"][number];

/** The execution RPC of a chain: the latest block, and how old it is. */
export const rpcCheck = (deps: Deps, chainId: number): Spec => ({
  id: `rpc-${chainId}`,
  name: `${labelOf(deps, chainId)} RPC`,
  section: "chains",
  async run(deps) {
    const limit = deps.config.chains[String(chainId)]?.maxBlockAgeSeconds as number;
    const block = await deps.client(chainId).getBlock({ blockTag: "latest" });
    const age = deps.now() / 1000 - Number(block.timestamp);
    const where = `block ${block.number}`;
    if (age > limit) return { state: age > limit * 5 ? "down" : "degraded", detail: `${where} is ${duration(age)} old, a block should be under ${duration(limit)} old` };
    return { state: "ok", detail: `${where}, ${duration(age)} old` };
  },
});

/** The beacon node of a chain: the newest finalized slot, and how old it is. */
export const beaconCheck = (deps: Deps, chainId: number): Spec => ({
  id: `beacon-${chainId}`,
  name: `${labelOf(deps, chainId)} beacon node`,
  section: "chains",
  async run(deps) {
    const side = sideOf(deps, chainId);
    const base = (side.beaconUrl as string).replace(/\/+$/, "");
    const get = fetchJsonGet(deps.fetch, deps.requestTimeoutMilliseconds);
    const key = `genesis-${chainId}`;
    let genesis = deps.memory.get(key);
    if (genesis === undefined) {
      const answer = await get(`${base}/eth/v1/beacon/genesis`);
      const time = Number((answer.body as { data?: { genesis_time?: unknown } } | null)?.data?.genesis_time);
      if (answer.status !== 200 || !Number.isSafeInteger(time)) throw new Error(`the beacon node gave no genesis time (answered ${answer.status})`);
      genesis = time;
      deps.memory.set(key, genesis);
    }
    const { finalizedSlot } = await readSource(get, base);
    const age = deps.now() / 1000 - (genesis + finalizedSlot * secondsPerSlot(chainId));
    const limit = deps.config.chains[String(chainId)]?.maxFinalizedAgeSeconds as number;
    const where = `finalized slot ${finalizedSlot}`;
    if (age > limit) return { state: age > limit * 5 ? "down" : "degraded", detail: `${where} is ${duration(age)} old, finality should be under ${duration(limit)} behind` };
    return { state: "ok", detail: `${where}, ${duration(age)} old` };
  },
});

/**
 * The light client that a direction proves into: its head, its age and its deadline, judged by the keep-alive planner
 * of the backend (`explorer/backend/src/keepalive`), which is imported, not copied.
 */
export const lightClientCheck = (deps: Deps, direction: ProofDirection): Spec => {
  const [first, second] = deps.pair.sides;
  const [source, destination] = direction === "first-to-second" ? [first, second] : [second, first];
  const label = labelOf(deps, destination.chainId);
  return {
    id: `lightclient-${direction}`,
    name: `${label} light client`,
    section: "chains",
    async run(run) {
      if (source.beaconUrl === null) throw new Error(`no beacon endpoint for ${labelOf(run, source.chainId)}`);
      const get = fetchJsonGet(run.fetch, run.requestTimeoutMilliseconds);
      const target: Target = { direction, label: `${source.name} -> ${destination.name}`, lightClient: destination.contracts.lightClient, destinationChainId: destination.chainId };
      const reads: Reads = {
        lightClient: (t) => readLightClient(run.client(t.destinationChainId) as Parameters<typeof readLightClient>[0], t.lightClient),
        source: () => readSource(get, source.beaconUrl as string),
        // Every source the prover asks for a missed period: the beacon node, then the handoff archive of the backend and
        // of the indexer. Stranded only when none has it.
        history: (_t, periods, slotsPerPeriod) =>
          readHistoryFrom(
            handoffSources(get, {
              chainId: source.chainId,
              beaconUrl: source.beaconUrl as string,
              stateUrls: [],
              handoffUrls: [],
              archiveUrls: [`${run.config.services.backendLocal.replace(/\/+$/, "")}/archive/handoffs`, `${run.config.services.indexerLocal.replace(/\/+$/, "")}/api/proofs/handoffs`],
            }),
            periods,
            slotsPerPeriod,
          ),
      };
      const { assessment } = await inspect(target, reads, run.config.lightClients, run.now() / 1000);
      const head = `head ${duration(assessment.headAgeSeconds)} old`;
      if (assessment.verdict === "stranded") return { state: "down", detail: `stranded, ${assessment.reason}` };
      if (assessment.secondsUntilDeadline <= 0) {
        return { state: "down", detail: `${head}, the deadline passed ${duration(-assessment.secondsUntilDeadline)} ago and it needs handoff steps: ${assessment.reason}` };
      }
      const detail = `${head}, must update within ${duration(assessment.secondsUntilDeadline)}`;
      return { state: assessment.verdict === "fresh" ? "ok" : "degraded", detail };
    },
  };
};

/**
 * How long until a light client strands, from the chain alone: no beacon node and no backend are asked, so the check
 * still works when either is down. Ok above `deadlineDegradedSeconds`, degraded at or under it, down at or under
 * `deadlineDownSeconds` and once the deadline passed.
 */
export const lightClientDeadlineCheck = (deps: Deps, direction: ProofDirection): Spec => {
  const [first, second] = deps.pair.sides;
  const [source, destination] = direction === "first-to-second" ? [first, second] : [second, first];
  const label = labelOf(deps, destination.chainId);
  return {
    id: `lightclient-deadline-${direction}`,
    name: `${label} light client deadline`,
    section: "chains",
    async run(run) {
      const facts = await readLightClient(run.client(destination.chainId) as Parameters<typeof readLightClient>[0], destination.contracts.lightClient);
      const deadline = deadlineOf(facts, run.now() / 1000);
      const { deadlineDegradedSeconds, deadlineDownSeconds } = run.config.lightClients;
      const where = `head slot ${deadline.headSlot}, period ${deadline.headPeriod}`;
      const prefix = `${label} checks ${labelOf(run, source.chainId)}`;
      if (deadline.secondsLeft <= 0) {
        return { state: "down", detail: `${prefix}: stranded ${formatHours(-deadline.secondsLeft)} ago unless handoff updates move it (${where}, stranded in period ${deadline.strandPeriod})` };
      }
      const state = deadline.secondsLeft <= deadlineDownSeconds ? "down" : deadline.secondsLeft <= deadlineDegradedSeconds ? "degraded" : "ok";
      return { state, detail: `${prefix}: ${formatHours(deadline.secondsLeft)} until stranded (${where}, strands in period ${deadline.strandPeriod})` };
    },
  };
};
