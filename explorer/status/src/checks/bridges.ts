import { parseAbi } from "viem";
import { readGateStatus } from "@zkb/data";
import { decideForkCutover, forkCutoverText, readCutoverFacts, readForkGateState, readForkObservation, type ProofDirection } from "@zk-bridge/shared";
import { labelOf, type Deps } from "../deps.ts";
import type { CheckSpec } from "../types.ts";

type Spec = CheckSpec<Deps>;

const depositsOpenAbi = parseAbi(["function depositsOpen() view returns (bool)"]);

const sideOf = (deps: Deps, chainId: number) => deps.pair.sides.find((side) => side.chainId === chainId) as Deps["pair"]["sides"][number];

/** Whether the bridge on a chain takes deposits (`depositsOpen()`). */
export const bridgeCheck = (deps: Deps, chainId: number): Spec => ({
  id: `bridge-${chainId}`,
  name: `${labelOf(deps, chainId)} bridge`,
  section: "bridges",
  async run(run) {
    const open = await run.client(chainId).readContract({ address: sideOf(run, chainId).contracts.bridge, abi: depositsOpenAbi, functionName: "depositsOpen" });
    return open ? { state: "ok", detail: "deposits are open" } : { state: "degraded", detail: "deposits are closed, sends are refused" };
  },
});

/** The gate on a chain: whether it enforces, and the epoch it confirmed last. A gate in a detection mode admits sends by design until the chain
 * gains beacon roots or a newer opcode; only an enforcing-mode gate that does not enforce is degraded, and a sealed one is down (`readGateStatus` of `@zkb/data`). */
export const gateCheck = (deps: Deps, chainId: number): Spec => ({
  id: `gate-${chainId}`,
  name: `${labelOf(deps, chainId)} gate`,
  section: "bridges",
  async run(run) {
    const status = await readGateStatus({ client: run.client(chainId), gate: sideOf(run, chainId).contracts.gate });
    if (status.sealed) return { state: "down", detail: "sealed after a fork, it refuses every send and the seal never clears" };
    if (!status.enforcing) {
      if (status.mode === "enforcing") return { state: "degraded", detail: "mode enforcing but not enforcing, it admits every send" };
      return { state: "ok", detail: `detection mode (${status.mode}): admits sends until ${labelOf(run, chainId)} gains beacon roots or a newer opcode, then enforces for good` };
    }
    if (status.confirmedEpoch === status.epoch) return { state: "ok", detail: `enforcing, epoch ${status.epoch} is confirmed` };
    const last = status.confirmedEpoch === null ? "no epoch confirmed yet" : `last confirmed epoch ${status.confirmedEpoch}`;
    return { state: "ok", detail: `enforcing, ${last}, epoch ${status.epoch} needs a confirmation before the next send` };
  },
});

/**
 * Sends from one chain before a fork (known-issues 1.5): the shared decision of `@zkb/core` over the source chain's beacon
 * fork schedule and the head of the light client on the destination. Ok while no pause is near, degraded while sends are
 * paused or when the schedule or the head cannot be read. The detail says the next fork with its countdown, the gate (mode,
 * sealed) and what the fork registry last observed.
 */
export const forkCutoverCheck = (deps: Deps, direction: ProofDirection): Spec => {
  const [first, second] = deps.pair.sides;
  const [source, destination] = direction === "first-to-second" ? [first, second] : [second, first];
  const names = { source: labelOf(deps, source.chainId), destination: labelOf(deps, destination.chainId) };
  return {
    id: `fork-cutover-${direction}`,
    name: `${names.source} sends before a fork`,
    section: "bridges",
    async run(run) {
      const facts = await readCutoverFacts({
        sourceChainId: source.chainId,
        routeOf: () => ({ destinationChainId: destination.chainId, lightClient: destination.contracts.lightClient }),
        clientFor: (chainId) => run.client(chainId),
        beaconUrlsFor: () => (source.beaconUrl === null ? [] : [source.beaconUrl]),
        fetch: run.fetch,
      });
      const now = run.now() / 1000;
      const verdict = decideForkCutover({ sourceChainId: source.chainId, ...(facts as NonNullable<typeof facts>), nowSeconds: now });
      const text = forkCutoverText(verdict, names, now);
      const gate = await readForkGateState({ client: run.client(source.chainId), gate: source.contracts.gate });
      const registry = source.contracts.forkRegistry ?? gate.forkRegistry;
      const observed = registry === null ? null : await readForkObservation({ client: run.client(source.chainId), registry });
      const gateText = `gate ${gate.sealed ? "sealed" : "not sealed"}, mode ${gate.mode}`;
      const registryText = observed === null ? "" : `; registry ${observed.observed ? `version ${observed.version}, shape ${observed.shape}, slot ${observed.slot}` : "has observed nothing"}`;
      const state = verdict.kind === "open" ? "ok" : "degraded";
      return { state, detail: `${text.headline ?? `no fork is scheduled on ${names.source}`}${text.countdown === null ? "" : ` (${text.countdown})`} ${gateText}${registryText}` };
    },
  };
};
