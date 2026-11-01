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

/** The gate on a chain: whether it enforces, and the epoch it confirmed last (`readGateStatus` of `@zkb/data`). */
export const gateCheck = (deps: Deps, chainId: number): Spec => ({
  id: `gate-${chainId}`,
  name: `${labelOf(deps, chainId)} gate`,
  section: "bridges",
  async run(run) {
    const status = await readGateStatus({ client: run.client(chainId), gate: sideOf(run, chainId).contracts.gate });
    if (!status.enforcing) return { state: "degraded", detail: `not enforcing (mode ${status.mode}), it admits every send` };
    if (status.sealed) return { state: "ok", detail: `enforcing and sealed, it asks for no confirmation` };
    if (status.confirmedEpoch === status.epoch) return { state: "ok", detail: `enforcing, epoch ${status.epoch} is confirmed` };
    const last = status.confirmedEpoch === null ? "no epoch confirmed yet" : `last confirmed epoch ${status.confirmedEpoch}`;
    return { state: "ok", detail: `enforcing, ${last}, epoch ${status.epoch} needs a confirmation before the next send` };
  },
});
