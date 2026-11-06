import { parseAbi } from "viem";
import { readGateStatus } from "@zkb/data";
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
