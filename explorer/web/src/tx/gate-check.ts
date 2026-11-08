/**
 * The deposit gate check of the web page. On a chain whose `BeaconForkGate` enforces (Sepolia, Ethereum), the first send
 * of an epoch needs `confirm(evidence)` first. The page asks the shared `ensureGateConfirmed` right before a send's
 * estimate, from the sender, on the sticky flow client (so the confirmation's simulation and the send hit one node), with
 * the beacon endpoints of Settings. Nothing here sends a transaction.
 */
import { createBeaconProofSource, ensureGateConfirmed, GateEvidenceError, type BeaconProofSource, type GateChainClient, type GateConfirmation } from "@zk-bridge/shared";
import { getAddress, type Address, type Hex } from "viem";
import type { ChainConfig } from "@terminal/model/types";
import type { PlannedTransaction } from "@terminal/tx/plan";

/** The question the sequence asks before a send on a chain with a gate. */
export type GateCheck = (input: { readonly chainId: number; readonly gate: Address; readonly account: Address }) => Promise<GateConfirmation>;

/**
 * A beacon source over several endpoints, tried in order. A request that one endpoint fails goes to the next. When every
 * endpoint fails, the error says how many were tried and the last reason. Messages hold no URL.
 *
 * @param sources The endpoints' sources, in order.
 */
export const fallbackBeaconSource = (sources: readonly BeaconProofSource[]): BeaconProofSource => {
  const first = async <T>(ask: (source: BeaconProofSource) => Promise<T>): Promise<T> => {
    if (sources.length === 0) throw new GateEvidenceError("beacon-request-failed", "no beacon endpoint is set for this chain (Settings, Beacon endpoints)");
    let last: unknown = null;
    for (const source of sources) {
      try {
        return await ask(source);
      } catch (error) {
        last = error;
      }
    }
    const reason = last instanceof Error ? last.message : String(last);
    throw new GateEvidenceError("beacon-request-failed", `no beacon endpoint answered (${sources.length} tried; last: ${reason})`);
  };
  return {
    header: (blockRoot) => first((source) => source.header(blockRoot)),
    stateProof: (stateId, descriptor) => first((source) => source.stateProof(stateId, descriptor)),
  };
};

/**
 * The gate check of a live page.
 *
 * @param input.clientFor The flow client of a chain. It must read contracts, read blocks, call and estimate gas.
 * @param input.beaconUrlsFor The beacon endpoints of a chain in force now, in order. Read at each check, so a change in
 * Settings counts at once.
 * @param input.fetch The `fetch` to use. Default: the global one.
 */
export const createGateCheck = (input: {
  readonly clientFor: (chainId: number) => GateChainClient;
  readonly beaconUrlsFor: (chainId: number) => readonly string[];
  readonly fetch?: typeof fetch;
}): GateCheck =>
  ({ chainId, gate, account }) => {
    const beacon = fallbackBeaconSource(input.beaconUrlsFor(chainId).map((url) => createBeaconProofSource({ url, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) })));
    return ensureGateConfirmed({ client: input.clientFor(chainId), gate, beacon, account });
  };

/** The functions that send a bridge message, and so pass the deposit gate of their chain. */
export const GATED_FUNCTIONS: readonly string[] = ["relayTokens", "relayTokensAndCall", "wrapAndRelayTokens", "requireToPassMessage"];

/** Whether a planned transaction passes the deposit gate of its chain. */
export const passesGate = (plan: PlannedTransaction): boolean => plan.chain.contracts.gate !== null && GATED_FUNCTIONS.includes(plan.functionName);

const utcTime = (unixSeconds: bigint): string => new Date(Number(unixSeconds) * 1000).toISOString().slice(11, 19);

/**
 * The planned transaction of a confirmation, for the review: `confirm(evidence)` on the gate, no value.
 *
 * @param chain The chain of the gate.
 * @param confirmation The answer of the gate check.
 */
export const planGateConfirm = (chain: ChainConfig, confirmation: Extract<GateConfirmation, { kind: "confirm" }>): PlannedTransaction => {
  const evidence = confirmation.evidence.encoded;
  const data: Hex = confirmation.call.data;
  return {
    title: `Confirm this epoch on the gate (epoch ${confirmation.epoch})`,
    chain,
    to: getAddress(confirmation.call.to),
    contractLabel: `${chain.name} deposit gate (BeaconForkGate)`,
    functionSignature: "confirm(bytes)",
    functionName: "confirm",
    data,
    value: 0n,
    arguments: [{ name: "evidence", type: "bytes", value: evidence }],
    notes: [
      `The ${chain.name} deposit gate admits sends in epoch ${confirmation.epoch} once one transaction confirms it. This transaction confirms it. Your send follows as the next step.`,
      `The evidence proves fork version ${confirmation.forkVersion} with the beacon header of slot ${confirmation.evidence.header.slot}. The gate checks it against the beacon root on chain.`,
      `It must be mined before ${utcTime(confirmation.validUntil)} UTC, the end of epoch ${confirmation.epoch}. It sends no ${chain.nativeSymbol}.`,
    ],
  };
};

/**
 * A sentence for an error of the gate check.
 *
 * @param error What the check threw.
 * @param chainName The chain of the gate.
 */
export const gateErrorText = (error: unknown, chainName: string): string => {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof GateEvidenceError && error.code === "beacon-request-failed") {
    return `Could not confirm the ${chainName} deposit gate: ${reason}. Check Settings, Beacon endpoints, then try again.`;
  }
  return `Could not confirm the ${chainName} deposit gate: ${reason}.`;
};
