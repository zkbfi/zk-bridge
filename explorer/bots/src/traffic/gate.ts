import type { Address, PublicClient } from "viem";
import { createBeaconProofSource, ensureGateConfirmed, GateEvidenceError, type BeaconProofSource, type GateConfirmation } from "@zk-bridge/shared";

/** The deposit gate of the source chain, as the traffic bot uses it: what to do before a send. */
export interface TrafficGate {
  /** Reads the gate and, when the epoch of the next block needs it, returns the simulated confirmation to send first. */
  ensure(account: Address): Promise<GateConfirmation>;
}

/**
 * A beacon source that refuses every request. It stands in on a chain with no beacon API configured: a gate that does not
 * enforce never asks it, and one that does fails with a message that names the setting.
 */
function missingBeacon(chainId: number): BeaconProofSource {
  const refuse = async (): Promise<never> => {
    throw new GateEvidenceError("beacon-request-failed", `no beacon API for chain ${chainId}: set traffic.gateBeaconUrls.${chainId} or EXPLORER_BEACON_URL_${chainId}`);
  };
  return { header: refuse, stateProof: refuse };
}

/**
 * The gate of one chain, over the shared `ensureGateConfirmed`.
 *
 * @param input.beaconUrl The beacon API that serves the state proofs (the compact multiproof endpoint of Lodestar), or
 * null when none is configured.
 */
export function createTrafficGate(input: {
  readonly client: Pick<PublicClient, "getBlock" | "readContract" | "call" | "estimateGas">;
  readonly gate: Address;
  readonly chainId: number;
  readonly beaconUrl: string | null;
}): TrafficGate {
  const beacon = input.beaconUrl === null ? missingBeacon(input.chainId) : createBeaconProofSource({ url: input.beaconUrl });
  return { ensure: (account) => ensureGateConfirmed({ client: input.client, gate: input.gate, beacon, account }) };
}
